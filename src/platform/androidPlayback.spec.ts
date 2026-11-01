import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, reactive } from "vue";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
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
  status: { searchPlatform: "netease" },
  media: { track: null, setPlaybackContext: vi.fn(), updateLyricIndex: vi.fn() },
}));
vi.mock("./android", () => ({ invokeAndroid: mocks.invoke, onAndroid: () => vi.fn() }));
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => mocks.settings }));
vi.mock("@/stores/status", () => ({ useStatusStore: () => mocks.status }));
vi.mock("@/stores/media", () => ({ useMediaStore: () => mocks.media }));
vi.mock("@/stores/plugins", () => ({ usePluginsStore: () => ({ load: vi.fn() }) }));
vi.mock("@/stores/history", () => ({ useHistoryStore: vi.fn() }));
vi.mock("@/stores/queue", () => ({ queueEntries: { value: [] } }));
vi.mock("@/services/playback", () => ({
  setDuration: vi.fn(),
  setSpeed: vi.fn(),
  setPlaying: vi.fn(),
  setCurrentTime: vi.fn(),
}));
vi.mock("@/services/lyric/loader", () => ({ beginLoad: vi.fn(), loadForTrack: vi.fn() }));
vi.mock("@/services/coverLoader", () => ({ loadCoverForTrack: vi.fn() }));
vi.mock("@/utils/color", () => ({ extractColorFromUrl: vi.fn() }));
vi.mock("@/composables/useToast", () => ({ toast: { error: vi.fn() } }));
import { initAndroidPlayback } from "./androidPlayback";

beforeEach(() => {
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
  mocks.status = reactive({ searchPlatform: "netease" });
  mocks.media = { track: null, setPlaybackContext: vi.fn(), updateLyricIndex: vi.fn() };
  mocks.invoke.mockReset().mockImplementation(async (channel) => {
    if (channel === "android:queue") return [];
    if (channel === "android:snapshot")
      return { track: null, state: "idle", position: 0, duration: 0 };
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
