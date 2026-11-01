import type { AudioQuality, AudioSourceProbe, IpcResponse, Track } from "@shared/types/player";
import type { AudioSourcePreferences } from "@shared/types/audioSource";
import { isPlatform as isOnlinePlatform, type Platform } from "@shared/types/platform";
import type { PluginInfo, PluginsApi } from "@shared/types/plugin";
import type { QualityLevel } from "@/utils/quality";
import { resolveNeteaseUrl, type NeteaseSessionRecovery } from "@/apis/song/netease";
import { resolveQQMusicUrl } from "@/apis/song/qqmusic";
import { resolveKugouUrl } from "@/apis/song/kugou";
import { ErrorCode } from "@shared/types/errors";
import { matchesAudioSource, selectAudioSource } from "./audioSourceSelection";

export interface OnlineSourceHost {
  getSettings: () => AudioSourcePreferences;
  getPlugins: () => { list: PluginInfo[]; orderedList: PluginInfo[] };
  getNeteaseSession: () => NeteaseSessionRecovery;
  resolvePlugin: PluginsApi["resolveUrl"];
}

export interface OnlineSourceOptions {
  signal?: AbortSignal;
  skipPluginIds?: readonly string[];
  skipOfficialOnline?: boolean;
}

/** 在线平台对应的既有插件来源标识 */
const PLATFORM_TO_PLUGIN_SOURCE: Record<Platform, string> = {
  netease: "wy",
  qqmusic: "tx",
  kugou: "kg",
};

/** 在线 URL 解析结果 */
export type OnlineResolveResult =
  | {
      ok: true;
      url: string;
      isTrial: boolean;
      provider: "official" | "plugin" | "trial";
      pluginId?: string;
      verifiedQuality?: AudioQuality;
    }
  | { ok: false; errorCode: ErrorCode };

/**
 * 按既有排序筛选支持当前歌曲来源的可用插件
 * @param track - 待播放曲目
 * @param plugins - 已排序的插件列表
 * @returns 当前来源可用的候选，独立歌曲只返回所属插件
 */
export const getSourcePlugins = (track: Track, plugins: readonly PluginInfo[]): PluginInfo[] => {
  const source =
    track.source === "plugin"
      ? track.plugin?.source
      : isOnlinePlatform(track.source)
        ? PLATFORM_TO_PLUGIN_SOURCE[track.source]
        : undefined;
  return plugins.filter(
    (info) =>
      Boolean(source) &&
      info.enabled &&
      info.status.state === "ready" &&
      info.status.sources[source!]?.actions.includes("musicUrl") &&
      (track.source !== "plugin" || info.manifest.id === track.plugin?.pluginId),
  );
};

/**
 * 通过插件解析曲目音频地址，独立来源直接调用所属插件
 * @param host - 平台提供的账号、插件和设置
 * @param track - 待播放曲目
 * @param quality - 请求的音质档位，默认 hq
 * @param skipPluginIds - 本轮音源恢复中已失败的插件标识
 * @param signal - 取消信号，停止后续插件尝试
 * @returns 音频地址或解析失败原因
 */
export const resolveByPlugin = async (
  host: OnlineSourceHost,
  track: Track,
  quality: QualityLevel = "hq",
  skipPluginIds: readonly string[] = [],
  signal?: AbortSignal,
): Promise<OnlineResolveResult> => {
  const fail = (errorCode: ErrorCode): OnlineResolveResult => ({ ok: false, errorCode });
  if (signal?.aborted) return fail(ErrorCode.URL_RESOLVE_FAILED);
  const plugins = host.getPlugins();
  if (track.source === "plugin") {
    const origin = track.plugin;
    if (!origin || skipPluginIds.includes(origin.pluginId)) {
      return fail(ErrorCode.NO_PLUGIN_AVAILABLE);
    }
    const plugin = plugins.list.find((info) => info.manifest.id === origin.pluginId);
    if (
      !plugin?.enabled ||
      plugin.status.state !== "ready" ||
      !plugin.status.sources[origin.source]?.actions.includes("musicUrl")
    ) {
      return fail(ErrorCode.NO_PLUGIN_AVAILABLE);
    }
    try {
      const res = await host.resolvePlugin({
        pluginId: origin.pluginId,
        source: origin.source,
        quality,
        musicInfo: { ...origin.musicInfo, songmid: origin.musicInfo.id },
      });
      const current = plugins.list.find((info) => info.manifest.id === origin.pluginId);
      if (
        signal?.aborted ||
        !current?.enabled ||
        current.status.state !== "ready" ||
        !current.status.sources[origin.source]?.actions.includes("musicUrl")
      ) {
        return fail(ErrorCode.NO_PLUGIN_AVAILABLE);
      }
      return res?.url
        ? { ok: true, url: res.url, isTrial: false, provider: "plugin", pluginId: origin.pluginId }
        : fail(ErrorCode.URL_RESOLVE_FAILED);
    } catch (err) {
      console.warn("[plugin] resolveUrl failed", origin.pluginId, err);
      return fail(ErrorCode.URL_RESOLVE_FAILED);
    }
  }
  if (!isOnlinePlatform(track.source)) return fail(ErrorCode.URL_RESOLVE_FAILED);
  const pluginSource = PLATFORM_TO_PLUGIN_SOURCE[track.source];
  if (!pluginSource) return fail(ErrorCode.URL_RESOLVE_FAILED);
  const skip = new Set(skipPluginIds);
  const candidates = getSourcePlugins(track, plugins.orderedList).filter(
    (info) => !skip.has(info.manifest.id),
  );
  if (candidates.length === 0) return fail(ErrorCode.NO_PLUGIN_AVAILABLE);
  // 补齐平台字段，QQ 的媒体文件标识不能用歌曲 ID 替代
  const totalSec = track.duration > 0 ? Math.round(track.duration / 1000) : 0;
  const interval =
    totalSec > 0
      ? `${Math.floor(totalSec / 60)
          .toString()
          .padStart(2, "0")}:${(totalSec % 60).toString().padStart(2, "0")}`
      : null;
  const singer = track.artists.map((artist) => artist.name).join("/");
  const songId = track.id;
  const isHash =
    typeof songId === "string" && songId.length === 32 && /^[0-9a-fA-F]{32}$/.test(songId);
  const hash = isHash || track.source === "kugou" ? songId : undefined;
  const musicInfo = {
    id: songId,
    songmid: songId,
    songId,
    ...(track.source === "qqmusic" && track.mediaId
      ? { strMediaMid: track.mediaId, mediaMid: track.mediaId, media_mid: track.mediaId }
      : {}),
    name: track.title,
    singer,
    source: pluginSource,
    interval,
    img: track.cover ?? null,
    ...(hash ? { hash } : {}),
    albumId: track.album?.id ?? "",
    albumName: track.album?.name ?? "",
    meta: {
      songId,
      albumName: track.album?.name ?? "",
      albumId: track.album?.id ?? "",
      picUrl: track.cover ?? null,
      ...(hash ? { hash } : {}),
    },
  };
  for (const plugin of candidates) {
    if (signal?.aborted) return fail(ErrorCode.URL_RESOLVE_FAILED);
    try {
      const res = await host.resolvePlugin({
        pluginId: plugin.manifest.id,
        source: pluginSource,
        quality,
        musicInfo,
      });
      if (res?.url && !signal?.aborted) {
        return {
          ok: true,
          url: res.url,
          isTrial: false,
          provider: "plugin",
          pluginId: plugin.manifest.id,
        };
      }
    } catch (err) {
      console.warn("[plugin] resolveUrl failed", plugin.manifest.id, err);
    }
  }
  return fail(ErrorCode.URL_RESOLVE_FAILED);
};

/**
 * 按音源偏好解析在线播放地址，失败时尝试另一种音源
 * @param host - 平台提供的账号、插件和设置
 * @param track - 要解析的 track
 * @param songLevel - 在线歌曲音质档位
 * @param options - 本轮恢复中需要跳过的内置接口和插件
 * @returns 音频地址及来源，或解析失败原因
 */
export const resolveOnlineUrl = async (
  host: OnlineSourceHost,
  track: Track,
  songLevel: QualityLevel,
  options: OnlineSourceOptions = {},
): Promise<OnlineResolveResult> => {
  const settings = host.getSettings();
  let pluginResolved: OnlineResolveResult | undefined;
  if (settings.preferPluginSource) {
    pluginResolved = await resolveByPlugin(
      host,
      track,
      songLevel,
      options.skipPluginIds ?? [],
      options.signal,
    );
    if (pluginResolved.ok) return pluginResolved;
  }
  let trialUrl: string | null = null;
  let officialErrorCode: ErrorCode | null = null;
  if (track.source === "netease" && !options.skipOfficialOnline) {
    try {
      const resolved = await resolveNeteaseUrl(track, songLevel, host.getNeteaseSession());
      if (!resolved.available) {
        officialErrorCode = resolved.errorCode;
      } else if (!resolved.isTrial) {
        return { ok: true, url: resolved.url, isTrial: false, provider: "official" };
      } else {
        trialUrl = resolved.url;
      }
    } catch (err) {
      console.warn("[audio-source] official URL resolve failed:", err);
      officialErrorCode = ErrorCode.NETWORK_ERROR;
    }
  }
  if (track.source === "qqmusic" && !options.skipOfficialOnline) {
    try {
      const resolved = await resolveQQMusicUrl(track, songLevel);
      if (!resolved.available) {
        officialErrorCode = resolved.errorCode;
      } else if (!resolved.isTrial) {
        return { ok: true, url: resolved.url, isTrial: false, provider: "official" };
      } else {
        trialUrl = resolved.url;
      }
    } catch (err) {
      console.warn("[audio-source] official QQMusic URL resolve failed:", err);
      officialErrorCode = ErrorCode.NETWORK_ERROR;
    }
  }
  if (track.source === "kugou" && !options.skipOfficialOnline) {
    try {
      const resolved = await resolveKugouUrl(track, songLevel);
      if (resolved.available) {
        return { ok: true, url: resolved.url, isTrial: false, provider: "official" };
      }
      officialErrorCode = resolved.errorCode;
    } catch (err) {
      console.warn("[audio-source] official Kugou URL resolve failed:", err);
      officialErrorCode = ErrorCode.NETWORK_ERROR;
    }
  }
  pluginResolved ??= await resolveByPlugin(
    host,
    track,
    songLevel,
    options.skipPluginIds ?? [],
    options.signal,
  );
  if (pluginResolved.ok) return pluginResolved;
  if (trialUrl && settings.allowTrialPlay) {
    return { ok: true, url: trialUrl, isTrial: true, provider: "trial" };
  }
  if (trialUrl) return { ok: false, errorCode: ErrorCode.NETEASE_TRIAL_DISABLED };
  if (officialErrorCode) return { ok: false, errorCode: officialErrorCode };
  return pluginResolved;
};

/**
 * 插件优先时共用并发择优与降级复用，其余偏好保留原有解析顺序
 * @param host - 账号、插件列表与设置
 * @param track - 待解析曲目
 * @param quality - 请求音质
 * @param probe - 平台提供的真实音质探测
 * @param options - 本轮跳过的失败来源及取消信号
 * @returns 选中的地址和已验证音质，或解析失败原因
 */
export const resolvePlaybackOnline = async (
  host: OnlineSourceHost,
  track: Track,
  quality: QualityLevel,
  probe: (url: string) => Promise<IpcResponse<AudioSourceProbe>>,
  options: OnlineSourceOptions = {},
): Promise<OnlineResolveResult> => {
  const settings = host.getSettings();
  if (track.source === "plugin" || !settings.preferPluginSource) {
    const skipped = new Set(options.skipPluginIds);
    while (!options.signal?.aborted) {
      const result = await resolveOnlineUrl(host, track, quality, {
        ...options,
        skipPluginIds: [...skipped],
      });
      if (
        !result.ok ||
        result.provider !== "plugin" ||
        (!settings.verifySourceArtist && !settings.verifySourceDuration)
      )
        return result;
      const info = await probe(result.url).catch(() => null);
      if (options.signal?.aborted) break;
      if (
        info?.success &&
        info.data &&
        matchesAudioSource(
          track,
          info.data,
          settings.verifySourceArtist,
          settings.verifySourceDuration,
        )
      )
        return { ...result, verifiedQuality: info.data };
      if (!result.pluginId || skipped.has(result.pluginId)) break;
      skipped.add(result.pluginId);
    }
    return { ok: false, errorCode: ErrorCode.URL_RESOLVE_FAILED };
  }
  const pluginIds = getSourcePlugins(track, host.getPlugins().orderedList)
    .map((plugin) => plugin.manifest.id)
    .filter((id) => !options.skipPluginIds?.includes(id));
  let errorCode = ErrorCode.URL_RESOLVE_FAILED;
  let trial: OnlineResolveResult | undefined;
  const selected = await selectAudioSource(
    quality,
    async (attempt) => {
      const result = await resolveOnlineUrl(host, track, attempt.quality, {
        ...attempt,
        skipPluginIds: [...attempt.skipPluginIds, ...(options.skipPluginIds ?? [])],
        skipOfficialOnline: attempt.skipOfficialOnline || options.skipOfficialOnline,
      });
      if (result.ok) {
        if (!result.isTrial) return result;
        trial ??= result;
        return null;
      }
      errorCode = result.errorCode;
      return null;
    },
    {
      pluginIds,
      probe,
      track,
      signal: options.signal,
      verifyArtist: settings.verifySourceArtist,
      verifyDuration: settings.verifySourceDuration,
    },
  );
  return selected
    ? { ...selected.source, verifiedQuality: selected.quality }
    : options.signal?.aborted
      ? { ok: false, errorCode: ErrorCode.URL_RESOLVE_FAILED }
      : (trial ?? { ok: false, errorCode });
};
