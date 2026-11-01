import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { createServer } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const mode = process.argv[2] ?? "debug";
if (!["debug", "release", "dev"].includes(mode)) throw new Error(`无效安卓构建模式: ${mode}`);
if (mode === "release") {
  const signing = await readFile(path.join(root, "android/signing/signing.env"), "utf8")
    .then(parseEnv)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return {} as Record<string, string>;
      throw error;
    });
  for (const name of [
    "ANDROID_KEYSTORE_PATH",
    "ANDROID_KEYSTORE_PASSWORD",
    "ANDROID_KEY_ALIAS",
    "ANDROID_KEY_PASSWORD",
  ]) {
    const value = process.env[name] ?? signing[name];
    if (!value) throw new Error(`正式 APK 缺少签名配置: ${name}`);
    process.env[name] = value;
  }
  // 兼容已生成的 shell 配置，仅展开项目路径，不执行配置中的命令
  process.env.ANDROID_KEYSTORE_PATH = path.resolve(
    root,
    process.env.ANDROID_KEYSTORE_PATH!.replace(/^\$PWD\//, () => `${root}/`),
  );
  await access(process.env.ANDROID_KEYSTORE_PATH!);
}
const environment = { ...process.env, SPLAYER_ANDROID_DEV: mode === "dev" ? "1" : "0" };
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

/**
 * 顺序执行根项目工具，保持错误退出码并避免命令字符串插值
 * @param executable - 工具路径
 * @param args - 独立参数
 * @param cwd - 工作目录
 */
const run = (executable: string, args: string[], cwd = root): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: environment,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(executable)} 退出码 ${code}`)),
    );
  });

await run(pnpm, ["typecheck:android"]);
await run(pnpm, ["typecheck:web"]);
await run(pnpm, ["exec", "tsx", "scripts/prepare-android.ts"]);
await run(pnpm, ["exec", "tsx", "scripts/build-android-node.ts"]);
await run(pnpm, ["exec", "vite", "build", "--config", "vite.android.config.ts"]);

const server =
  mode === "dev"
    ? await createServer({
        configFile: path.join(root, "vite.android.config.ts"),
        server: { host: "127.0.0.1", port: 14559, strictPort: true },
      })
    : null;
try {
  await server?.listen();
  await run(pnpm, ["exec", "cap", "sync", "android"]);
  const gradle = path.join(
    root,
    "android",
    process.platform === "win32" ? "gradlew.bat" : "gradlew",
  );
  await run(
    gradle,
    [mode === "release" ? ":app:assembleRelease" : ":app:assembleDebug", "--console=plain"],
    path.join(root, "android"),
  );
  const variant = mode === "release" ? "release" : "debug";
  const source = path.join(root, `android/app/build/outputs/apk/${variant}/app-${variant}.apk`);
  const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const destination = path.join(
    root,
    `dist/android/SPlayer-Next-${version}-android-arm64-v8a-${variant}.apk`,
  );
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  console.info(`APK: ${destination}`);
  if (server) {
    const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
    if (!sdk) throw new Error("dev:android 需要 ANDROID_HOME 或 ANDROID_SDK_ROOT");
    const adb = path.join(sdk, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
    await run(adb, ["reverse", "tcp:14559", "tcp:14559"]);
    await run(adb, ["install", "-r", destination]);
    await run(adb, ["shell", "am", "start", "-n", "top.imsyy.splayer.car/.MainActivity"]);
    server.printUrls();
    console.info("Vue 修改自动更新；Node 或原生代码修改后重新运行 dev:android");
    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    });
  }
} finally {
  await server?.close();
}
