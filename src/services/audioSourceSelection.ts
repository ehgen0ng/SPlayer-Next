import type { AudioQuality, AudioSourceProbe, IpcResponse, Track } from "@shared/types/player";
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
  signal?: AbortSignal;
}

/** 平台只提供候选顺序和实际音质探测，选择规则由公共流程负责 */
export interface SourceSelectionHost {
  pluginIds: readonly string[];
  probe: (url: string) => Promise<IpcResponse<AudioSourceProbe>>;
  track?: Pick<Track, "artists" | "duration">;
  verifyArtist?: boolean;
  verifyDuration?: boolean;
  signal?: AbortSignal;
}

/**
 * 消除歌手名的大小写、空格和标点差异，不使用短名称子串匹配
 * @param name - 音频标签或平台歌手名
 * @returns 用于精确比较的名称
 */
const normalizeArtist = (name: string): string =>
  name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\p{M}\p{P}\p{S}\s]/gu, "");

/**
 * 排除歌手或时长明确冲突的音源，缺失标签不能证明匹配也不能证明串歌
 * @param track - 用户选中的歌曲
 * @param probe - 从候选音频读取的真实信息
 * @param verifyArtist - 是否检查歌手标签
 * @param verifyDuration - 是否检查实际时长
 * @returns 是否没有发现身份冲突
 */
export const matchesAudioSource = (
  track: Pick<Track, "artists" | "duration">,
  probe: AudioSourceProbe,
  verifyArtist = false,
  verifyDuration = false,
): boolean => {
  if (
    verifyDuration &&
    track.duration > 0 &&
    probe.duration != null &&
    Number.isFinite(probe.duration) &&
    probe.duration > 0 &&
    Math.abs(track.duration - probe.duration) > 5000
  )
    return false;
  if (!verifyArtist) return true;
  const expected = track.artists.map((artist) => normalizeArtist(artist.name)).filter(Boolean);
  const actual = probe.artist?.trim();
  if (!actual || expected.length === 0) return true;
  const names = [
    actual,
    ...actual.split(/\s+(?:feat\.?|ft\.?|featuring|with)\s+|[、,，;/|&()（）]+/iu),
  ]
    .map(normalizeArtist)
    .filter(Boolean);
  return expected.some((artist) => names.includes(artist));
};

/**
 * 并发解析并探测本档全部插件，降级复用已达标结果，同质保留插件顺序
 * @param requested - 用户请求的音质
 * @param resolve - 按本轮重试状态解析下一个候选
 * @param host - 有序候选、平台探测和取消信号
 * @returns 选中的候选及原始音质，取消或全部失败时为空
 */
export const selectAudioSource = async <T extends { url: string; pluginId?: string }>(
  requested: QualityLevel,
  resolve: (attempt: SourceSelectionAttempt) => Promise<T | null>,
  host: SourceSelectionHost,
): Promise<{ source: T; quality: AudioQuality } | null> => {
  const { pluginIds, probe, signal } = host;
  type Candidate = { source: T; quality: AudioQuality; rank: number };
  const reusable = new Map<string | null, Candidate>();
  const probes = new Map<string, Promise<AudioSourceProbe | null>>();

  /**
   * 解析一个指定来源，降级已达标时复用地址，同一 URL 共用探测请求
   * @param pluginId - 插件标识，null 表示官方来源
   * @param rank - 当前请求档位
   * @returns 本轮该来源已验证的最佳候选
   */
  const inspect = async (pluginId: string | null, rank: number): Promise<Candidate | null> => {
    if (signal?.aborted) return null;
    const cached = reusable.get(pluginId);
    if (cached && cached.rank >= rank) return cached;
    try {
      const source = await resolve({
        quality: QUALITY_ORDER[rank],
        skipPluginIds: pluginIds.filter((id) => id !== pluginId),
        skipOfficialOnline: pluginId !== null,
        signal,
      });
      if (signal?.aborted) return null;
      if (!source) return cached ?? null;
      const url = source.url;
      let pending = probes.get(url);
      if (!pending) {
        pending = probe(url)
          .then((result) => (result.success ? (result.data ?? null) : null))
          .catch(() => null);
        probes.set(url, pending);
      }
      const quality = await pending;
      if (signal?.aborted) return null;
      if (
        quality &&
        (!host.track ||
          !source.pluginId ||
          matchesAudioSource(host.track, quality, host.verifyArtist, host.verifyDuration)) &&
        (!cached || compareAudioQuality(quality, cached.quality) > 0)
      ) {
        const candidate = {
          source,
          quality,
          rank: QUALITY_ORDER.indexOf(getQualityLevel(quality)),
        };
        reusable.set(pluginId, candidate);
        return candidate;
      }
    } catch {
      // 单个来源失败不影响本档其他候选，下一档仍可重试
    }
    return cached ?? null;
  };

  for (let rank = QUALITY_ORDER.indexOf(requested); rank >= 0; rank--) {
    const candidates = await Promise.all(pluginIds.map((id) => inspect(id, rank)));
    if (signal?.aborted) return null;
    let best: Candidate | null = null;
    for (const candidate of candidates) {
      if (candidate && (!best || compareAudioQuality(candidate.quality, best.quality) > 0)) {
        best = candidate;
      }
    }
    if (best && best.rank >= rank) return { source: best.source, quality: best.quality };
    const official = await inspect(null, rank);
    if (signal?.aborted) return null;
    if (official && (!best || compareAudioQuality(official.quality, best.quality) > 0))
      best = official;
    if (best && best.rank >= rank) return { source: best.source, quality: best.quality };
  }
  return null;
};
