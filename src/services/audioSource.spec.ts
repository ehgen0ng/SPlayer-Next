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
  pluginResolve: vi.fn(),
  plugins: [] as PluginInfo[],
  settings: {
    player: { songLevel: "hq", allowTrialPlay: false, preferPluginSource: false },
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
  mocks.pluginResolve.mockReset();
  mocks.plugins = [];
  mocks.settings.player.preferPluginSource = false;
  mocks.settings.player.allowTrialPlay = false;
  mocks.settings.system.cache.songCache.enabled = false;
  Object.assign(window, {
    api: {
      download: { lookup: mocks.lookup },
      cache: { song: { lookup: mocks.cacheLookup } },
      plugins: { resolveUrl: mocks.pluginResolve },
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

  it("双方失败时不重复调用已尝试插件并保留内置错误", async () => {
    mocks.pluginResolve.mockRejectedValueOnce(new Error("unavailable"));
    mocks.qqmusic.mockResolvedValueOnce({ available: false, errorCode: ErrorCode.NETWORK_ERROR });
    const onError = vi.fn();
    expect(await resolveTrackSource(track, { silent: true, onError })).toBeNull();
    expect(mocks.pluginResolve).toHaveBeenCalledOnce();
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

  it.each([false, true])("插件失败后仍遵守试听开关：%s", async (allowTrialPlay) => {
    mocks.settings.player.allowTrialPlay = allowTrialPlay;
    mocks.pluginResolve.mockResolvedValueOnce({ url: "" });
    mocks.netease.mockResolvedValueOnce({
      available: true,
      url: "https://official/trial",
      isTrial: true,
    });
    const result = await resolveTrackSource({ ...track, source: "netease" }, { silent: true });
    if (allowTrialPlay) expect(result).toMatchObject({ provider: "trial" });
    else expect(result).toBeNull();
    expect(mocks.pluginResolve).toHaveBeenCalledOnce();
  });

  it.each(["download", "cache"])("开启插件优先仍先播放 %s", async (provider) => {
    mocks.settings.system.cache.songCache.enabled = true;
    (provider === "download" ? mocks.lookup : mocks.cacheLookup).mockResolvedValueOnce(
      "C:/song.flac",
    );
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
      mocks[source].mockRejectedValueOnce(new Error("fetch failed"));
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
