import { ipcMain } from "@main/runtime/ipc";
import { broadcast } from "@main/utils/broadcast";
import * as nowPlaying from "@main/services/nowPlaying";
import type { NowPlayingUpdatePayload } from "@shared/types/nowPlaying";

/**
 * 注册共用的当前播放同步，桌面按需附加外部事件订阅
 * @param publishExternal - 桌面外部服务的低频事件出口
 * @param syncLyricWindows - 是否转播给独立歌词窗口，Android 没有这些窗口
 */
export const registerNowPlayingIpc = (
  publishExternal?: (event: { type: string; data?: unknown }) => void,
  syncLyricWindows = true,
): void => {
  // 渲染进程同步当前播放状态到主进程
  ipcMain.on("nowPlaying:update", (_event, payload: NowPlayingUpdatePayload) => {
    nowPlaying.update(payload.track, payload.lyric, payload.source);
  });

  // 渲染进程写入指定曲目的歌词偏移
  ipcMain.on("nowPlaying:setLyricOffset", (_event, trackId: string, offsetMs: number) => {
    nowPlaying.setLyricOffset(trackId, offsetMs);
  });

  // 窗口拉取当前完整快照
  ipcMain.handle("nowPlaying:requestSnapshot", () => nowPlaying.snapshot());

  // 订阅 service 事件：同时广播给渲染端窗口和外部 WS 客户端
  // position-sync 高频（5Hz），WS 端走 HIGH_FREQ_EVENTS 过滤自动跳过
  if (syncLyricWindows) {
    nowPlaying.onTrackChange((data) => {
      broadcast("nowPlaying:track-change", data);
      publishExternal?.({ type: "track", data });
    });
    nowPlaying.onLyricChange((snap) => {
      broadcast("nowPlaying:lyric-change", snap);
      publishExternal?.({ type: "lyric", data: { source: snap.source, lyric: snap.lyric } });
    });
    nowPlaying.onPositionSync((data) => broadcast("nowPlaying:position-sync", data, true));
  }
  nowPlaying.onLyricOffsetChange((data) => {
    broadcast("nowPlaying:lyric-offset-change", data);
    publishExternal?.({ type: "lyricOffset", data });
  });
};
