import { app } from "electron";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { defaultCacheDir, logsDir } from "@main/utils/paths";
import { downloadUpdateFile } from "./updateDownload";
import { getUpdateAssetUrl } from "@shared/utils/update";
import type { UpdateInfo } from "electron-updater";
import type { UpdateChannel } from "@shared/types/settings";

const run = promisify(execFile);

/**
 * 下载当前架构的完整应用包，避免临时签名交给 Squirrel 安装
 * @param info - 原仓库返回的版本和附件摘要
 * @param channel - 本次检查使用的通道
 * @param signal - 任务取消信号
 * @param onProgress - 下载进度回调
 * @returns 已校验的 ZIP 缓存路径
 */
export const downloadMacUpdate = async (
  info: UpdateInfo,
  channel: UpdateChannel,
  signal: AbortSignal,
  onProgress: (percent: number) => void,
): Promise<string> => {
  const file =
    info.files.find((item) => item.url.endsWith(`-${process.arch}.zip`)) ??
    info.files.find((item) => item.url.endsWith("-universal.zip"));
  if (!file) throw new Error("当前版本没有适合本机架构的 macOS 更新包");
  const tag = channel === "nightly" ? "nightly" : `v${info.version}`;
  return downloadUpdateFile(
    { url: getUpdateAssetUrl(tag, file.url), size: file.size ?? 0, sha512: file.sha512 },
    join(defaultCacheDir, "updates", "update.zip"),
    signal,
    onProgress,
  );
};

/**
 * 在退出前完成解压与验签，交由独立进程等待退出后替换应用
 * @param archive - 已通过发布摘要校验的 ZIP
 * @param version - 当前检查结果中的目标版本
 */
export const installMacUpdate = async (archive: string, version: string): Promise<void> => {
  const target = resolve(process.resourcesPath, "../..");
  if (!app.isPackaged || !target.endsWith(".app") || target.startsWith("/Volumes/")) {
    throw new Error("请先将应用移到可写的应用程序目录后再更新");
  }
  if ((await lstat(target)).isSymbolicLink()) throw new Error("不支持替换符号链接应用");
  const work = await realpath(await mkdtemp(join(dirname(target), ".splayer-update-")));
  let handedOff = false;
  try {
    await run("/usr/bin/ditto", ["-x", "-k", archive, work]);
    const staged = join(work, "SPlayer-Next.app");
    if ((await lstat(staged)).isSymbolicLink() || (await realpath(staged)) !== staged) {
      throw new Error("更新包中的应用路径无效");
    }
    const info = join(staged, "Contents/Info.plist");
    const [identifier, installedIdentifier, updateVersion] = await Promise.all([
      run("/usr/libexec/PlistBuddy", ["-c", "Print:CFBundleIdentifier", info]),
      run("/usr/libexec/PlistBuddy", [
        "-c",
        "Print:CFBundleIdentifier",
        join(target, "Contents/Info.plist"),
      ]),
      run("/usr/libexec/PlistBuddy", ["-c", "Print:CFBundleShortVersionString", info]),
    ]);
    if (
      identifier.stdout.trim() !== installedIdentifier.stdout.trim() ||
      updateVersion.stdout.trim() !== version
    ) {
      throw new Error("更新包的应用标识或版本与检查结果不一致");
    }
    await run("/usr/bin/lipo", [
      "-verify_arch",
      process.arch === "arm64" ? "arm64" : "x86_64",
      join(staged, "Contents/MacOS/SPlayer-Next"),
    ]);
    await run("/bin/chmod", ["-R", "u+w", staged]);
    await run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", staged]);
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", staged]);

    await mkdir(logsDir, { recursive: true });
    const log = await open(join(logsDir, "update-mac.log"), "a", 0o600);
    try {
      const child = spawn(
        "/bin/sh",
        [
          join(process.resourcesPath, "update-mac.sh"),
          String(process.pid),
          target,
          work,
          basename(staged),
        ],
        { detached: true, stdio: ["ignore", log.fd, log.fd] },
      );
      await new Promise<void>((yes, no) => {
        child.once("spawn", yes);
        child.once("error", no);
      });
      child.unref();
      handedOff = true;
    } finally {
      await log.close();
    }
    app.quit();
  } finally {
    if (!handedOff) await rm(work, { recursive: true, force: true });
  }
};
