import type { Track } from "../types/player";
import type { PlayEventInput } from "../types/stats";

/**
 * 累计实际播放的墙钟时长，桌面和原生后台共用同一结算规则
 * @param record - 已达到五秒的会话写入函数
 * @param now - 当前毫秒时间
 * @returns 播放状态更新与结算方法
 */
export const createPlayStatsRecorder = (
  record: (event: PlayEventInput) => void,
  now: () => number = Date.now,
) => {
  let session: (PlayEventInput & { playingSince: number | null }) | null = null;

  /** 将当前连续播放区间计入会话 */
  const settle = (): void => {
    if (!session || session.playingSince === null) return;
    session.listenedMs += now() - session.playingSince;
    session.playingSince = null;
  };

  /** 结算会话，忽略不足五秒的试听 */
  const finalize = (): void => {
    if (!session) return;
    settle();
    const { track, startedAt, listenedMs } = session;
    session = null;
    if (listenedMs >= 5000) record({ track, startedAt, listenedMs });
  };

  /**
   * 按曲目身份和实际播放状态更新计时
   * @param track - 当前曲目
   * @param playing - 是否实际输出音频
   */
  const update = (track: Track | null, playing: boolean): void => {
    if (
      session &&
      (session.track.id !== track?.id ||
        session.track.source !== track?.source ||
        session.track.plugin?.pluginId !== track?.plugin?.pluginId)
    )
      finalize();
    if (track && !session) session = { track, startedAt: now(), listenedMs: 0, playingSince: null };
    if (!session) return;
    if (playing) session.playingSince ??= now();
    else settle();
  };

  /**
   * 自然结束时结算，单曲循环为同一曲目开启下一轮
   * @param restart - 是否继续循环
   */
  const ended = (restart: boolean): void => {
    const track = session?.track ?? null;
    finalize();
    if (restart) update(track, true);
  };
  return { update, finalize, ended };
};
