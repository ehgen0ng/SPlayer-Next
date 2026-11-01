import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@shared/types/player";
import type { PluginInfo } from "@shared/types/plugin";
import { ErrorCode } from "@shared/types/errors";

const mocks = vi.hoisted(() => ({
  netease: vi.fn(),
  qqmusic: vi.fn(),
  kugou: vi.fn(),
  error: vi.fn(),
  lookup: vi.fn(),
  cacheLookup: vi.fn(),
  cacheFetch: vi.fn(),
  pluginResolve: vi.fn(),
  probe: vi.fn(),
  plugins: [] as PluginInfo[],
  settings: {
    player: {
      songLevel: "hq",
      allowTrialPlay: false,
      preferPluginSource: false,
      verifySourceArtist: false,
      verifySourceDuration: false,
    },
    system: { cache: { songCache: { enabled: false } } },
  },
}));
vi.mock("@/stores/settings", () => ({
  useSettingsStore: () => mocks.settings,
}));
vi.mock("@/stores/plugins", () => ({
  usePluginsStore: () => ({ list: mocks.plugins, orderedList: mocks.plugins }),
}));
vi.mock("@/stores/user", () => ({ useUserStore: () => ({ isLoggedIn: false }) }));
vi.mock("@/apis/song/netease", () => ({ resolveNeteaseUrl: mocks.netease }));
vi.mock("@/apis/song/qqmusic", () => ({ resolveQQMusicUrl: mocks.qqmusic }));
vi.mock("@/apis/song/kugou", () => ({ resolveKugouUrl: mocks.kugou }));
vi.mock("@/utils/errors", () => ({ handleError: mocks.error }));
import { resolveTrackSource } from "./audioSource";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lookup.mockReset().mockResolvedValue(null);
  mocks.cacheLookup.mockReset().mockResolvedValue(null);
  mocks.cacheFetch.mockReset().mockResolvedValue("C:/cache/lossless.bin");
  mocks.pluginResolve.mockReset();
  mocks.probe.mockReset().mockResolvedValue({
    success: true,
    data: { codec: "flac", sampleRate: 96000, bitsPerSample: 24, channels: 2, bitRate: 3000000 },
  });
  mocks.plugins = [];
  mocks.settings.player.preferPluginSource = false;
  mocks.settings.player.allowTrialPlay = false;
  mocks.settings.player.verifySourceArtist = false;
  mocks.settings.player.verifySourceDuration = false;
  mocks.settings.system.cache.songCache.enabled = false;
  Object.assign(window, {
    api: {
      download: { lookup: mocks.lookup },
      cache: { song: { lookup: mocks.cacheLookup, fetch: mocks.cacheFetch } },
      plugins: { resolveUrl: mocks.pluginResolve },
      player: { probeSource: mocks.probe },
    },
  });
});

describe("优先播放下载文件", () => {
  it("远端流媒体只返回身份占位符，凭据和播放会话由主进程解析", async () => {
    const result = await resolveTrackSource({
      id: "server:remote",
      source: "streaming",
      serverId: "server",
      originalId: "remote",
      title: "歌曲",
      artists: [],
      duration: 1000,
    });
    expect(result?.source).toBe("streaming://server/remote");
  });
  it("命中下载后跳过缓存和在线地址解析", async () => {
    mocks.settings.system.cache.songCache.enabled = true;
    mocks.lookup.mockResolvedValueOnce("C:/downloads/song.flac");
    const track: Track = { id: "1", title: "test", source: "netease", artists: [], duration: 1000 };
    expect(await resolveTrackSource(track)).toEqual({
      source: "C:/downloads/song.flac",
      fromCache: false,
      provider: "download",
    });
    expect(mocks.lookup).toHaveBeenCalledExactlyOnceWith({ source: "netease", id: "1" });
    expect(mocks.cacheLookup).not.toHaveBeenCalled();
    expect(mocks.netease).not.toHaveBeenCalled();
  });

  it("流媒体下载按服务器身份查询，并跳过远端地址解析", async () => {
    mocks.lookup.mockResolvedValueOnce("C:/downloads/stream.flac");
    await resolveTrackSource({
      id: "song",
      source: "streaming",
      serverId: "server",
      originalId: "remote",
      title: "stream",
      artists: [],
      duration: 1000,
    });
    expect(mocks.lookup).toHaveBeenCalledExactlyOnceWith({
      source: "streaming",
      id: "song",
      serverId: "server",
      originalId: "remote",
    });
  });

  it("下载查询异常时继续在线解析", async () => {
    mocks.lookup.mockRejectedValueOnce(new Error("database error"));
    mocks.netease.mockResolvedValueOnce({
      available: true,
      url: "https://music/song",
      isTrial: false,
    });
    const result = await resolveTrackSource({
      id: "1",
      source: "netease",
      title: "test",
      artists: [],
      duration: 1000,
    });
    expect(result?.source).toBe("https://music/song");
    expect(mocks.netease).toHaveBeenCalledOnce();
  });
});

describe("插件音源优先级", () => {
  const track: Track = {
    id: "song-mid",
    source: "qqmusic",
    title: "歌曲",
    artists: [],
    duration: 1000,
  };
  beforeEach(() => {
    mocks.settings.player.preferPluginSource = true;
    mocks.plugins = [
      {
        manifest: {
          id: "audio",
          name: "音源",
          version: "1.0.0",
          grant: [],
          apiLevel: 1,
          hash: "test",
          installedAt: 0,
          fileName: "audio.js",
        },
        enabled: true,
        status: {
          state: "ready",
          sources: {
            tx: { name: "QM", actions: ["musicUrl"] },
            wy: { name: "NCM", actions: ["musicUrl"] },
            kg: { name: "KG", actions: ["musicUrl"] },
          },
        },
      },
    ];
    mocks.pluginResolve.mockResolvedValue({ url: "https://plugin/song" });
    for (const source of ["netease", "qqmusic", "kugou"] as const) {
      mocks[source]
        .mockReset()
        .mockResolvedValue({ available: true, url: "https://official/song", isTrial: false });
    }
  });

  it.each(["netease", "qqmusic", "kugou"] as const)(
    "%s 开启后优先使用插件并传递所选音质",
    async (source) => {
      expect(await resolveTrackSource({ ...track, source })).toMatchObject({
        provider: "plugin",
        source: "https://plugin/song",
        pluginId: "audio",
      });
      expect(mocks.pluginResolve).toHaveBeenCalledWith(expect.objectContaining({ quality: "hq" }));
      expect(mocks[source]).not.toHaveBeenCalled();
    },
  );

  it("QM 高音质请求保留歌曲标识并传递独立的媒体文件标识", async () => {
    await resolveTrackSource({ ...track, mediaId: "media-mid" }, { quality: "hi-res" });
    expect(mocks.pluginResolve).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        source: "tx",
        quality: "hi-res",
        musicInfo: expect.objectContaining({
          id: "song-mid",
          songmid: "song-mid",
          songId: "song-mid",
          strMediaMid: "media-mid",
          mediaMid: "media-mid",
          media_mid: "media-mid",
        }),
      }),
    );
  });

  it("预载降级结果按实际音质写缓存，不污染 Hi-Res 缓存键", async () => {
    mocks.settings.system.cache.songCache.enabled = true;
    const resolved = await resolveTrackSource(track, { quality: "hi-res" });
    await resolved?.cacheRequest?.("slot", undefined, "lossless");
    expect(mocks.cacheFetch).toHaveBeenCalledExactlyOnceWith(
      "o:qqmusic:v2:song-mid:lossless",
      "qqmusic",
      "https://plugin/song",
      "slot",
      undefined,
    );
  });

  it("后台继续比较候选时跳过已确认未命中的下载和缓存查询", async () => {
    mocks.settings.system.cache.songCache.enabled = true;
    await resolveTrackSource(track, { skipDownloaded: true, skipCache: true });
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.cacheLookup).not.toHaveBeenCalled();
    expect(mocks.pluginResolve).toHaveBeenCalledOnce();
  });

  it.each(["netease", "qqmusic", "kugou"] as const)("%s 关闭后保持内置接口优先", async (source) => {
    mocks.settings.player.preferPluginSource = false;
    expect(await resolveTrackSource({ ...track, source })).toMatchObject({ provider: "official" });
    expect(mocks.pluginResolve).not.toHaveBeenCalled();
  });

  it.each(["无插件", "插件禁用", "插件异常", "无地址"])("%s 时继续使用内置接口", async (reason) => {
    if (reason === "无插件") mocks.plugins = [];
    if (reason === "插件禁用") mocks.plugins[0].enabled = false;
    if (reason === "插件异常") mocks.pluginResolve.mockRejectedValueOnce(new Error("unavailable"));
    if (reason === "无地址") mocks.pluginResolve.mockResolvedValueOnce({ url: "" });
    expect(await resolveTrackSource(track)).toMatchObject({ provider: "official" });
    expect(mocks.qqmusic).toHaveBeenCalledOnce();
  });

  it("双方失败时每档仅调用插件一次，并保留内置错误", async () => {
    mocks.pluginResolve.mockRejectedValue(new Error("unavailable"));
    mocks.qqmusic.mockResolvedValue({ available: false, errorCode: ErrorCode.NETWORK_ERROR });
    const onError = vi.fn();
    expect(await resolveTrackSource(track, { silent: true, onError })).toBeNull();
    expect(mocks.pluginResolve.mock.calls.map(([args]) => args.quality)).toEqual([
      "hq",
      "sq",
      "lq",
    ]);
    expect(onError).toHaveBeenCalledWith(ErrorCode.NETWORK_ERROR);
  });

  it("重试时跳过已失败插件并继续内置解析", async () => {
    expect(await resolveTrackSource(track, { skipPluginIds: ["audio"] })).toMatchObject({
      provider: "official",
    });
    expect(mocks.pluginResolve).not.toHaveBeenCalled();
  });

  it("内置失败后仍可通过插件回退", async () => {
    mocks.settings.player.preferPluginSource = false;
    mocks.qqmusic.mockResolvedValueOnce({
      available: false,
      errorCode: ErrorCode.URL_RESOLVE_FAILED,
    });
    expect(await resolveTrackSource(track)).toMatchObject({ provider: "plugin" });
    expect(mocks.qqmusic).toHaveBeenCalledOnce();
  });

  it.each(["verifySourceArtist", "verifySourceDuration"] as const)(
    "播放按 %s 开关排除不符插件，关闭时仍按音质择优",
    async (setting) => {
      const song = { ...track, title: "爱", artists: [{ name: "莫文蔚" }], duration: 300000 };
      mocks.probe.mockResolvedValue({
        success: true,
        data: {
          codec: "flac",
          sampleRate: 96000,
          bitsPerSample: 24,
          channels: 2,
          bitRate: 3000000,
          artist: "其他歌手",
          duration: 200000,
        },
      });
      expect(await resolveTrackSource(song)).toMatchObject({ provider: "plugin" });
      mocks.settings.player[setting] = true;
      expect(await resolveTrackSource(song)).toMatchObject({ provider: "official" });
      expect(mocks.pluginResolve).toHaveBeenLastCalledWith(
        expect.objectContaining({
          musicInfo: expect.objectContaining({ singer: "莫文蔚", interval: "05:00" }),
        }),
      );
    },
  );

  describe.each(["netease", "qqmusic"] as const)("%s 试听回退", (source) => {
    it.each([
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ])(
      "插件优先 %s、允许试听 %s 时遵守权限并豁免完整时长校验",
      async (preferPlugin, allowTrial) => {
        mocks.settings.player.preferPluginSource = preferPlugin;
        mocks.settings.player.allowTrialPlay = allowTrial;
        mocks.settings.player.verifySourceDuration = true;
        mocks.settings.system.cache.songCache.enabled = true;
        mocks.pluginResolve.mockResolvedValue({ url: "" });
        mocks.probe.mockResolvedValue({
          success: true,
          data: { codec: "mp3", bitRate: 128000, duration: 60000 },
        });
        mocks[source].mockResolvedValue({
          available: true,
          url: "https://official/RS02trial.mp3",
          isTrial: true,
        });
        const result = await resolveTrackSource(
          { ...track, source, duration: 269000 },
          { silent: true },
        );
        if (allowTrial) {
          expect(result).toMatchObject({ provider: "trial" });
          expect(result?.cacheRequest).toBeUndefined();
        } else expect(result).toBeNull();
        expect(mocks.probe).not.toHaveBeenCalled();
        expect(mocks.pluginResolve).toHaveBeenCalledTimes(preferPlugin ? 3 : 1);
      },
    );
  });

  it("QQ 试听不会抢占较低音质的完整插件音源", async () => {
    mocks.settings.player.allowTrialPlay = true;
    mocks.settings.player.verifySourceDuration = true;
    mocks.qqmusic.mockResolvedValue({
      available: true,
      url: "https://official/RS02trial.mp3",
      isTrial: true,
    });
    mocks.pluginResolve.mockImplementation(async ({ quality }) => ({
      url: quality === "sq" ? "https://plugin/full.mp3" : "",
    }));
    mocks.probe.mockResolvedValue({
      success: true,
      data: {
        codec: "mp3",
        sampleRate: 44100,
        bitsPerSample: 16,
        channels: 2,
        bitRate: 128000,
        duration: 269000,
      },
    });
    expect(await resolveTrackSource({ ...track, duration: 269000 })).toMatchObject({
      provider: "plugin",
      source: "https://plugin/full.mp3",
    });
    expect(mocks.probe).toHaveBeenCalledExactlyOnceWith("https://plugin/full.mp3");
  });

  it.each(["download", "cache"])("开启插件优先仍先播放 %s", async (provider) => {
    mocks.settings.system.cache.songCache.enabled = true;
    (provider === "download" ? mocks.lookup : mocks.cacheLookup).mockResolvedValue("C:/song.flac");
    expect(await resolveTrackSource(track)).toMatchObject({ provider, source: "C:/song.flac" });
    expect(mocks.pluginResolve).not.toHaveBeenCalled();
    expect(mocks.qqmusic).not.toHaveBeenCalled();
  });
});

describe("音源解析失败原因", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it.each(["netease", "qqmusic", "kugou"] as const)(
    "%s API 异常不会被无插件覆盖",
    async (source) => {
      mocks[source].mockRejectedValue(new Error("fetch failed"));
      const onError = vi.fn();
      const track: Track = { id: "1", title: "test", source, artists: [], duration: 1000 };
      expect(await resolveTrackSource(track, { silent: true, onError })).toBeNull();
      expect(onError).toHaveBeenCalledExactlyOnceWith(ErrorCode.NETWORK_ERROR);
      expect(mocks.error).not.toHaveBeenCalled();
    },
  );
  it("歌曲无版权仍保留单曲错误", async () => {
    mocks.netease.mockResolvedValueOnce({
      available: false,
      errorCode: ErrorCode.NETEASE_UNAVAILABLE,
    });
    await resolveTrackSource({
      id: "1",
      title: "test",
      source: "netease",
      artists: [],
      duration: 1000,
    });
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith(ErrorCode.NETEASE_UNAVAILABLE);
  });
});
