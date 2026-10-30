import { powerSaveBlocker } from "electron";
import type { PlayerState } from "@shared/types/player";
import { store } from "@main/store";
import { systemLog } from "./logger";

let suspensionBlockerId: number | null = null;
let displayBlockerId: number | null = null;
let playbackState: PlayerState = "idle";

/** 按播放状态和常亮开关更新电源抑制，切歌加载期间保持屏幕常亮 */
export const refreshPowerBlocker = (): void => {
  const audioActive = playbackState === "playing" || playbackState === "loading";
  const displayActive = store.get("player.keepScreenAwake") && audioActive;

  if (audioActive && suspensionBlockerId === null) {
    suspensionBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    systemLog.info(`已启用休眠抑制 (id: ${suspensionBlockerId})`);
  } else if (!audioActive && suspensionBlockerId !== null) {
    powerSaveBlocker.stop(suspensionBlockerId);
    systemLog.info(`已释放休眠抑制 (id: ${suspensionBlockerId})`);
    suspensionBlockerId = null;
  }

  if (displayActive && displayBlockerId === null) {
    displayBlockerId = powerSaveBlocker.start("prevent-display-sleep");
    systemLog.info(`已启用屏幕常亮 (id: ${displayBlockerId})`);
  } else if (!displayActive && displayBlockerId !== null) {
    powerSaveBlocker.stop(displayBlockerId);
    systemLog.info(`已释放屏幕常亮 (id: ${displayBlockerId})`);
    displayBlockerId = null;
  }
};

/**
 * 从原生播放事件更新电源策略
 * @param state - 原生播放器状态
 */
export const updatePowerBlocker = (state: PlayerState): void => {
  playbackState = state;
  refreshPowerBlocker();
};

/** 退出前释放全部电源抑制并重置播放状态 */
export const releasePowerBlocker = (): void => {
  playbackState = "idle";
  refreshPowerBlocker();
};
