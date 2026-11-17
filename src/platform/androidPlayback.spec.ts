import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, reactive } from "vue";
import type { AndroidPlaybackSnapshot } from "@shared/types/android";
import type { Track } from "@shared/types/player";
import * as playback from "@/services/playback";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (data: unknown) => void>(),
  settings: {
    syncSystem: vi.fn(),
    player: {
      songLevel: "hq",
      preferPluginSource: true,
      allowTrialPlay: false,
      preloadNextTrack: true,
      verifySourceArtist: false,
      verifySourceDuration: false,
    },
  },
  status: { searchPlatform: "netease", lyricOffsetMs: 0 },
  media: { track: null as Track | null, setPlaybackContext: vi.fn(), updateLyricIndex: vi.fn() },
}));
vi.mock("./android", () => ({
  invokeAndroid: mocks.invoke,
  onAndroid: (channel: string, listener: (data: unknown) => void) => {
    mocks.listeners.set(channel, listener);
    return () => mocks.listeners.delete(channel);
  },
}));
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => mocks.settings }));
vi.mock("@/stores/status", () => ({ useStatusStore: () => mocks.status }));
vi.mock("@/stores/media", () => ({ useMediaStore: () => mocks.media }));
vi.mock("@/stores/plugins", () => ({ usePluginsStore: () => ({ load: vi.fn() }) }));
vi.mock("@/stores/history", () => ({ useHistoryStore: vi.fn() }));
vi.mock("@/stores/queue", () => ({ queueEntries: { value: [] } }));
vi.mock("@/services/lyric/loader", () => ({ beginLoad: vi.fn(), loadForTrack: vi.fn() }));
vi.mock("@/services/coverLoader", () => ({ loadCoverForTrack: vi.fn() }));
vi.mock("@/utils/color", () => ({ extractColorFromUrl: vi.fn() }));
vi.mock("@/composables/useToast", () => ({ toast: { error: vi.fn() } }));
import { initAndroidPlayback } from "./androidPlayback";

let now = 0;
const epoch = 1_700_000_000_000;

/**
 * 创建包含原生采样时间的播放快照
 * @param overrides - 当前场景覆盖的状态
 * @returns 原生播放快照
 */
const makeSnapshot = (
  overrides: Partial<AndroidPlaybackSnapshot> = {},
): AndroidPlaybackSnapshot => ({
  track: null,
  state: "idle",
  position: 0,
  duration: 200_000,
  volume: 1,
  speed: 1,
  isFinished: false,
  currentIndex: 0,
  repeat: "list",
  shuffle: "off",
  timestamp: epoch + now,
  mode: "queue",
  fmOptions: {},
  ...overrides,
});

/**
 * 通过真实订阅入口发送原生播放快照
 * @param overrides - 本次进度或状态变化
 */
const publishSnapshot = (overrides: Partial<AndroidPlaybackSnapshot>): void => {
  mocks.listeners.get("android:playback")!(makeSnapshot(overrides));
};

beforeEach(() => {
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(Date, "now").mockImplementation(() => epoch + now);
  playback.reset();
  playback.setSpeed(1);
  mocks.listeners.clear();
  mocks.settings = reactive({
    syncSystem: vi.fn(),
    player: {
      songLevel: "hq",
      preferPluginSource: true,
      allowTrialPlay: false,
      preloadNextTrack: true,
      verifySourceArtist: false,
      verifySourceDuration: false,
    },
  });
  mocks.status = reactive({ searchPlatform: "netease", lyricOffsetMs: 0 });
  mocks.media = { track: null, setPlaybackContext: vi.fn(), updateLyricIndex: vi.fn() };
  mocks.invoke.mockReset().mockImplementation(async (channel) => {
    if (channel === "android:queue") return [];
    if (channel === "android:snapshot") return makeSnapshot();
    return undefined;
  });
  Object.assign(window, {
    api: {
      nowPlaying: {
        onLyricOffsetChange: () => vi.fn(),
        requestSnapshot: async () => ({ lyricOffsetMs: 0 }),
      },
    },
  });
});

describe("车机歌词时钟同步", () => {
  it("周期快照传输延迟变化时逐字时间持续前进", async () => {
    const stop = await initAndroidPlayback();
    try {
      publishSnapshot({ state: "playing", position: 1_000 });
      for (const [receivedAt, sampledAt] of [
        [220, 200],
        [480, 400],
        [620, 600],
      ]) {
        now = receivedAt;
        const before = playback.getCurrentTime();
        publishSnapshot({
          state: "playing",
          position: 1_000 + sampledAt,
          timestamp: epoch + sampledAt,
        });
        expect(playback.getCurrentTime()).toBe(before);
        expect(playback.getCurrentTime()).toBe(1_000 + receivedAt);
      }
    } finally {
      stop();
    }
  });

  it("原生进度小幅波动使用已有平滑校正", async () => {
    const stop = await initAndroidPlayback();
    try {
      publishSnapshot({ state: "playing", position: 1_000 });
      now = 500;
      publishSnapshot({ state: "playing", position: 1_400 });
      expect(playback.getCurrentTime()).toBe(1_480);
      expect(mocks.media.updateLyricIndex).toHaveBeenLastCalledWith(1_480);
    } finally {
      stop();
    }
  });

  it("变速时按当前速度补偿传输延迟，并限制在歌曲时长内", async () => {
    const stop = await initAndroidPlayback();
    try {
      now = 100;
      publishSnapshot({ state: "playing", position: 1_000, timestamp: epoch, speed: 2 });
      expect(playback.getCurrentTime()).toBe(1_200);
      now = 200;
      expect(playback.getCurrentTime()).toBe(1_400);
      publishSnapshot({ state: "playing", position: 199_900, timestamp: epoch + 100, speed: 2 });
      expect(playback.getCurrentTime()).toBe(200_000);
    } finally {
      stop();
    }
  });

  it("暂停精确定位且不补偿延迟，恢复播放重新校准", async () => {
    const stop = await initAndroidPlayback();
    try {
      publishSnapshot({ state: "playing", position: 1_000 });
      now = 300;
      publishSnapshot({ state: "paused", position: 1_200, timestamp: epoch + 200 });
      now = 600;
      expect(playback.getCurrentTime()).toBe(1_200);
      publishSnapshot({ state: "paused", position: 1_250, timestamp: epoch + 400 });
      expect(playback.getCurrentTime()).toBe(1_250);
      publishSnapshot({ state: "playing", position: 1_250, timestamp: epoch + 500 });
      expect(playback.getCurrentTime()).toBe(1_350);
    } finally {
      stop();
    }
  });

  it("切歌和不足一秒的主动跳转立即定位，不被平滑校正拖慢", async () => {
    const stop = await initAndroidPlayback();
    try {
      const track: Track = {
        id: "lyric-test",
        source: "netease",
        title: "歌词测试",
        artists: [],
        duration: 200_000,
      };
      publishSnapshot({ track, state: "playing", position: 500 });
      publishSnapshot({ track: { ...track, id: "next" }, state: "playing", position: 0 });
      expect(playback.getCurrentTime()).toBe(0);
      publishSnapshot({
        track: mocks.media.track,
        state: "playing",
        position: 400,
        positionDiscontinuity: true,
      });
      expect(playback.getCurrentTime()).toBe(400);
      publishSnapshot({
        track: mocks.media.track,
        state: "playing",
        position: 100,
        positionDiscontinuity: true,
      });
      expect(playback.getCurrentTime()).toBe(100);
    } finally {
      stop();
    }
  });
});

describe("车机播放偏好同步", () => {
  it("初始化和开关变化均传递预载与独立校验设置，退出后停止监听", async () => {
    const stop = await initAndroidPlayback();
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "android:preferences",
      expect.objectContaining({
        preloadNextTrack: true,
        verifySourceArtist: false,
        verifySourceDuration: false,
      }),
    );
    mocks.settings.player.preloadNextTrack = false;
    mocks.settings.player.verifySourceArtist = true;
    await nextTick();
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "android:preferences",
      expect.objectContaining({
        preloadNextTrack: false,
        verifySourceArtist: true,
        verifySourceDuration: false,
      }),
    );
    mocks.settings.player.verifySourceDuration = true;
    await nextTick();
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "android:preferences",
      expect.objectContaining({
        verifySourceArtist: true,
        verifySourceDuration: true,
      }),
    );
    stop();
    mocks.invoke.mockClear();
    mocks.settings.player.preloadNextTrack = true;
    await nextTick();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
