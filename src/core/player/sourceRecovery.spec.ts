import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioQuality, Track } from "@shared/types/player";
import type { PluginInfo } from "@shared/types/plugin";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  load: vi.fn(),
  play: vi.fn(),
  pause: vi.fn(),
  seek: vi.fn(),
  stop: vi.fn(),
  toast: vi.fn(),
  warning: vi.fn(),
  pluginResolve: vi.fn(),
  recordMusicSuccess: vi.fn(),
  consume: vi.fn(),
  plugins: [] as PluginInfo[],
  playerSettings: { songLevel: "hq", allowTrialPlay: false, preferPluginSource: false },
  systemPlayer: { rememberLastTrack: true, autoPlay: false },
}));

vi.mock("@/apis/netease", () => ({ netease: {}, neteaseCall: mocks.request }));
vi.mock("@/apis/song/qqmusic", () => ({ resolveQQMusicUrl: vi.fn() }));
vi.mock("@/apis/song/kugou", () => ({ resolveKugouUrl: vi.fn() }));
vi.mock("@/stores/user", () => ({
  useUserStore: () => ({ isLoggedIn: true, fetchStatus: async () => true }),
}));
vi.mock("@/stores/settings", () => ({
  useSettingsStore: () => ({
    preset: { skipKeywordsSongs: false, skipTrackKeywords: [] },
    player: mocks.playerSettings,
    system: { cache: { songCache: { enabled: false } }, player: mocks.systemPlayer },
    lyric: { cjkTransform: "none" },
  }),
}));
vi.mock("@/stores/plugins", () => ({
  usePluginsStore: () => ({
    list: mocks.plugins,
    orderedList: mocks.plugins,
    recordMusicSuccess: mocks.recordMusicSuccess,
  }),
}));
vi.mock("@/stores/streaming", () => ({ useStreamingStore: vi.fn() }));
vi.mock("@/stores/history", () => ({ useHistoryStore: () => ({ record: vi.fn() }) }));
vi.mock("@/stores/library", () => ({ useLibraryStore: vi.fn() }));
vi.mock("localforage", () => ({
  default: { createInstance: () => ({ setItem: async () => null }) },
}));
vi.mock("./fm", () => ({}));
vi.mock("./stats", () => ({ installPlayStats: vi.fn(), onTrackEnded: vi.fn() }));
vi.mock("@/services/nextTrackPreloader", () => ({
  consumePreloadedTrack: mocks.consume,
  invalidateNextTrackPreload: vi.fn(),
  scheduleNextTrackPreload: vi.fn(),
}));
vi.mock("@/services/lyric/loader", () => ({
  beginLoad: vi.fn(),
  loadForTrack: vi.fn(),
  watchLyricPreference: vi.fn(),
}));
vi.mock("@/services/coverLoader", () => ({ loadCoverForTrack: vi.fn() }));
vi.mock("@/services/abLoop", () => ({ reset: vi.fn() }));
vi.mock("@/services/cacheScheduler", () => ({ cancel: vi.fn(), schedule: vi.fn() }));
vi.mock("@/services/deviceVolume", () => ({ getDeviceVolume: vi.fn(), setDeviceVolume: vi.fn() }));
vi.mock("@/composables/useFavorite", () => ({ useFavorite: vi.fn() }));
vi.mock("@/composables/useToast", () => ({
  toast: { error: mocks.toast, warning: mocks.warning },
}));
vi.mock("@/composables/useDialog", () => ({ dialog: { alert: async () => undefined } }));
vi.mock("@/utils/color", () => ({ extractColorFromUrl: vi.fn() }));
vi.mock("@/i18n", () => ({
  default: { global: { t: (key: string) => key, te: () => true } },
}));

const tracks: Track[] = ["current", "next", "last"].map((id) => ({
  id,
  title: id,
  source: "netease",
  artists: [{ name: "测试歌手" }],
  duration: 180000,
}));
const oldUrl = "https://music.example/current?token=expired";
const newUrl = "https://music.example/current?token=fresh";
const resumePosition = 42000;

let player: typeof import("./index");
let events: typeof import("./events");
let playback: typeof import("@/services/playback");
let status: ReturnType<typeof import("@/stores/status").useStatusStore>;
let media: ReturnType<typeof import("@/stores/media").useMediaStore>;

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  mocks.playerSettings.songLevel = "hq";
  mocks.playerSettings.preferPluginSource = false;
  mocks.consume.mockReturnValue(null);
  mocks.systemPlayer.autoPlay = false;
  mocks.plugins = [];
  const { createPinia, setActivePinia } = await import("pinia");
  setActivePinia(createPinia());
  Object.assign(window, {
    api: {
      player: {
        load: mocks.load,
        play: mocks.play,
        pause: mocks.pause,
        seek: mocks.seek,
        stop: mocks.stop,
      },
      download: { lookup: async () => null },
      plugins: { resolveUrl: mocks.pluginResolve },
      nowPlaying: { update: vi.fn() },
    },
  });
  mocks.load.mockResolvedValue({
    success: true,
    data: { detail: {}, mediaInfo: { duration: 180000 } },
  });
  mocks.play.mockResolvedValue({ success: true });
  mocks.pause.mockResolvedValue({ success: true });
  mocks.seek.mockResolvedValue({ success: true });
  mocks.stop.mockResolvedValue({ success: true });
  mocks.request.mockResolvedValue({ data: [{ url: newUrl, freeTrialInfo: null }] });
  const queue = await import("@/stores/queue");
  queue.setQueue(tracks);
  status = (await import("@/stores/status")).useStatusStore();
  media = (await import("@/stores/media")).useMediaStore();
  media.setTrack(tracks[0]!);
  status.playIndex = 0;
  status.state = "paused";
  status.position = resumePosition;
  status.duration = 180000;
  status.currentSource = oldUrl;
  playback = await import("@/services/playback");
  playback.setDuration(180000);
  playback.setCurrentTime(resumePosition, { force: true });
  playback.setPlaying(false);
  player = await import("./index");
  events = await import("./events");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("插件优先按实际解码音质换源", () => {
  const mp3: AudioQuality = {
    codec: "mp3",
    bitRate: 128000,
    sampleRate: 44100,
    bitsPerSample: 32,
    channels: 2,
  };
  const lossless: AudioQuality = { ...mp3, codec: "flac", bitRate: 900000, bitsPerSample: 16 };
  const hires: AudioQuality = { ...lossless, sampleRate: 96000, bitsPerSample: 24 };
  let qualities: Record<string, AudioQuality>;

  beforeEach(() => {
    mocks.playerSettings.preferPluginSource = true;
    mocks.playerSettings.songLevel = "lossless";
    qualities = { a: mp3, b: lossless, c: hires, official: mp3 };
    mocks.plugins = ["a", "b", "c"].map((id) => ({
      manifest: {
        id,
        name: id,
        version: "1.0.0",
        grant: [],
        apiLevel: 1,
        hash: "test",
        installedAt: 0,
        fileName: `${id}.js`,
      },
      enabled: true,
      status: {
        state: "ready",
        sources: {
          wy: { name: "NCM", actions: ["musicUrl"] },
          tx: { name: "QM", actions: ["musicUrl"] },
          kg: { name: "KG", actions: ["musicUrl"] },
        },
      },
    }));
    // 地址后缀和插件自报音质均不可信，以加载返回的编码信息为准
    mocks.pluginResolve.mockImplementation(async ({ pluginId }) => ({
      url: `https://plugin/${pluginId}.flac`,
      quality: "hi-res",
    }));
    mocks.load.mockImplementation(async (url: string) => {
      const id = /\/([abc])\.flac$/.exec(url)?.[1] ?? "official";
      const quality = qualities[id];
      return {
        success: true,
        data: { detail: { quality }, mediaInfo: { duration: 180000, quality } },
      };
    });
  });

  it.each(["netease", "qqmusic", "kugou"] as const)(
    "%s 返回伪装成 FLAC 的 MP3 时继续换插件，比较达标候选后才播放",
    async (source) => {
      const queue = await import("@/stores/queue");
      queue.setQueue([tracks[0]!, { ...tracks[1]!, source }]);
      await player.playAtIndex(1);
      expect(mocks.pluginResolve.mock.calls.map(([args]) => args.pluginId)).toEqual([
        "a",
        "b",
        "c",
      ]);
      expect(mocks.load.mock.calls.map(([url]) => url)).toEqual([
        "https://plugin/a.flac",
        "https://plugin/b.flac",
        "https://plugin/c.flac",
        "https://plugin/c.flac",
      ]);
      expect(mocks.load.mock.calls.every(([, options]) => options.autoPlay === false)).toBe(true);
      expect(mocks.play).toHaveBeenCalledOnce();
      expect(mocks.play.mock.invocationCallOrder[0]).toBeGreaterThan(
        mocks.load.mock.invocationCallOrder[1]!,
      );
      expect(media.detail?.quality.codec).toBe("flac");
      expect(mocks.warning).not.toHaveBeenCalled();
      expect(mocks.recordMusicSuccess).toHaveBeenCalledExactlyOnceWith("c");
    },
  );

  it("Hi-Res 请求按真实档位过滤，所有候选比较完成后才播放", async () => {
    mocks.playerSettings.songLevel = "hi-res";
    await player.playAtIndex(1);
    expect(mocks.pluginResolve.mock.calls.map(([args]) => args.pluginId)).toEqual(["a", "b", "c"]);
    expect(mocks.pluginResolve.mock.calls.every(([args]) => args.quality === "hi-res")).toBe(true);
    expect(status.currentSource).toBe("https://plugin/c.flac");
    expect(mocks.play).toHaveBeenCalledOnce();
    expect(mocks.warning).not.toHaveBeenCalled();
    const lyrics = await import("@/services/lyric/loader");
    expect(lyrics.loadForTrack).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("同档无损按码率择优，六声道更大仍标为普通无损", async () => {
    qualities.a = { ...lossless, bitRate: 1033000 };
    qualities.b = { ...lossless, bitRate: 2595000, channels: 6 };
    qualities.c = { ...lossless, bitRate: 1500000 };
    await player.playAtIndex(1);
    expect(mocks.pluginResolve.mock.calls.map(([args]) => args.pluginId)).toEqual(["a", "b", "c"]);
    expect(status.currentSource).toBe("https://plugin/b.flac");
    expect(media.detail?.quality).toEqual(qualities.b);
    expect(mocks.recordMusicSuccess).toHaveBeenCalledExactlyOnceWith("b");
    expect(mocks.play).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    "后台已完成选源时切歌只加载一次，不再轮询插件，完整缓存=%s",
    async (cached) => {
      mocks.playerSettings.songLevel = "hi-res";
      const source = cached ? "C:/cache/next.flac" : "https://plugin/b.flac";
      mocks.consume.mockReturnValue({
        trackId: "next",
        preparedId: cached ? "slot" : undefined,
        source: {
          source,
          provider: cached ? "cache" : "plugin",
          fromCache: cached,
          pluginId: "b",
          verifiedQuality: lossless,
        },
      });
      mocks.load.mockResolvedValueOnce({
        success: true,
        data: { detail: { quality: lossless }, mediaInfo: { duration: 180000 } },
      });
      await player.playAtIndex(1);
      expect(mocks.pluginResolve).not.toHaveBeenCalled();
      expect(mocks.request).not.toHaveBeenCalled();
      expect(mocks.load).toHaveBeenCalledOnce();
      expect(status.currentSource).toBe(source);
      expect(mocks.play).toHaveBeenCalledOnce();
      expect(mocks.recordMusicSuccess).toHaveBeenCalledExactlyOnceWith("b");
      expect(mocks.warning).toHaveBeenCalledExactlyOnceWith("player.qualityFallback");
    },
  );

  it("PCM 尚未准备好时直接交接半成品缓存，不先停止并取消它", async () => {
    mocks.consume.mockReturnValue({
      trackId: "next",
      cacheLeaseId: "pending",
      source: {
        source: "cache-stream://next",
        provider: "cache",
        fromCache: true,
        pluginId: "b",
        verifiedQuality: lossless,
      },
    });
    mocks.load.mockResolvedValueOnce({
      success: true,
      data: { detail: { quality: lossless }, mediaInfo: { duration: 180000 } },
    });
    await player.playAtIndex(1);
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.load).toHaveBeenCalledWith(
      "cache-stream://next",
      expect.objectContaining({ cacheLeaseId: "pending" }),
    );
    expect(mocks.pluginResolve).not.toHaveBeenCalled();
    expect(status.currentSource).toBe("cache-stream://next");
  });

  it("预载缓存文件损坏时才重新解析在线音源", async () => {
    mocks.consume.mockReturnValue({
      trackId: "next",
      source: {
        source: "C:/cache/broken.flac",
        provider: "cache",
        fromCache: true,
        pluginId: "b",
        verifiedQuality: lossless,
      },
    });
    mocks.load.mockResolvedValueOnce({ success: false, error: "FILE_DECODE_ERROR" });
    await player.playAtIndex(1);
    expect(mocks.pluginResolve).toHaveBeenCalled();
    expect(status.currentSource).toBe("https://plugin/c.flac");
    expect(mocks.play).toHaveBeenCalledOnce();
  });

  it("冷启动恢复同样筛选音质，校验完成后恢复自动播放和记忆进度", async () => {
    mocks.systemPlayer.autoPlay = true;
    await player.restoreLastTrack();
    expect(mocks.pluginResolve.mock.calls.map(([args]) => args.pluginId)).toEqual(["a", "b", "c"]);
    expect(mocks.play).toHaveBeenCalledOnce();
    expect(mocks.seek).toHaveBeenCalledWith(resumePosition);
    expect(status.state).toBe("playing");
    expect(status.currentSource).toBe("https://plugin/c.flac");
  });

  it("同档换源不会重复调用前面已经报错的插件", async () => {
    qualities.b = mp3;
    mocks.pluginResolve.mockImplementation(async ({ pluginId }) => {
      if (pluginId === "a") throw new Error("source unavailable");
      return { url: `https://plugin/${pluginId}.flac` };
    });
    await player.playAtIndex(1);
    expect(mocks.pluginResolve.mock.calls.map(([args]) => args.pluginId)).toEqual(["a", "b", "c"]);
    expect(status.currentSource).toBe("https://plugin/c.flac");
    expect(mocks.play).toHaveBeenCalledOnce();
  });

  it("全部不达标时尝试完插件和内置音源，再回到较高档位并提示降级", async () => {
    mocks.playerSettings.songLevel = "hi-res";
    qualities.c = { ...mp3, bitRate: 320000 };
    await player.playAtIndex(1);
    expect(mocks.load.mock.calls.map(([url]) => url)).toEqual([
      "https://plugin/a.flac",
      "https://plugin/b.flac",
      "https://plugin/c.flac",
      newUrl,
      "https://plugin/a.flac",
      "https://plugin/b.flac",
      "https://plugin/c.flac",
      "https://plugin/b.flac",
    ]);
    expect(mocks.pluginResolve).toHaveBeenCalledTimes(6);
    expect(mocks.play).toHaveBeenCalledOnce();
    expect(mocks.warning).toHaveBeenCalledExactlyOnceWith("player.qualityFallback");
    expect(mocks.recordMusicSuccess).toHaveBeenCalledExactlyOnceWith("b");
  });

  it("插件只有 MP3 时仍尝试内置无损音源", async () => {
    qualities.b = mp3;
    qualities.c = mp3;
    qualities.official = lossless;
    await player.playAtIndex(1);
    expect(status.currentSource).toBe(newUrl);
    expect(mocks.load).toHaveBeenCalledTimes(5);
    expect(mocks.play).toHaveBeenCalledOnce();
    expect(mocks.warning).not.toHaveBeenCalled();
  });

  it("Hi-Res 全部拒绝后使用无损参数从首个插件重试，不改用户的音质设置", async () => {
    mocks.playerSettings.songLevel = "hi-res";
    mocks.request.mockResolvedValue({ data: [{ url: null, fee: 0 }] });
    qualities.c = { ...lossless, bitRate: 1800000 };
    mocks.pluginResolve.mockImplementation(async ({ pluginId, quality }) => {
      if (quality === "hi-res" || pluginId === "a") throw new Error("unsupported quality");
      return { url: `https://plugin/${pluginId}.flac` };
    });
    await player.playAtIndex(1);
    expect(mocks.pluginResolve.mock.calls.map(([args]) => [args.pluginId, args.quality])).toEqual([
      ["a", "hi-res"],
      ["b", "hi-res"],
      ["c", "hi-res"],
      ["a", "lossless"],
      ["b", "lossless"],
      ["c", "lossless"],
    ]);
    expect(status.currentSource).toBe("https://plugin/c.flac");
    expect(mocks.playerSettings.songLevel).toBe("hi-res");
    expect(mocks.warning).toHaveBeenCalledOnce();
  });

  it("Hi-Res 和无损均不可用时再以 HQ 参数尝试插件", async () => {
    mocks.playerSettings.songLevel = "hi-res";
    mocks.request.mockResolvedValue({ data: [{ url: null, fee: 0 }] });
    qualities.a = { ...mp3, bitRate: 320000 };
    qualities.b = mp3;
    qualities.c = mp3;
    mocks.pluginResolve.mockImplementation(async ({ pluginId, quality }) => {
      if (quality !== "hq") throw new Error("unsupported quality");
      return { url: `https://plugin/${pluginId}.flac` };
    });
    await player.playAtIndex(1);
    expect(mocks.pluginResolve.mock.calls.map(([args]) => [args.pluginId, args.quality])).toEqual([
      ["a", "hi-res"],
      ["b", "hi-res"],
      ["c", "hi-res"],
      ["a", "lossless"],
      ["b", "lossless"],
      ["c", "lossless"],
      ["a", "hq"],
      ["b", "hq"],
      ["c", "hq"],
    ]);
    expect(status.currentSource).toBe("https://plugin/a.flac");
    expect(mocks.play).toHaveBeenCalledOnce();
  });

  it("内置源加载失败后仍能回到已验证可播放的候选", async () => {
    mocks.playerSettings.songLevel = "hi-res";
    qualities.c = mp3;
    const load = mocks.load.getMockImplementation()!;
    mocks.load.mockImplementation((url, options) =>
      url === newUrl
        ? Promise.resolve({ success: false, error: "NETWORK_ERROR" })
        : load(url, options),
    );
    await player.playAtIndex(1);
    expect(status.currentSource).toBe("https://plugin/b.flac");
    expect(mocks.play).toHaveBeenCalledOnce();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it.each(["暂停", "停止"])("换源期间手动%s不被迟到结果恢复播放", async (action) => {
    let finish!: (result: unknown) => void;
    mocks.pluginResolve.mockImplementation(({ pluginId }) =>
      pluginId === "b"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({ url: `https://plugin/${pluginId}.flac` }),
    );
    const loading = player.playAtIndex(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.load).toHaveBeenCalledOnce();
    if (action === "暂停") await player.pause();
    else await player.stop();
    finish({ url: "https://plugin/b.flac" });
    await loading;
    expect(mocks.play).not.toHaveBeenCalled();
    expect(status.state).toBe(action === "暂停" ? "paused" : "stopped");
    expect(mocks.load).toHaveBeenCalledTimes(action === "暂停" ? 4 : 1);
  });
});

describe("在线歌曲暂停后地址失效恢复", () => {
  it("暂停数小时后恢复，重新获取官方地址并从原进度续播当前歌曲", async () => {
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(playback.getCurrentTime()).toBe(resumePosition);
    expect(mocks.request).not.toHaveBeenCalled();

    await player.play();
    let finish!: (result: unknown) => void;
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const recovery = events.handleEvent({ type: "sourceError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(status.trackLoading).toBe(true);
    await events.handleEvent({
      type: "status",
      data: {
        state: "stopped",
        position: resumePosition,
        duration: 180000,
        volume: 1,
        speed: 1,
        isFinished: false,
      },
    });
    finish({ data: [{ url: newUrl, freeTrialInfo: null }] });
    await recovery;

    expect(mocks.request).toHaveBeenCalledExactlyOnceWith(
      "song_url",
      { id: "current", level: "exhigh" },
      { notifyAuthFailure: false },
    );
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
      newUrl,
      expect.objectContaining({ autoPlay: false }),
    );
    expect(mocks.seek).toHaveBeenCalledExactlyOnceWith(resumePosition);
    expect(mocks.load.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.seek.mock.invocationCallOrder[0]!,
    );
    expect(mocks.seek.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.play.mock.invocationCallOrder[1]!,
    );
    expect(mocks.play).toHaveBeenCalledTimes(2);
    expect(media.track?.id).toBe("current");
    expect(status.playIndex).toBe(0);
    expect(status.currentSource).toBe(newUrl);
    expect(status.state).toBe("playing");
    expect(status.position).toBe(resumePosition);
    expect(playback.getCurrentTime()).toBe(resumePosition);
    expect(status.trackLoading).toBe(false);
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("保持暂停时收到源失效，刷新地址和进度但不自动播放", async () => {
    await events.handleEvent({ type: "sourceError" });
    expect(status.state).toBe("paused");
    expect(status.position).toBe(resumePosition);
    expect(media.track?.id).toBe("current");
    expect(mocks.seek).toHaveBeenCalledExactlyOnceWith(resumePosition);
    expect(mocks.play).not.toHaveBeenCalled();
  });

  it.each([false, true])("重新取址仍无音源时只跳一首，恢复播放=%s", async (resume) => {
    if (resume) await player.play();
    mocks.request.mockResolvedValueOnce({ data: [{ url: null, fee: 0 }] });
    await events.handleEvent({ type: "sourceError" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(media.track?.id).toBe("next");
    expect(status.state).toBe(resume ? "playing" : "paused");
    expect(mocks.request.mock.calls.map((call) => call[1].id)).toEqual(["current", "next"]);
    expect(mocks.seek).not.toHaveBeenCalled();
  });

  it.each(["停止", "切歌"])("取址期间手动%s，旧地址返回后不复活旧歌曲", async (action) => {
    await player.play();
    let finish!: (result: unknown) => void;
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const recovery = events.handleEvent({ type: "sourceError" });
    await vi.advanceTimersByTimeAsync(0);
    if (action === "停止") await player.stop();
    else await player.nextTrack();
    mocks.load.mockClear();
    mocks.play.mockClear();
    finish({ data: [{ url: newUrl, freeTrialInfo: null }] });
    await recovery;
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.seek).not.toHaveBeenCalled();
    expect(mocks.play).not.toHaveBeenCalled();
    expect(status.state).toBe(action === "停止" ? "stopped" : "playing");
    expect(media.track?.id).toBe(action === "停止" ? "current" : "next");
  });

  it("恢复进度期间手动停止，迟到的 seek 响应不能重新播放", async () => {
    await player.play();
    let finish!: (result: unknown) => void;
    mocks.seek.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const recovery = events.handleEvent({ type: "sourceError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.seek).toHaveBeenCalledOnce();
    await player.stop();
    mocks.load.mockClear();
    mocks.play.mockClear();
    finish({ success: true });
    await recovery;
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.play).not.toHaveBeenCalled();
    expect(status.state).toBe("stopped");
  });

  it.each([false, true])("重新取址期间用户暂停，音源可用=%s 时仍保持暂停", async (available) => {
    await player.play();
    let finish!: (result: unknown) => void;
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const recovery = events.handleEvent({ type: "sourceError" });
    await vi.advanceTimersByTimeAsync(0);
    await player.pause();
    mocks.play.mockClear();
    finish({ data: [{ url: available ? newUrl : null, freeTrialInfo: null }] });
    await recovery;
    expect(mocks.play).not.toHaveBeenCalled();
    expect(status.state).toBe("paused");
    expect(status.position).toBe(available ? resumePosition : 0);
    expect(media.track?.id).toBe(available ? "current" : "next");
  });
});
