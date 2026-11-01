import type { AudioQuality, Track } from "@shared/types/player";
import type { QualityLevel } from "@/utils/quality";
import {
  matchesAudioSource,
  selectAudioSource,
  type SourceSelectionAttempt,
} from "@/services/audioSourceSelection";
import { isPlatform } from "@shared/types/platform";
import { streamingSourceForTrack } from "@shared/utils/streamingSource";
import { resolveByPlugin } from "@/services/audioSource";
import { resolveNeteaseDownloadUrl } from "@/apis/song/netease";
import { resolveQQMusicUrl } from "@/apis/song/qqmusic";
import { resolveKugouUrl } from "@/apis/song/kugou";
import { useSettingsStore } from "@/stores/settings";
import { usePluginsStore } from "@/stores/plugins";
import { getSourcePlugins } from "@/services/onlineSource";

/** 下载源解析结果 */
export interface DownloadSource {
  url: string;
  /** 已知格式（flac/mp3 等），用于扩展名 */
  format?: string;
  /** 已知体积（字节） */
  size?: number;
  /** 探测到的原始音质 */
  quality?: AudioQuality;
  /** 插件候选保留来源标识，用于维持插件优先 */
  pluginId?: string;
}

/**
 * 按下载音质解析歌曲下载地址
 * @param track - 要下载的歌曲
 * @param level - 下载音质档位
 * @param usePlaybackForDownload - 是否允许使用播放源下载
 * @param signal - 下载取消信号，停止后续插件尝试
 * @returns 下载源；无法下载（VIP/试听/无插件/流媒体失败）返回 null
 */
export const resolveDownloadSource = async (
  track: Track,
  level: QualityLevel,
  usePlaybackForDownload: boolean,
  signal?: AbortSignal,
): Promise<DownloadSource | null> => {
  // 流媒体
  if (track.source === "streaming") {
    try {
      return { url: streamingSourceForTrack(track) };
    } catch {
      return null;
    }
  }
  if (!isPlatform(track.source) && track.source !== "plugin") return null;
  const settings = useSettingsStore().player;
  const preferPlugin = settings.preferPluginSource;
  /**
   * 按优先级解析本档下一个下载候选
   * @param attempt - 已尝试来源和当前音质
   * @returns 下载地址，当前档位耗尽时为空
   */
  const resolveNext = async (attempt: SourceSelectionAttempt): Promise<DownloadSource | null> => {
    if (signal?.aborted) return null;
    if (preferPlugin || attempt.skipOfficialOnline || track.source === "plugin") {
      const resolved = await resolveByPlugin(track, attempt.quality, attempt.skipPluginIds, signal);
      if (signal?.aborted) return null;
      if (resolved.ok && !resolved.isTrial)
        return { url: resolved.url, pluginId: resolved.pluginId };
    }
    if (!attempt.skipOfficialOnline) {
      try {
        if (track.source === "netease") {
          const source = await resolveNeteaseDownloadUrl(
            track,
            attempt.quality,
            usePlaybackForDownload,
          );
          if (source) return source;
        } else if (track.source === "qqmusic" || track.source === "kugou") {
          const resolved = await (track.source === "qqmusic"
            ? resolveQQMusicUrl(track, attempt.quality)
            : resolveKugouUrl(track, attempt.quality));
          if (resolved.available && !resolved.isTrial) return { url: resolved.url };
        }
      } catch {
        // 官方下载接口失败后，继续本档插件或降级流程
      }
    }
    if (!preferPlugin && !attempt.skipOfficialOnline && track.source !== "plugin") {
      const resolved = await resolveByPlugin(track, attempt.quality, attempt.skipPluginIds, signal);
      if (resolved.ok && !resolved.isTrial && !signal?.aborted)
        return { url: resolved.url, pluginId: resolved.pluginId };
    }
    return null;
  };
  if (!preferPlugin) {
    const skipped: string[] = [];
    while (!signal?.aborted) {
      const source = await resolveNext({
        quality: level,
        skipPluginIds: skipped,
        skipOfficialOnline: skipped.length > 0,
        signal,
      });
      if (!source?.pluginId || (!settings.verifySourceArtist && !settings.verifySourceDuration))
        return source;
      const info = await window.api.player.probeSource(source.url).catch(() => null);
      if (signal?.aborted) break;
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
        return { ...source, quality: info.data, format: info.data.codec };
      if (skipped.includes(source.pluginId)) break;
      skipped.push(source.pluginId);
    }
    return null;
  }
  const selected = await selectAudioSource(level, resolveNext, {
    track,
    verifyArtist: settings.verifySourceArtist,
    verifyDuration: settings.verifySourceDuration,
    pluginIds: getSourcePlugins(track, usePluginsStore().orderedList).map(
      (plugin) => plugin.manifest.id,
    ),
    probe: (url) => window.api.player.probeSource(url),
    signal,
  });
  return selected
    ? { ...selected.source, quality: selected.quality, format: selected.quality.codec }
    : null;
};
