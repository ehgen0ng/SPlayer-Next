import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioQuality, Track } from "@shared/types/player";
import type { PluginInfo } from "@shared/types/plugin";

const mocks = vi.hoisted(() => ({
  settings: { player: { preferPluginSource: true } },
  plugins: [] as PluginInfo[],
  resolve: vi.fn(),
  probe: vi.fn(),
  official: vi.fn(),
  netease: vi.fn(),
}));
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => mocks.settings }));
vi.mock("@/stores/plugins", () => ({
  usePluginsStore: () => ({ list: mocks.plugins, orderedList: mocks.plugins }),
}));
vi.mock("@/stores/user", () => ({ useUserStore: vi.fn() }));
vi.mock("@/apis/song/netease", () => ({
  resolveNeteaseDownloadUrl: mocks.netease,
  resolveNeteaseUrl: vi.fn(),
}));
vi.mock("@/apis/song/qqmusic", () => ({ resolveQQMusicUrl: mocks.official }));
vi.mock("@/apis/song/kugou", () => ({ resolveKugouUrl: mocks.official }));
vi.mock("@/utils/errors", () => ({ handleError: vi.fn() }));
import { resolveDownloadSource } from "./source";

const track: Track = {
  id: "song",
  source: "qqmusic",
  title: "雨爱",
  artists: [],
  duration: 260480,
};
const lossless: AudioQuality = {
  codec: "flac",
  sampleRate: 44100,
  bitsPerSample: 16,
  channels: 2,
  bitRate: 1033000,
};
const hires: AudioQuality = { ...lossless, sampleRate: 96000, bitsPerSample: 24, bitRate: 2800000 };
let qualities: Record<string, AudioQuality>;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.settings.player.preferPluginSource = true;
  qualities = { a: lossless, b: { ...lossless, channels: 6, bitRate: 2595000 }, c: lossless };
  mocks.plugins = ["a", "b", "c"].map((id) => ({
    manifest: {
      id,
      name: id,
      version: "1",
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
        tx: { name: "QM", actions: ["musicUrl"] },
        wy: { name: "NCM", actions: ["musicUrl"] },
        kg: { name: "KG", actions: ["musicUrl"] },
      },
    },
  }));
  mocks.resolve.mockImplementation(async ({ pluginId }) => ({
    url: `https://music.example/${pluginId}`,
  }));
  mocks.probe.mockImplementation(async (url: string) => ({
    success: true,
    data: qualities[url.split("/").at(-1)!],
  }));
  mocks.official.mockResolvedValue({ available: false });
  mocks.netease.mockResolvedValue(null);
  Object.assign(window, {
    api: { plugins: { resolveUrl: mocks.resolve }, player: { probeSource: mocks.probe } },
  });
});

describe("下载复用播放选源规则", () => {
  it("比较全部无损候选后选择码率最高者，保留原始六声道参数", async () => {
    const result = await resolveDownloadSource(track, "lossless", false);
    expect(result).toEqual({
      url: "https://music.example/b",
      pluginId: "b",
      format: "flac",
      quality: qualities.b,
    });
    expect(mocks.resolve.mock.calls.map(([args]) => args.pluginId)).toEqual(["a", "b", "c"]);
    expect(mocks.official).not.toHaveBeenCalled();
  });

  it("实际 Hi-Res 优先于码率更高的普通无损", async () => {
    qualities.a = { ...hires, bitRate: 2000000 };
    expect((await resolveDownloadSource(track, "hi-res", false))?.quality).toEqual(qualities.a);
    expect(mocks.resolve).toHaveBeenCalledTimes(3);
  });

  it("Hi-Res 返回普通无损时，降一级重新尝试所有插件并比较码率", async () => {
    const result = await resolveDownloadSource(track, "hi-res", false);
    expect(result?.url).toBe("https://music.example/b");
    expect(mocks.resolve.mock.calls.map(([args]) => [args.pluginId, args.quality])).toEqual([
      ["a", "hi-res"],
      ["b", "hi-res"],
      ["c", "hi-res"],
      ["a", "lossless"],
      ["b", "lossless"],
      ["c", "lossless"],
    ]);
  });

  it("每档接口全部失败后逐档降低，直至找到 HQ", async () => {
    qualities = {
      a: { ...lossless, codec: "mp3", bitRate: 320000 },
      b: { ...lossless, codec: "mp3", bitRate: 128000 },
      c: { ...lossless, codec: "mp3", bitRate: 192000 },
    };
    mocks.resolve.mockImplementation(async ({ pluginId, quality }) => {
      if (quality !== "hq") throw new Error("unsupported");
      return { url: `https://music.example/${pluginId}` };
    });
    expect((await resolveDownloadSource(track, "hi-res", false))?.url).toBe(
      "https://music.example/a",
    );
    expect(mocks.resolve.mock.calls.map(([args]) => args.quality)).toEqual([
      "hi-res",
      "hi-res",
      "hi-res",
      "lossless",
      "lossless",
      "lossless",
      "hq",
      "hq",
      "hq",
    ]);
  });

  it("无效文件和接口异常不会阻止其他候选", async () => {
    mocks.resolve.mockImplementation(async ({ pluginId }) => {
      if (pluginId === "a") throw new Error("offline");
      return { url: `https://music.example/${pluginId}` };
    });
    mocks.probe
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: true, data: lossless });
    expect((await resolveDownloadSource(track, "lossless", false))?.url).toBe(
      "https://music.example/c",
    );
  });

  it("码率相同保留插件顺序，未知码率不抢占已知码率", async () => {
    qualities = { a: lossless, b: lossless, c: { ...lossless, bitRate: 0 } };
    expect((await resolveDownloadSource(track, "lossless", false))?.url).toBe(
      "https://music.example/a",
    );
  });

  it("关闭插件优先时保留官方优先和网易下载接口语义", async () => {
    mocks.settings.player.preferPluginSource = false;
    mocks.netease.mockResolvedValue({
      url: "https://music.example/official",
      size: 1234,
      format: "flac",
    });
    expect(await resolveDownloadSource({ ...track, source: "netease" }, "lossless", true)).toEqual({
      url: "https://music.example/official",
      size: 1234,
      format: "flac",
    });
    expect(mocks.netease).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ source: "netease" }),
      "lossless",
      true,
    );
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it("取消后停止下一插件尝试，不采用迟到探测结果", async () => {
    const controller = new AbortController();
    mocks.probe.mockImplementationOnce(async () => {
      controller.abort();
      return { success: true, data: hires };
    });
    expect(await resolveDownloadSource(track, "hi-res", false, controller.signal)).toBeNull();
    expect(mocks.resolve).toHaveBeenCalledOnce();
    expect(mocks.official).not.toHaveBeenCalled();
  });

  it("流媒体仍由主进程获取原文件，不调用在线插件", async () => {
    expect(
      await resolveDownloadSource(
        { ...track, source: "streaming", serverId: "server", originalId: "original" },
        "hi-res",
        false,
      ),
    ).toEqual({ url: "streaming://server/original" });
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("取消发生在插件取址失败时，也不会继续调用第二个插件", async () => {
    const controller = new AbortController();
    mocks.resolve.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error("offline");
    });
    expect(await resolveDownloadSource(track, "hi-res", false, controller.signal)).toBeNull();
    expect(mocks.resolve).toHaveBeenCalledOnce();
    expect(mocks.probe).not.toHaveBeenCalled();
  });
});
