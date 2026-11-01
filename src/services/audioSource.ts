import type { AudioQuality, Track } from "@shared/types/player";
import { isPlatform as isOnlinePlatform } from "@shared/types/platform";
import { getQualityLevel, type QualityLevel } from "@/utils/quality";
import { streamingSourceForTrack } from "@shared/utils/streamingSource";
import { useSettingsStore } from "@/stores/settings";
import { usePluginsStore } from "@/stores/plugins";
import { useUserStore } from "@/stores/user";
import {
  resolveByPlugin as resolvePluginSource,
  resolvePlaybackOnline,
  type OnlineResolveResult,
  type OnlineSourceHost,
} from "./onlineSource";
import { ErrorCode } from "@shared/types/errors";
import { handleError } from "@/utils/errors";

/** 解析选项 */
export interface ResolveTrackSourceOptions {
  /** 本次换源尝试的音质，省略时使用播放设置 */
  quality?: QualityLevel;
  /** 已下载文件加载失败时跳过，继续解析缓存或在线音源 */
  skipDownloaded?: boolean;
  /** 后台已确认需要在线选源时不重复读取缓存 */
  skipCache?: boolean;
  /** 取消后台解析，停止后续插件请求 */
  signal?: AbortSignal;
  /** 将解析失败原因交给播放流程，供提示和跳曲决策使用 */
  onError?: (error: string) => void;
  /** 要跳过的插件 ID 列表 */
  skipPluginIds?: readonly string[];
  /** 是否跳过官方在线接口，直接进入插件兜底 */
  skipOfficialOnline?: boolean;
  /** 是否静默解析 */
  silent?: boolean;
}

/**
 * 派生缓存键
 * netease / qqmusic 把音质档位并入键，使不同音质的同一首歌互不覆盖
 * @param track - 要解析的 track
 * @param songLevel - 在线歌曲音质档位
 * @returns 派生缓存键，如果该 track 不参与歌曲缓存则返回 null
 */
const cacheKeyForTrack = (track: Track, songLevel: QualityLevel): string | null => {
  if (track.source === "streaming" && track.serverId && track.originalId) {
    return `s:${track.serverId}:${track.originalId}:${track.serverRevision ? `r${track.serverRevision}` : ""}`;
  }
  if (track.source === "kugou" && track.id) {
    return `o:kugou:${track.id}:${track.extId ?? ""}:${songLevel}`;
  }
  if (isOnlinePlatform(track.source) && track.id) {
    // 旧 QQ 缓存未区分试听，升级身份后重新解析，避免片段继续冒充完整文件
    const source = track.source === "qqmusic" ? "qqmusic:v2" : track.source;
    return `o:${source}:${track.id}:${songLevel}`;
  }
  return null;
};

/** 前台直接读取现有响应式状态，后台使用同一解析流程的原生依赖 */
const onlineHost: OnlineSourceHost = {
  getSettings: () => useSettingsStore().player,
  getPlugins: () => usePluginsStore(),
  getNeteaseSession: () => {
    const user = useUserStore();
    return { authenticated: user.isLoggedIn, validate: () => user.fetchStatus() };
  },
  resolvePlugin: (args) => window.api.plugins.resolveUrl(args),
};

export type { OnlineResolveResult } from "./onlineSource";

/**
 * 使用现有前台状态解析插件音源
 * @param track - 待播放曲目
 * @param quality - 音质档位
 * @param skipPluginIds - 已失败的插件
 * @param signal - 取消信号
 * @returns 音源结果
 */
export const resolveByPlugin = (
  track: Track,
  quality: QualityLevel = "hq",
  skipPluginIds: readonly string[] = [],
  signal?: AbortSignal,
): Promise<OnlineResolveResult> =>
  resolvePluginSource(onlineHost, track, quality, skipPluginIds, signal);

/**
 * 解析结果
 * - fromCache 为 true 时表示音源直接命中本地缓存
 * - cacheRequest 存在时表示尚未缓存，调用方应在合适时机（如播放达到阈值后）触发它
 */
export interface ResolvedTrackSource {
  source: string;
  fromCache: boolean;
  provider: "local" | "download" | "cache" | "streaming" | "official" | "plugin" | "trial";
  pluginId?: string;
  /** 后台已完成候选比较时记录真实音质，切歌时复用选择结果 */
  verifiedQuality?: AudioQuality;
  /**
   * 下载音源并返回可供原生预载使用的缓存路径
   * @param preloadId - 可选的预载消费者标识，用于缓存租约和独立取消
   * @param signal - 在解析下载地址期间取消任务的信号
   * @param quality - 校验后的实际音质，避免降级文件占用高音质缓存键
   * @param progressive - 是否允许提前返回渐进缓存入口
   * @returns 可读缓存入口或完整文件路径，取消或失败时为空
   */
  cacheRequest?: (
    preloadId?: string,
    signal?: AbortSignal,
    quality?: QualityLevel,
    progressive?: boolean,
  ) => Promise<string | null>;
}

/**
 * 记录解析错误，支持静默模式抑制
 * @param err - 错误信息或错误码
 * @param options - 提示方式和错误接收回调
 */
const reportLoadError = (err: ErrorCode | string, options: ResolveTrackSourceOptions): void => {
  options.onError?.(err);
  if (!options.silent) handleError(err);
};

/**
 * 解析歌曲的可播放音源及缓存下载入口
 * @param track - 要解析的歌曲
 * @param options - 错误提示、流媒体会话及在线来源重试选项
 * @returns 本地路径或远端地址及缓存入口，无法解析时返回 null
 */
export const resolveTrackSource = async (
  track: Track,
  options: ResolveTrackSourceOptions = {},
): Promise<ResolvedTrackSource | null> => {
  // 本地文件
  if (track.source === "local") {
    const localPath = track.cueAudioPath ?? track.path;
    if (!localPath) reportLoadError(ErrorCode.FILE_NOT_FOUND, options);
    return localPath ? { source: localPath, fromCache: false, provider: "local" } : null;
  }
  const settings = useSettingsStore();
  const songLevel = options.quality ?? settings.player.songLevel;
  if (track.source === "plugin") {
    const resolved = await resolveByPlugin(track, songLevel, options.skipPluginIds, options.signal);
    if (!resolved.ok) {
      reportLoadError(resolved.errorCode, options);
      return null;
    }
    return {
      source: resolved.url,
      fromCache: false,
      provider: "plugin",
      pluginId: resolved.pluginId,
    };
  }
  if (!options.skipDownloaded) {
    try {
      const downloaded = await window.api.download.lookup({
        source: track.source,
        id: track.id,
        ...(track.source === "streaming"
          ? {
              serverId: track.serverId,
              originalId: track.originalId,
              serverRevision: track.serverRevision,
            }
          : {}),
      });
      if (downloaded) return { source: downloaded, fromCache: false, provider: "download" };
    } catch (err) {
      console.warn("[audio-source] download lookup failed:", err);
    }
  }
  const cacheKey = cacheKeyForTrack(track, songLevel);
  const cacheEnabled = settings.system.cache?.songCache?.enabled === true && cacheKey !== null;
  if (cacheEnabled && !options.skipCache) {
    const cached = await window.api.cache.song.lookup(cacheKey!);
    if (cached) return { source: cached, fromCache: true, provider: "cache" };
  }
  // 流媒体
  if (track.source === "streaming") {
    try {
      const source = streamingSourceForTrack(track);
      const result: ResolvedTrackSource = {
        source,
        fromCache: false,
        provider: "streaming",
      };
      if (cacheEnabled && settings.system.cache.songCache.cacheStreaming) {
        // 缓存下载用独立 PlaySessionId
        result.cacheRequest = async (preloadId, signal) => {
          try {
            if (signal?.aborted) return null;
            return await window.api.cache.song.fetch(cacheKey, "streaming", source, preloadId);
          } catch (err) {
            console.warn("[cache] 流媒体缓存失败", err);
            return null;
          }
        };
      }
      return result;
    } catch (err) {
      reportLoadError(err instanceof Error ? err.message : String(err), options);
      return null;
    }
  }
  // 在线源（netease / qqmusic / kugou）
  if (isOnlinePlatform(track.source)) {
    try {
      const resolved = await resolvePlaybackOnline(
        onlineHost,
        track,
        songLevel,
        (url) => window.api.player.probeSource(url),
        options,
      );
      if (!resolved.ok) {
        reportLoadError(resolved.errorCode, options);
        return null;
      }
      const url = resolved.url;
      const result: ResolvedTrackSource = {
        source: url,
        fromCache: false,
        provider: resolved.provider,
        pluginId: resolved.pluginId,
        verifiedQuality: resolved.verifiedQuality,
      };
      if (cacheEnabled && !resolved.isTrial) {
        result.cacheRequest = async (preloadId, signal, quality, progressive) => {
          if (signal?.aborted) return null;
          return window.api.cache.song.fetch(
            cacheKeyForTrack(
              track,
              quality ??
                (resolved.verifiedQuality ? getQualityLevel(resolved.verifiedQuality) : songLevel),
            )!,
            track.source,
            url,
            preloadId,
            progressive,
          );
        };
      }
      return result;
    } catch (err) {
      reportLoadError(err instanceof Error ? err.message : String(err), options);
      return null;
    }
  }
  return null;
};
