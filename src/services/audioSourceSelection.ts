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
  pluginQualities?: ReadonlyMap<string, readonly QualityLevel[] | undefined>;
  /** 后台预缓存等待全部候选，前台取得达标结果后停止扩展请求 */
  waitForAll?: boolean;
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
 * 前台有限并发达标即用，后台等待全部候选择优，降级复用已探测结果
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
  let finished = false;

  /**
   * 解析一个指定来源，降级已达标时复用地址，同一 URL 共用探测请求
   * @param pluginId - 插件标识，null 表示官方来源
   * @param rank - 当前请求档位
   * @returns 本轮该来源已验证的最佳候选
   */
  const inspect = async (pluginId: string | null, rank: number): Promise<Candidate | null> => {
    if (finished || signal?.aborted) return null;
    const cached = reusable.get(pluginId);
    if (cached && cached.rank >= rank) return cached;
    const available = pluginId === null ? undefined : host.pluginQualities?.get(pluginId);
    if (available && !available.includes(QUALITY_ORDER[rank])) return cached ?? null;
    try {
      const source = await resolve({
        quality: QUALITY_ORDER[rank],
        skipPluginIds: pluginIds.filter((id) => id !== pluginId),
        skipOfficialOnline: pluginId !== null,
        signal,
      });
      if (finished || signal?.aborted) return null;
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
      if (finished || signal?.aborted) return null;
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

  /**
   * 收集本档插件结果，前台只保留两个在途候选并在实际音质达标时停止
   * @param rank - 当前请求档位
   * @returns 本轮已完成候选中的最佳结果
   */
  const inspectPlugins = (rank: number): Promise<Candidate | null> =>
    new Promise((resolveRound) => {
      let next = 0;
      let pending = 0;
      let settled = false;
      let best: Candidate | null = null;
      let bestIndex = Number.POSITIVE_INFINITY;
      const concurrency = host.waitForAll ? pluginIds.length : 2;
      /** 收尾本档比较并清理外部取消监听 */
      const complete = (): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", complete);
        resolveRound(signal?.aborted ? null : best);
      };
      /** 按顺序填充空闲请求位，完成后比较真实音质并决定是否继续 */
      const launch = (): void => {
        while (!settled && next < pluginIds.length && pending < concurrency) {
          const index = next++;
          const id = pluginIds[index];
          pending++;
          void inspect(id, rank).then((candidate) => {
            pending--;
            if (settled) return;
            const comparison =
              candidate && best ? compareAudioQuality(candidate.quality, best.quality) : 0;
            if (candidate && (!best || comparison > 0 || (comparison === 0 && index < bestIndex))) {
              best = candidate;
              bestIndex = index;
            }
            if (!host.waitForAll && best && best.rank >= rank) complete();
            else if (next === pluginIds.length && pending === 0) complete();
            else launch();
          });
        }
        if (pending === 0) complete();
      };
      signal?.addEventListener("abort", complete, { once: true });
      if (signal?.aborted) complete();
      else launch();
    });

  try {
    for (let rank = QUALITY_ORDER.indexOf(requested); rank >= 0; rank--) {
      let best = await inspectPlugins(rank);
      if (signal?.aborted) return null;
      if (best && best.rank >= rank) return { source: best.source, quality: best.quality };
      const official = await inspect(null, rank);
      if (signal?.aborted) return null;
      if (official && (!best || compareAudioQuality(official.quality, best.quality) > 0))
        best = official;
      if (best && best.rank >= rank) return { source: best.source, quality: best.quality };
    }
    return null;
  } finally {
    finished = true;
  }
};
