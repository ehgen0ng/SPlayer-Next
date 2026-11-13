// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { createHash } from "node:crypto";

const mocks = vi.hoisted(() => ({
  channel: "stable",
  autoCheck: true,
  localCode: 1,
  handlers: new Map<string, (...args: any[]) => any>(),
  native: vi.fn(),
  broadcast: vi.fn(),
  download: vi.fn(),
}));
vi.mock("@main/store", () => ({
  store: { get: (key: string) => (key === "update.channel" ? mocks.channel : mocks.autoCheck) },
}));
vi.mock("./runtime/ipc", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) =>
      mocks.handlers.set(channel, handler),
  },
}));
vi.mock("./runtime/broadcast", () => ({ broadcast: mocks.broadcast }));
vi.mock("./runtime/logger", () => ({ coreLog: { error: vi.fn() } }));
vi.mock("./bridge", () => ({ invokeNative: mocks.native }));
vi.mock("@main/services/updateDownload", () => ({ downloadUpdateFile: mocks.download }));

const base = "https://github.com/ehgen0ng/SPlayer-Next/releases";
const manifest = {
  version: "2.0.0",
  versionCode: 20000999,
  abi: "arm64-v8a",
  file: "SPlayer-Next-2.0.0-android-arm64-v8a-release.apk",
  sha512: createHash("sha512").update("apk").digest("base64"),
  size: 3,
};
const release = {
  tag_name: "v2.0.0",
  draft: false,
  prerelease: false,
  body: "新版说明",
  published_at: "2026-11-13",
  assets: ["latest-android.json", "beta-android.json", manifest.file].map((name) => ({
    name,
    browser_download_url: `${base}/download/v2.0.0/${name}`,
  })),
};

/**
 * 使用与 WebView 一致的通道执行更新操作
 * @param channel - 更新 API 通道
 * @param args - 调用参数
 * @returns 后台即时状态
 */
const invoke = (channel: string, ...args: unknown[]) =>
  mocks.handlers.get(channel)!(undefined, ...args);

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  mocks.handlers.clear();
  mocks.channel = "stable";
  mocks.autoCheck = true;
  mocks.localCode = 1;
  mocks.native.mockImplementation(async (channel: string) =>
    channel === "android:updateInfo"
      ? {
          versionCode: mocks.localCode,
          abis: ["arm64-v8a"],
          apkPath: "/private/tmp/splayer-test.apk",
        }
      : false,
  );
  mocks.download.mockReset().mockResolvedValue("/private/tmp/splayer-test.apk");
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(async (url: string) =>
        Response.json(
          url.includes("api.github.com")
            ? url.endsWith("/latest")
              ? release
              : [release]
            : manifest,
        ),
      ),
  );
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Android 在线更新", () => {
  it("只检查自己的仓库，下载后用户取消安装可以重试", async () => {
    const service = await import("./updater");
    service.registerAndroidUpdater();
    invoke("update:check", true);
    await flushPromises();
    expect(service.getAndroidUpdateState()).toMatchObject({
      phase: "available",
      meta: { version: "2.0.0" },
    });
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
      "https://api.github.com/repos/ehgen0ng/SPlayer-Next/releases/latest",
    );
    invoke("update:download");
    await flushPromises();
    expect(service.getAndroidUpdateState().phase).toBe("downloaded");
    invoke("update:install");
    await flushPromises();
    expect(mocks.native).toHaveBeenLastCalledWith(
      "android:installUpdate",
      "/private/tmp/splayer-test.apk",
      manifest.version,
      manifest.sha512,
    );
    expect(service.getAndroidUpdateState().phase).toBe("downloaded");
  });
  it("不下载相同或更低 versionCode 的 APK", async () => {
    mocks.localCode = manifest.versionCode;
    const service = await import("./updater");
    service.registerAndroidUpdater();
    invoke("update:check", true);
    await flushPromises();
    invoke("update:download");
    invoke("update:install");
    expect(service.getAndroidUpdateState().phase).toBe("upToDate");
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it("切换通道后取消旧下载，迟到成功不能恢复旧包安装资格", async () => {
    let finish!: (file: string) => void;
    mocks.download.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const service = await import("./updater");
    service.registerAndroidUpdater();
    invoke("update:check", true);
    await flushPromises();
    invoke("update:download");
    const signal = mocks.download.mock.calls[0][2] as AbortSignal;
    mocks.channel = "beta";
    service.syncAndroidUpdateChannel();
    expect(signal.aborted).toBe(true);
    expect(service.getAndroidUpdateState().phase).toBe("cancelling");
    finish("old.apk");
    await flushPromises();
    invoke("update:install");
    expect(service.getAndroidUpdateState()).toMatchObject({ channel: "beta", phase: "available" });
    expect(mocks.native.mock.calls.some(([channel]) => channel === "android:installUpdate")).toBe(
      false,
    );
  });
  it("签名检查失败保留安装重试入口，下载失败允许重新检查", async () => {
    const service = await import("./updater");
    service.registerAndroidUpdater();
    invoke("update:check", true);
    await flushPromises();
    mocks.download.mockRejectedValueOnce(new Error("摘要不一致"));
    invoke("update:download");
    await flushPromises();
    expect(service.getAndroidUpdateState()).toMatchObject({
      phase: "error",
      error: { source: "download" },
    });
    invoke("update:check", true);
    await flushPromises();
    invoke("update:download");
    await flushPromises();
    mocks.native.mockRejectedValueOnce(new Error("签名不一致"));
    invoke("update:install");
    await flushPromises();
    expect(service.getAndroidUpdateState()).toMatchObject({
      phase: "error",
      error: { source: "install" },
    });
  });
  it("自动检查关闭时不发请求，手动检查仍可执行", async () => {
    mocks.autoCheck = false;
    const service = await import("./updater");
    service.registerAndroidUpdater();
    invoke("update:check", false);
    expect(fetch).not.toHaveBeenCalled();
    invoke("update:check", true);
    await flushPromises();
    expect(service.getAndroidUpdateState().phase).toBe("available");
  });
});
