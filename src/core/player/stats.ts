import { createPlayStatsRecorder } from "@shared/utils/playStats";
import { useMediaStore } from "@/stores/media";
import { useStatusStore } from "@/stores/status";

const recorder = createPlayStatsRecorder((event) => window.api.stats.recordPlay(event));
let installed = false;

/**
 * 结算自然结束的播放轮次
 * @param restart - 是否继续单曲循环
 */
export const onTrackEnded = (restart: boolean): void => recorder.ended(restart);

/** 将桌面响应式播放状态接入共享的时长累加器 */
export const installPlayStats = (): void => {
  if (installed) return;
  installed = true;
  const media = useMediaStore();
  const status = useStatusStore();
  watch(
    () => [media.track, status.state] as const,
    ([track, state]) => recorder.update(track, state === "playing"),
  );
  window.addEventListener("beforeunload", recorder.finalize);
};
