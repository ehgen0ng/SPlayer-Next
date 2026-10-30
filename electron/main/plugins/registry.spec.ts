import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_PLUGINS, defaultPluginsConfig } from "@shared/defaults/plugin-api";
import type { PluginManifest, PluginsConfig } from "@shared/types/plugin";
import { getByPath, setByPath } from "@shared/utils/path";
import { loadScript } from "./loader";

const mocks = vi.hoisted(() => ({
  appRoot: "",
  pluginsDir: "",
  packaged: false,
  get: vi.fn(),
  set: vi.fn(),
  fetchScript: vi.fn(),
  loadPlugin: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return mocks.packaged;
    },
    getAppPath: () => mocks.appRoot,
    getVersion: () => "1.0.0",
  },
}));
vi.mock("@main/utils/paths", () => ({
  get pluginsDir() {
    return mocks.pluginsDir;
  },
}));
vi.mock("@main/store", () => ({ store: { get: mocks.get, set: mocks.set } }));
vi.mock("@main/utils/i18n", () => ({ getLocale: () => "zh-CN" }));
vi.mock("@main/utils/logger", () => ({
  coreLog: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));
vi.mock("./host-process", () => ({
  pluginHost: {
    setOnHostLost: vi.fn(),
    setOnHostStable: vi.fn(),
    isReady: () => false,
    loadPlugin: mocks.loadPlugin,
    unloadPlugin: vi.fn(),
    shutdown: vi.fn(),
  },
}));
vi.mock("./host", () => ({ dispatchHostCall: vi.fn() }));
vi.mock("./storage", () => ({
  pluginStorageDrop: vi.fn(),
  pluginStorageRelease: vi.fn(),
  shutdownPluginStorage: vi.fn(),
}));
vi.mock("./net", () => ({ fetchScript: mocks.fetchScript }));

const resourceDir = path.resolve("resources/plugins");
const bundledIds = BUNDLED_PLUGINS.map((plugin) => plugin.id);
const resourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, "resourcesPath");
let root: string;
let config: { plugins: PluginsConfig };
let registry: typeof import("./registry").pluginRegistry;
let remoteSources: Map<string, string>;

/**
 * 构造带稳定标识的测试插件源码
 * @param version - 测试版本号
 * @param id - 插件标识
 * @param updateUrl - 可选的声明更新地址
 * @returns 仅包含元数据的脚本
 */
const script = (version: string, id = "api-cf", updateUrl?: string): string =>
  `/**\n * @id ${id}\n * @name 测试插件\n * @version ${version}\n${updateUrl ? ` * @updateUrl ${updateUrl}\n` : ""} */\n`;

/**
 * 读取临时用户目录中的插件清单
 * @returns 已持久化的插件和首次安装标记
 */
const readManifest = (): {
  bundledInitialized: boolean;
  plugins: Record<string, PluginManifest>;
} => JSON.parse(fs.readFileSync(path.join(mocks.pluginsDir, "manifest.json"), "utf-8"));

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "splayer-bundled-test-"));
  mocks.appRoot = root;
  mocks.pluginsDir = path.join(root, "user-data", "plugins");
  mocks.packaged = false;
  fs.cpSync(resourceDir, path.join(root, "resources", "plugins"), { recursive: true });
  config = { plugins: structuredClone(defaultPluginsConfig) };
  mocks.get.mockImplementation((key: string) => getByPath(config, key));
  mocks.set.mockImplementation((key: string, value: unknown) => setByPath(config, key, value));
  mocks.loadPlugin.mockResolvedValue(undefined);
  remoteSources = new Map(
    BUNDLED_PLUGINS.map(({ id, sourceUrl }) => [
      sourceUrl,
      fs.readFileSync(path.join(resourceDir, `${id}.js`), "utf-8"),
    ]),
  );
  mocks.fetchScript.mockImplementation(async (url: string) => {
    const source = remoteSources.get(url);
    if (!source) throw new Error(`测试未配置该地址: ${url}`);
    return source;
  });
  registry = (await import("./registry")).pluginRegistry;
});

afterEach(async () => {
  await registry.shutdown();
  if (resourcesPathDescriptor) {
    Object.defineProperty(process, "resourcesPath", resourcesPathDescriptor);
  } else {
    Reflect.deleteProperty(process, "resourcesPath");
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("内置插件安装", () => {
  it("首次启动按默认顺序安装七个真实脚本，成功次数为空且保留自动排序", () => {
    registry.init();
    const plugins = registry.listInfo();
    expect(plugins.map((plugin) => plugin.manifest.id)).toEqual(bundledIds);
    expect(plugins.every((plugin) => plugin.enabled)).toBe(true);
    expect(mocks.loadPlugin).toHaveBeenCalledTimes(7);
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(readManifest().bundledInitialized).toBe(true);
    expect(config.plugins.musicSourceSuccesses).toEqual({});
    expect(config.plugins.autoSortMusicSources).toBe(true);
    for (const { id, sourceUrl } of BUNDLED_PLUGINS) {
      expect(readManifest().plugins[id].sourceUrl).toBe(sourceUrl);
      expect(fs.readFileSync(path.join(mocks.pluginsDir, "scripts", `${id}.js`), "utf-8")).toBe(
        fs.readFileSync(path.join(resourceDir, `${id}.js`), "utf-8"),
      );
    }
  });

  it("已有插件的脚本、禁用状态、个人设置和历史记录不被内置版本覆盖", () => {
    const source = script("99.0.0");
    const { manifest } = loadScript(source, false);
    manifest.installedAt = 42;
    fs.mkdirSync(path.join(mocks.pluginsDir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(mocks.pluginsDir, "scripts", manifest.fileName), source);
    fs.writeFileSync(
      path.join(mocks.pluginsDir, "manifest.json"),
      JSON.stringify({ version: 1, plugins: { [manifest.id]: manifest } }),
    );
    config.plugins.enabled[manifest.id] = false;
    config.plugins.perPlugin[manifest.id] = { custom: "saved" };
    config.plugins.musicSourceSuccesses[manifest.id] = 12;
    config.plugins.priority.musicUrl = [manifest.id];
    const previous = structuredClone(config);

    registry.init();

    expect(config).toEqual(previous);
    expect(registry.getRuntime(manifest.id)?.source).toBe(source);
    expect(registry.getRuntime(manifest.id)?.enabled).toBe(false);
    expect(readManifest().plugins[manifest.id].installedAt).toBe(42);
    expect(registry.listInfo()).toHaveLength(7);
    expect(mocks.loadPlugin).toHaveBeenCalledTimes(6);
  });

  it("卸载后重启不会补装，仍可通过普通导入手动装回", async () => {
    registry.init();
    const id = bundledIds[0];
    await registry.uninstall(id);
    expect(readManifest().plugins[id]).toBeUndefined();
    expect(fs.existsSync(path.join(mocks.pluginsDir, "scripts", `${id}.js`))).toBe(false);

    await registry.shutdown();
    vi.resetModules();
    registry = (await import("./registry")).pluginRegistry;
    registry.init();
    expect(registry.getRuntime(id)).toBeUndefined();
    expect(registry.listInfo()).toHaveLength(6);

    const installed = await registry.install(path.join(resourceDir, `${id}.js`));
    expect(installed.manifest.id).toBe(id);
    expect(installed.enabled).toBe(true);
    expect(readManifest().bundledInitialized).toBe(true);
  });

  it("全部卸载后重启仍保持空列表", async () => {
    registry.init();
    for (const id of bundledIds) await registry.uninstall(id);
    await registry.shutdown();
    vi.resetModules();
    registry = (await import("./registry")).pluginRegistry;
    registry.init();
    expect(registry.listInfo()).toEqual([]);
    expect(readManifest().bundledInitialized).toBe(true);
  });

  it("打包运行时从 resources/plugins 读取脚本", () => {
    mocks.packaged = true;
    mocks.appRoot = path.join(root, "app.asar");
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      value: path.join(root, "resources"),
    });
    registry.init();
    expect(registry.listInfo()).toHaveLength(7);
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});

describe("插件导入与更新地址", () => {
  it("导入 URL 在重启和原地更新后保留，可在未声明更新地址时检查新版", async () => {
    registry.init();
    const url = "https://example.com/custom.js";
    await registry.installFromSource(script("1.0.0", "custom"), url);
    expect(readManifest().plugins.custom.sourceUrl).toBe(url);
    await registry.shutdown();
    vi.resetModules();
    registry = (await import("./registry")).pluginRegistry;
    registry.init();

    const newer = script("2.0.0", "custom");
    mocks.fetchScript.mockResolvedValue(newer);
    expect((await registry.checkUpdate("custom")).hasUpdate).toBe(true);
    expect(mocks.fetchScript).toHaveBeenCalledWith(url);
    expect(registry.getUpdateUrl("custom")).toBe(url);
    await registry.applyUpdateFromSource("custom", newer);
    expect(readManifest().plugins.custom.sourceUrl).toBe(url);
    expect(registry.getRuntime("custom")?.manifest.version).toBe("2.0.0");
  });

  it("导入 URL 优先于脚本声明的地址，更新后两个地址都保留", async () => {
    registry.init();
    const sourceUrl = "https://example.com/import.js";
    const updateUrl = "https://example.com/latest.js";
    await registry.installFromSource(script("1.0.0", "custom", updateUrl), sourceUrl);
    const newer = script("2.0.0", "custom");
    mocks.fetchScript.mockResolvedValue(newer);
    await registry.checkUpdate("custom");
    expect(mocks.fetchScript).toHaveBeenCalledWith(sourceUrl);
    await registry.applyUpdateFromSource("custom", newer);
    expect(readManifest().plugins.custom).toMatchObject({ sourceUrl, updateUrl });
  });

  it("插件主动上报更新时仍使用已保存的导入地址", async () => {
    registry.init();
    const sourceUrl = "https://example.com/import.js";
    await registry.installFromSource(script("1.0.0", "custom"), sourceUrl);
    const callbacks = mocks.loadPlugin.mock.calls.at(-1)![1];
    callbacks.onUpdateAvailable({
      version: "2.0.0",
      updateUrl: "https://example.com/other.js",
      updatedAt: Date.now(),
    });
    expect(registry.getUpdateUrl("custom")).toBe(sourceUrl);
  });

  it("拒绝将其他身份的脚本作为当前插件的更新", async () => {
    registry.init();
    await registry.installFromSource(script("1.0.0", "custom"), "https://example.com/plugin.js");
    mocks.fetchScript.mockResolvedValue(script("2.0.0", "different"));
    expect((await registry.checkUpdate("custom")).hasUpdate).toBe(false);
    await expect(
      registry.applyUpdateFromSource("custom", script("2.0.0", "different")),
    ).rejects.toThrow();
    expect(registry.getRuntime("custom")?.manifest.version).toBe("1.0.0");
  });
});

describe("启动时自动更新内置插件", () => {
  it("从 GitHub 地址下载一次后安装新版，保留禁用状态、设置和成功记录", async () => {
    registry.init();
    const { id, sourceUrl } = BUNDLED_PLUGINS[0];
    const installedAt = registry.getRuntime(id)!.manifest.installedAt;
    await registry.setEnabled(id, false);
    config.plugins.perPlugin[id] = { custom: "saved" };
    config.plugins.musicSourceSuccesses[id] = 5;
    const previous = structuredClone(config);
    const newer = remoteSources.get(sourceUrl)!.replace("@version v1.2.0", "@version v2.0.0");
    remoteSources.set(sourceUrl, newer);

    await registry.checkAllUpdates();

    expect(registry.getRuntime(id)?.manifest).toMatchObject({
      version: "v2.0.0",
      installedAt,
      sourceUrl,
    });
    expect(registry.getRuntime(id)?.enabled).toBe(false);
    expect(registry.getRuntime(id)?.updateInfo).toBeNull();
    expect(config).toEqual(previous);
    expect(fs.readFileSync(path.join(mocks.pluginsDir, "scripts", `${id}.js`), "utf-8")).toBe(
      newer,
    );
    expect(mocks.fetchScript).toHaveBeenCalledTimes(7);
    expect(mocks.fetchScript.mock.calls.filter(([url]) => url === sourceUrl)).toHaveLength(1);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("相同版本不重复安装，普通导入插件只提示更新", async () => {
    registry.init();
    const url = "https://example.com/custom.js";
    await registry.installFromSource(script("1.0.0", "custom"), url);
    remoteSources.set(url, script("2.0.0", "custom"));

    await registry.checkAllUpdates();

    expect(mocks.loadPlugin).toHaveBeenCalledTimes(8);
    expect(registry.getRuntime("custom")?.manifest.version).toBe("1.0.0");
    expect(registry.getRuntime("custom")?.updateInfo?.version).toBe("2.0.0");
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("更新下载失败保留现有脚本，不影响其他插件检查", async () => {
    registry.init();
    const { id } = BUNDLED_PLUGINS[0];
    const previous = registry.getRuntime(id)!.source;
    mocks.fetchScript.mockRejectedValueOnce(new Error("offline"));

    await registry.checkAllUpdates();

    expect(registry.getRuntime(id)?.source).toBe(previous);
    expect(fs.readFileSync(path.join(mocks.pluginsDir, "scripts", `${id}.js`), "utf-8")).toBe(
      previous,
    );
    expect(mocks.fetchScript).toHaveBeenCalledTimes(7);
    expect(mocks.warn).toHaveBeenCalledOnce();
  });

  it("下载更新期间卸载插件，下载结束也不会重新安装", async () => {
    registry.init();
    const { id, sourceUrl } = BUNDLED_PLUGINS[0];
    const newer = remoteSources.get(sourceUrl)!.replace("@version v1.2.0", "@version v2.0.0");
    let resolveSource!: (source: string) => void;
    mocks.fetchScript.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveSource = resolve;
        }),
    );
    const updating = registry.checkUpdate(id, true);
    await registry.uninstall(id);
    resolveSource(newer);

    expect((await updating).ok).toBe(false);
    expect(registry.getRuntime(id)).toBeUndefined();
    expect(readManifest().plugins[id]).toBeUndefined();
    expect(fs.existsSync(path.join(mocks.pluginsDir, "scripts", `${id}.js`))).toBe(false);
  });
});
