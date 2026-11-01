import type { Track } from "../types/player";

export interface HistoryEntry {
  track: Track;
  playedAt: number;
}

/**
 * 区分平台与插件内的曲目身份
 * @param track - 轻量曲目信息
 * @returns 稳定身份键
 */
export const historyKey = (track: Track): string =>
  `${track.source}:${track.plugin?.pluginId ?? ""}:${track.id}`;

/**
 * 将最近播放曲目置顶，同曲去重并保持既有五百条上限
 * @param entries - 之前的倒序记录
 * @param track - 本次实际播放的曲目
 * @returns 新的倒序记录
 */
export const recordHistory = (entries: HistoryEntry[], track: Track): HistoryEntry[] =>
  [
    { track, playedAt: Date.now() },
    ...entries.filter((entry) => historyKey(entry.track) !== historyKey(track)),
  ].slice(0, 500);
