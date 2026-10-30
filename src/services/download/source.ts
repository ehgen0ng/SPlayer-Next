import type { AudioQuality, Track } from "@shared/types/player";
import {
  compareAudioQuality,
  getQualityLevel,
  QUALITY_ORDER,
  type QualityLevel,
} from "@/utils/quality";
import { isPlatform } from "@shared/types/platform";
import { streamingSourceForTrack } from "@shared/utils/streamingSource";
import { resolveByPlugin } from "@/services/audioSource";
import { resolveNeteaseDownloadUrl } from "@/apis/song/netease";
import { resolveQQMusicUrl } from "@/apis/song/qqmusic";
import { resolveKugouUrl } from "@/apis/song/kugou";
import { useSettingsStore } from "@/stores/settings";

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
  const preferPlugin = useSettingsStore().player.preferPluginSource;
  const requestedRank = QUALITY_ORDER.indexOf(level);
  let fallback: { source: DownloadSource; rank: number; quality: AudioQuality } | undefined;
  for (let rank = requestedRank; rank >= 0; rank--) {
    const quality = QUALITY_ORDER[rank];
    const skippedPlugins = new Set<string>();
    let officialTried = track.source === "plugin";
    let hasQualifiedPlugin = false;
    while (!signal?.aborted) {
      let source: DownloadSource | null = null;
      if (preferPlugin || officialTried) {
        const resolved = await resolveByPlugin(
          track,
          quality,
          [...skippedPlugins],
          (id) => skippedPlugins.add(id),
          signal,
        );
        if (resolved.ok && !resolved.isTrial)
          source = { url: resolved.url, pluginId: resolved.pluginId };
      }
      if (signal?.aborted) return null;
      if (!source && !officialTried) {
        if (hasQualifiedPlugin) break;
        officialTried = true;
        try {
          if (track.source === "netease") {
            source = await resolveNeteaseDownloadUrl(track, quality, usePlaybackForDownload);
          } else if (track.source === "qqmusic" || track.source === "kugou") {
            const resolved = await (track.source === "qqmusic"
              ? resolveQQMusicUrl(track, quality)
              : resolveKugouUrl(track, quality));
            if (resolved.available) source = { url: resolved.url };
          }
        } catch {
          // 单个官方接口失败后继续本档的插件或降级流程
        }
        if (!source && !preferPlugin) continue;
      }
      if (!source) break;
      if (signal?.aborted) return null;
      // 与播放一致：开启插件优先时，以真实文件参数校验请求档位
      if (!preferPlugin) return source;
      try {
        const probed = await window.api.player.probeSource(source.url);
        if (signal?.aborted) return null;
        if (!probed.success || !probed.data) continue;
        source = { ...source, quality: probed.data, format: probed.data.codec };
        const actualRank = QUALITY_ORDER.indexOf(getQualityLevel(probed.data));
        if (source.pluginId && actualRank >= rank) hasQualifiedPlugin = true;
        if (
          !fallback ||
          (source.pluginId && actualRank >= rank && !fallback.source.pluginId) ||
          compareAudioQuality(probed.data, fallback.quality) > 0
        ) {
          fallback = { source, rank: actualRank, quality: probed.data };
        }
      } catch {
        // 无法打开或解码的地址继续换源，不下载错误页面
      }
    }
    if (signal?.aborted) return null;
    if (fallback && fallback.rank >= rank) return fallback.source;
    if (!preferPlugin) break;
  }
  return null;
};
