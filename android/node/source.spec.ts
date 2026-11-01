import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import type { Track } from "@shared/types/player";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  postNative: vi.fn(),
  events: new Map<string, (value?: string) => void>(),
}));
vi.mock("./bridge", () => ({
  invokeNative: vi.fn(),
  postNative: mocks.postNative,
  setInvokeHandler: vi.fn(),
  nativeEvents: {
    on: (event: string, handler: (value?: string) => void) => mocks.events.set(event, handler),
  },
}));
vi.mock("@/services/onlineSource", () => ({ resolvePlaybackOnline: mocks.resolve }));
vi.mock("@/apis/login/netease", () => ({ fetchLoginStatus: vi.fn() }));
vi.mock("@/apis/netease", () => ({ NeteaseApiError: class extends Error {} }));
vi.mock("@/apis/neteaseAuth", () => ({ isExplicitNeteaseAuthFailure: vi.fn() }));
vi.mock("@main/apis/netease", () => ({
  clearNeteaseCookies: vi.fn(),
  getNeteaseCookies: () => ({}),
}));
vi.mock("@main/plugins/registry", () => ({
  pluginRegistry: { listInfo: () => [], init: vi.fn() },
}));
vi.mock("@main/plugins/router", () => ({ resolveUrl: vi.fn() }));
vi.mock("@main/store", () => ({ store: { get: vi.fn() } }));
vi.mock("@main/utils/broadcast", () => ({ broadcast: vi.fn() }));
vi.mock("@main/database", () => ({ initDatabase: vi.fn(), searchTracks: vi.fn() }));
vi.mock("@main/services/music/onlineSearch", () => ({ searchOnlineTracks: vi.fn() }));
vi.mock("@main/ipc/apis", () => ({ registerApisIpc: vi.fn() }));
vi.mock("@main/ipc/comments", () => ({ registerCommentsIpc: vi.fn() }));
vi.mock("@main/ipc/lyrics", () => ({ registerLyricsIpc: vi.fn() }));
vi.mock("@main/ipc/nowPlaying", () => ({ registerNowPlayingIpc: vi.fn() }));
vi.mock("@main/ipc/playlist", () => ({ registerPlaylistIpc: vi.fn() }));
vi.mock("@main/ipc/plugin", () => ({ registerPluginIpc: vi.fn() }));
vi.mock("@main/ipc/stats", () => ({ registerStatsIpc: vi.fn() }));
vi.mock("@main/plugins/playbackBridge", () => ({ init: vi.fn() }));
vi.mock("@main/utils/i18n", () => ({ setLocale: vi.fn() }));
vi.mock("@main/utils/logger", () => ({
  coreLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./history", () => ({ initNativeHistory: vi.fn() }));
vi.mock("./playerControl", () => ({ applyPlaybackSnapshot: vi.fn() }));
vi.mock("@/apis/recommend/netease", () => ({ fetchPersonalFm: vi.fn(), submitFmTrash: vi.fn() }));
vi.mock("@/apis/search", () => ({ searchSongs: vi.fn() }));
import { dispatch } from "./runtime/ipc";

const consoleMethods = { ...console };
const rejectionListeners = new Set(process.listeners("unhandledRejection"));

beforeAll(async () => {
  const dlopen = vi.spyOn(process, "dlopen").mockImplementation(() => {});
  const argumentsBefore = process.argv;
  process.argv = ["node", "/app/start.cjs", "/app", "/app/lib", "test"];
  try {
    await import("./index");
    expect(mocks.postNative).toHaveBeenCalledWith({ type: "ready" });
  } finally {
    dlopen.mockRestore();
    process.argv = argumentsBefore;
    Object.assign(console, consoleMethods);
  }
});

afterAll(() => {
  for (const listener of process.listeners("unhandledRejection")) {
    if (!rejectionListeners.has(listener)) process.off("unhandledRejection", listener);
  }
});

const track: Track = {
  id: "song",
  title: "爱",
  artists: [{ name: "莫文蔚" }],
  source: "netease",
  duration: 300000,
};
const preferences = { preferPluginSource: true, allowTrialPlay: false };
const resolved = { ok: true, url: "https://music.example/song", provider: "plugin", pluginId: "a" };

beforeEach(() => {
  mocks.events.get("android:serviceStopped")?.();
  mocks.resolve.mockReset();
});

describe("车机选源 IPC 入口", () => {
  it("旧偏好在入口补齐默认值", async () => {
    mocks.resolve.mockResolvedValue(resolved);
    await dispatch("android:resolve", [track, "hq", preferences, "default"]);
    expect(mocks.resolve.mock.calls[0][0].getSettings()).toEqual({
      ...preferences,
      verifySourceArtist: false,
      verifySourceDuration: true,
    });
  });

  it.each([
    [true, false],
    [false, true],
    [true, true],
    [false, false],
  ])("歌手校验 %s、时长校验 %s 穿过入口后仍保留原值", async (artist, duration) => {
    mocks.resolve.mockResolvedValue(resolved);
    const settings = { ...preferences, verifySourceArtist: artist, verifySourceDuration: duration };
    await dispatch("android:resolve", [track, "hq", settings, "explicit"]);
    expect(mocks.resolve.mock.calls[0][0].getSettings()).toEqual(settings);
  });

  it("拒绝非布尔开关，不把非法输入当作默认设置", () => {
    expect(() =>
      dispatch("android:resolve", [
        track,
        "hq",
        { ...preferences, verifySourceArtist: "true" },
        "invalid",
      ]),
    ).toThrow();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("预载不取消当前找源，取消其中一个请求不影响另一个", async () => {
    const finish: Array<(value: typeof resolved) => void> = [];
    mocks.resolve.mockImplementation(() => new Promise((done) => finish.push(done)));
    const current = dispatch("android:resolve", [track, "hq", preferences, "current"]);
    const preload = dispatch("android:resolve", [
      { ...track, id: "next" },
      "hq",
      preferences,
      "next",
    ]);
    const cancelled = expect(preload).rejects.toThrow("音源解析已取消");
    await flushPromises();
    const signals = mocks.resolve.mock.calls.map((args) => args[4].signal as AbortSignal);
    expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);
    mocks.events.get("android:cancelSource")!("next");
    expect(signals.map((signal) => signal.aborted)).toEqual([false, true]);
    finish.forEach((done) => done(resolved));
    await expect(current).resolves.toMatchObject({ url: resolved.url });
    await cancelled;
  });

  it("服务停止时取消全部在途选源，迟到结果不能恢复播放", async () => {
    const finish: Array<(value: typeof resolved) => void> = [];
    mocks.resolve.mockImplementation(() => new Promise((done) => finish.push(done)));
    const requests = ["current", "next"].map((id) =>
      dispatch("android:resolve", [track, "hq", preferences, id]),
    );
    const cancelled = requests.map((request) => expect(request).rejects.toThrow("音源解析已取消"));
    await flushPromises();
    mocks.events.get("android:serviceStopped")!();
    expect(mocks.resolve.mock.calls.every((args) => args[4].signal.aborted)).toBe(true);
    finish.forEach((done) => done(resolved));
    await Promise.all(cancelled);
  });
});
