// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const mocks = vi.hoisted(() => ({ root: "", quit: vi.fn(), spawn: vi.fn() }));
vi.mock("electron", () => ({ app: { isPackaged: true, quit: mocks.quit } }));
vi.mock("@main/utils/paths", () => ({
  get defaultCacheDir() {
    return `${mocks.root}/cache`;
  },
  get logsDir() {
    return `${mocks.root}/logs`;
  },
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));

const run = promisify(execFile);
const resourceDescriptor = Object.getOwnPropertyDescriptor(process, "resourcesPath");
let target: string;
let bundle: string;
let archive: string;

/**
 * 生成可由系统验签的最小测试应用，完全位于临时目录
 * @param version - 应用版本
 * @param identifier - 应用标识
 * @returns 应用 Info.plist
 */
const plist = (
  version: string,
  identifier = "top.imsyy.splayer-next",
): string => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleExecutable</key><string>SPlayer-Next</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.root = await mkdtemp(join(tmpdir(), "splayer mac update-"));
  target = join(mocks.root, "Installed Player.app");
  bundle = join(mocks.root, "source/SPlayer-Next.app");
  archive = join(mocks.root, "update.zip");
  await mkdir(join(target, "Contents/Resources"), { recursive: true });
  await mkdir(join(bundle, "Contents/MacOS"), { recursive: true });
  await writeFile(join(target, "Contents/Info.plist"), plist("1.0.0"));
  await writeFile(join(bundle, "Contents/Info.plist"), plist("2.0.0"));
  const source = join(mocks.root, "main.c");
  await writeFile(source, "int main(void) { return 0; }\n");
  await run("/usr/bin/clang", [
    "-arch",
    process.arch === "arm64" ? "arm64" : "x86_64",
    source,
    "-o",
    join(bundle, "Contents/MacOS/SPlayer-Next"),
  ]);
  await run("/usr/bin/codesign", ["--force", "--sign", "-", bundle]);
  await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", bundle, archive]);
  Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value: join(target, "Contents/Resources"),
  });
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
});
afterEach(async () => {
  if (resourceDescriptor) Object.defineProperty(process, "resourcesPath", resourceDescriptor);
  else Reflect.deleteProperty(process, "resourcesPath");
  await rm(mocks.root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "darwin")("macOS 更新预检", () => {
  it("通过真实验签后才移交独立安装进程，退出前不替换旧应用", async () => {
    const { installMacUpdate } = await import("./macUpdater");
    await installMacUpdate(archive, "2.0.0");
    expect(mocks.quit).toHaveBeenCalledOnce();
    expect(mocks.spawn.mock.calls[0][1].slice(0, 3)).toEqual([
      join(target, "Contents/Resources/update-mac.sh"),
      String(process.pid),
      target,
    ]);
    expect(await readFile(join(target, "Contents/Info.plist"), "utf8")).toContain("1.0.0");
  });
  it("版本或签名不匹配时保留旧应用并清理暂存包", async () => {
    const { installMacUpdate } = await import("./macUpdater");
    await expect(installMacUpdate(archive, "3.0.0")).rejects.toThrow("版本");
    await writeFile(join(bundle, "Contents/Info.plist"), plist("2.0.0", "other.app"));
    await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", bundle, archive]);
    await expect(installMacUpdate(archive, "2.0.0")).rejects.toThrow("标识");
    expect(mocks.quit).not.toHaveBeenCalled();
    expect((await readdir(mocks.root)).some((name) => name.startsWith(".splayer-update-"))).toBe(
      false,
    );
  });
  it("包内签名被破坏时不退出或替换当前应用", async () => {
    await writeFile(join(bundle, "Contents/Info.plist"), plist("2.0.0") + "\n");
    await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", bundle, archive]);
    const { installMacUpdate } = await import("./macUpdater");
    await expect(installMacUpdate(archive, "2.0.0")).rejects.toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it.each([false, true])("退出后替换应用，启动失败时回滚（失败：%s）", async (failOpen) => {
    const work = join(mocks.root, "staging");
    const staged = join(work, "SPlayer-Next.app");
    await mkdir(staged, { recursive: true });
    await writeFile(join(target, "old"), "old");
    await writeFile(join(staged, "new"), "new");
    if (failOpen) await writeFile(join(staged, "fail-open"), "");
    const open = join(mocks.root, "open-stub");
    await writeFile(open, '#!/bin/sh\n# 模拟启动结果，不打开真实应用\n[ ! -e "$2/fail-open" ]\n', {
      mode: 0o700,
    });
    const script = join(mocks.root, "install.sh");
    const original = await readFile(resolve("resources/update-mac.sh"), "utf8");
    await writeFile(
      script,
      original.replaceAll("/usr/bin/open", `'${open.replaceAll("'", "'\\''")}'`),
    );
    const result = run("/bin/sh", [script, "999999999", target, work, "SPlayer-Next.app"]);
    if (failOpen) await expect(result).rejects.toThrow();
    else await result;
    expect(await readdir(target)).toContain(failOpen ? "old" : "new");
    expect(await readdir(mocks.root)).not.toContain("staging");
  });
});
