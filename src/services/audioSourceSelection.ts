import type { AudioQuality } from "@shared/types/player";
import {
  compareAudioQuality,
  getQualityLevel,
  QUALITY_ORDER,
  type QualityLevel,
} from "@/utils/quality";

/** 一次选源所需的音质与已尝试来源 */
export interface SourceSelectionAttempt {
  quality: QualityLevel;
  skipPluginIds: readonly string[];
  skipOfficialOnline: boolean;
  onPluginAttempt: (id: string) => void;
  signal?: AbortSignal;
}

/**
 * 在后台探测候选，优先选择达标插件，整档不达标再降低请求档位
 * @param requested - 用户请求的音质
 * @param resolve - 按本轮重试状态解析下一个候选
 * @param sourceUrl - 提取候选的实际音频地址
 * @param signal - 取消后台任务
 * @returns 选中的候选及原始音质，取消或全部失败时为空
 */
export const selectAudioSource = async <T extends { pluginId?: string }>(
  requested: QualityLevel,
  resolve: (attempt: SourceSelectionAttempt) => Promise<T | null>,
  sourceUrl: (source: T) => string,
  signal?: AbortSignal,
): Promise<{ source: T; quality: AudioQuality } | null> => {
  let best: { source: T; quality: AudioQuality; rank: number } | undefined;
  for (let rank = QUALITY_ORDER.indexOf(requested); rank >= 0; rank--) {
    const attempted = new Set<string>();
    let officialTried = false;
    let qualifiedPlugin = false;
    while (!signal?.aborted) {
      const source = await resolve({
        quality: QUALITY_ORDER[rank],
        skipPluginIds: [...attempted],
        skipOfficialOnline: officialTried || qualifiedPlugin,
        onPluginAttempt: (id) => attempted.add(id),
        signal,
      });
      if (signal?.aborted) return null;
      if (!source) break;
      if (source.pluginId) attempted.add(source.pluginId);
      else officialTried = true;
      try {
        const result = await window.api.player.probeSource(sourceUrl(source));
        if (signal?.aborted) return null;
        if (!result.success || !result.data) continue;
        const actualRank = QUALITY_ORDER.indexOf(getQualityLevel(result.data));
        const qualified = Boolean(source.pluginId && actualRank >= rank);
        qualifiedPlugin ||= qualified;
        if (
          !best ||
          (qualified && !best.source.pluginId) ||
          compareAudioQuality(result.data, best.quality) > 0
        ) {
          best = { source, quality: result.data, rank: actualRank };
        }
      } catch {
        // 无效地址继续换源，探测不影响正在播放的音频
      }
    }
    if (signal?.aborted) return null;
    if (best && best.rank >= rank) return { source: best.source, quality: best.quality };
  }
  return null;
};
