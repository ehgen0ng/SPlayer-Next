import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AndroidPlaybackSnapshot } from "@shared/types/android";
import type { Track } from "@shared/types/player";

const mocks = vi.hoisted(() => ({ broadcast: vi.fn() }));
vi.mock("./bridge", () => ({ invokeNative: vi.fn(), nativeEvents: { on: vi.fn() } }));
vi.mock("./history", () => ({ recordNativeHistory: vi.fn() }));
vi.mock("@main/database/playStats", () => ({ insertPlayEvent: vi.fn() }));
vi.mock("@main/runtime/ipc", () => ({ ipcMain: { on: vi.fn(), handle: vi.fn() } }));
vi.mock("@main/utils/logger", () => ({ playerLog: { warn: vi.fn() } }));
vi.mock("@main/utils/broadcast", () => ({ broadcast: mocks.broadcast }));
vi.mock("@main/store", () => ({ store: { get: () => ({}), set: vi.fn() } }));

const track: Track = {
  id: "song",
  source: "netease",
  title: "测试歌曲",
  artists: [],
  duration: 300000,
};
const snapshot: AndroidPlaybackSnapshot = {
  track,
  state: "playing",
  position: 0,
  duration: track.duration,
  volume: 1,
  speed: 1,
  isFinished: false,
  currentIndex: 0,
  repeat: "list",
  shuffle: "off",
  timestamp: 0,
  mode: "queue",
  fmOptions: { mode: "DEFAULT" },
};

beforeEach(() => {
  vi.resetModules();
});

describe("原生快照与歌词同步", () => {
  it("Android 不转播歌词窗口消息，插件内部仍接收进度、暂停和倍速变化", async () => {
    const nowPlaying = await import("@main/services/nowPlaying");
    const { registerNowPlayingIpc } = await import("@main/ipc/nowPlaying");
    const { applyPlaybackSnapshot } = await import("./playerControl");
    registerNowPlayingIpc(undefined, false);
    const positions = vi.fn();
    const tracks = vi.fn();
    nowPlaying.onPositionSync(positions);
    nowPlaying.onTrackChange(tracks);

    applyPlaybackSnapshot(snapshot);
    expect(tracks).toHaveBeenCalledWith({ track });
    positions.mockClear();
    mocks.broadcast.mockClear();

    applyPlaybackSnapshot({ ...snapshot, position: 200 });
    applyPlaybackSnapshot({ ...snapshot, position: 400 });
    expect(positions).toHaveBeenCalledTimes(2);
    expect(positions.mock.lastCall?.[0]).toMatchObject({
      position: 400,
      state: "playing",
      speed: 1,
    });
    expect(mocks.broadcast).not.toHaveBeenCalled();

    applyPlaybackSnapshot({ ...snapshot, position: 600, state: "paused", speed: 1.5 });
    expect(nowPlaying.snapshot()).toMatchObject({ position: 600, state: "paused", speed: 1.5 });
    expect(positions.mock.lastCall?.[0]).toMatchObject({
      position: 600,
      playing: false,
      speed: 1.5,
    });
    expect(mocks.broadcast).not.toHaveBeenCalled();

    nowPlaying.setLyricOffset(track.id, 250);
    expect(mocks.broadcast).toHaveBeenCalledExactlyOnceWith("nowPlaying:lyric-offset-change", {
      trackId: track.id,
      offsetMs: 250,
    });
  });

  it("桌面默认继续转播曲目、歌词与可见窗口进度，并保留外部事件", async () => {
    const nowPlaying = await import("@main/services/nowPlaying");
    const { registerNowPlayingIpc } = await import("@main/ipc/nowPlaying");
    const publishExternal = vi.fn();
    registerNowPlayingIpc(publishExternal);
    nowPlaying.update(track, [], null);
    nowPlaying.onPosition(200, true);
    expect(mocks.broadcast).toHaveBeenCalledWith("nowPlaying:track-change", { track });
    expect(mocks.broadcast).toHaveBeenCalledWith(
      "nowPlaying:lyric-change",
      expect.objectContaining({ track }),
    );
    expect(mocks.broadcast).toHaveBeenCalledWith(
      "nowPlaying:position-sync",
      expect.objectContaining({ position: 200 }),
      true,
    );
    expect(publishExternal).toHaveBeenCalledWith({ type: "track", data: { track } });
    expect(publishExternal).toHaveBeenCalledWith({
      type: "lyric",
      data: { source: null, lyric: [] },
    });
  });
});
