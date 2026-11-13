import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
  window: null as { once: ReturnType<typeof vi.fn> } | null,
  createWindow: vi.fn(),
  focusWindow: vi.fn(),
  registerDefault: vi.fn(),
  registerPartition: vi.fn(),
  quitting: false,
  isMac: true,
}));
vi.mock("electron", () => ({
  app: {
    commandLine: { appendSwitch: vi.fn() },
    requestSingleInstanceLock: () => true,
    on: (name: string, handler: (...args: unknown[]) => void) => mocks.handlers.set(name, handler),
    whenReady: () => Promise.resolve(),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock("@electron-toolkit/utils", () => ({
  electronApp: { setAppUserModelId: vi.fn() },
  optimizer: { watchWindowShortcuts: vi.fn() },
}));
vi.mock("@main/window", () => ({
  createMainWindow: mocks.createWindow,
  getMainWindow: () => mocks.window,
  focusMainWindow: mocks.focusWindow,
  restoreLyricWindows: vi.fn(),
}));
vi.mock("@main/utils/config", () => ({
  get isMac() {
    return mocks.isMac;
  },
}));
vi.mock("@main/utils/protocol", () => ({
  MAIN_PARTITION: "persist:main",
  registerCacheScheme: vi.fn(),
  handleCacheProtocol: mocks.registerDefault,
  handleCacheProtocolOnPartition: mocks.registerPartition,
}));
vi.mock("@main/utils/lifecycle", () => ({ isAppQuitting: () => mocks.quitting }));
vi.mock("@main/utils/logger", () => ({ coreLog: { info: vi.fn() }, initLogger: vi.fn() }));
vi.mock("@main/utils/proxy", () => ({ initNetworkProxy: vi.fn() }));
vi.mock("@main/ipc", () => ({ registerIpcHandlers: vi.fn() }));
vi.mock("@main/services/media", () => ({ init: vi.fn() }));
vi.mock("@main/services/lastfm", () => ({ init: vi.fn() }));
vi.mock("@main/services/globalHotkey", () => ({ initGlobalHotkey: vi.fn() }));
vi.mock("@main/database", () => ({ initDatabase: vi.fn() }));
vi.mock("@main/services/songCache", () => ({ init: vi.fn() }));
vi.mock("@main/services/downloadManager", () => ({ init: vi.fn() }));
vi.mock("@main/plugins/registry", () => ({ pluginRegistry: { init: vi.fn() } }));
vi.mock("@main/plugins/playbackBridge", () => ({ init: vi.fn() }));
vi.mock("@main/server", () => ({ startServer: vi.fn() }));
vi.mock("@main/services/mcp/http", () => ({ startMcpServer: vi.fn() }));
vi.mock("@main/services/updater", () => ({ initUpdater: vi.fn() }));
vi.mock("@main/services/orpheus", () => ({
  initOrpheusRegistration: vi.fn(),
  extractOrpheusUrl: vi.fn(),
}));
vi.mock("@main/services/externalFile", () => ({ extractAudioFiles: () => [] }));
vi.mock("./lifecycle", () => ({ initAppLifecycle: vi.fn() }));

import { initApp } from "./index";

describe("应用协议与窗口生命周期", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.window = null;
    mocks.quitting = false;
    mocks.isMac = true;
    mocks.createWindow.mockImplementation(() => {
      mocks.window = { once: vi.fn() };
      return mocks.window;
    });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("启动时为默认会话和主窗口分区各注册一次缓存协议", async () => {
    initApp();
    await flushPromises();
    expect(mocks.registerDefault).toHaveBeenCalledOnce();
    expect(mocks.registerPartition).toHaveBeenCalledExactlyOnceWith("persist:main");
    expect(mocks.registerPartition.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createWindow.mock.invocationCallOrder[0],
    );
  });

  it("macOS 多次重建主窗口时不重复注册分区协议，已有窗口只聚焦", async () => {
    initApp();
    await flushPromises();
    const activate = mocks.handlers.get("activate")!;
    activate();
    expect(mocks.focusWindow).toHaveBeenCalledOnce();
    for (let count = 0; count < 2; count++) {
      mocks.window = null;
      activate();
    }
    expect(mocks.createWindow).toHaveBeenCalledTimes(3);
    expect(mocks.registerPartition).toHaveBeenCalledOnce();
  });

  it.each([true, false])("退出中收到激活事件时不重建或显示窗口，macOS=%s", async (isMac) => {
    mocks.isMac = isMac;
    initApp();
    await flushPromises();
    mocks.quitting = true;
    mocks.window = null;
    mocks.handlers.get("activate")!();
    expect(mocks.createWindow).toHaveBeenCalledOnce();
    expect(mocks.focusWindow).not.toHaveBeenCalled();
  });
});
