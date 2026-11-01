import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "android/app/src/main/assets/node");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await writeFile(
  path.join(output, "start.cjs"),
  `
// 初始化失败通过原生桥回传，桥的事件循环继续保持应用可响应
const bridge = process._linkedBinding("splayer");
try { require("./index.cjs"); }
catch (error) { bridge.postMessage(JSON.stringify({ type: "fatal", error: String(error.stack || error) })); }
`,
);
await build({
  entryPoints: {
    index: path.join(root, "android/node/index.ts"),
    "host.worker": path.join(root, "electron/main/plugins/host.worker.ts"),
  },
  outdir: output,
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  target: "node24.22",
  format: "cjs",
  logLevel: "info",
  alias: {
    "@main/runtime": path.join(root, "android/node/runtime"),
    "@main/utils/logger": path.join(root, "android/node/runtime/logger.ts"),
    "@main/utils/proxy": path.join(root, "android/node/runtime/proxy.ts"),
    "@main/utils/broadcast": path.join(root, "android/node/runtime/broadcast.ts"),
    "@main/services/playerControl": path.join(root, "android/node/playerControl.ts"),
    "@/apis/transport": path.join(root, "electron/main/services/platformApi.ts"),
    "@main": path.join(root, "electron/main"),
    "@shared": path.join(root, "shared"),
    "@": path.join(root, "src"),
  },
});
await cp(path.join(root, "resources/plugins"), path.join(output, "plugins"), { recursive: true });
const hash = createHash("sha256");
for (const file of (await readdir(output, { recursive: true })).sort()) {
  if (!file.endsWith(".cjs") && !file.endsWith(".js")) continue;
  hash.update(file);
  hash.update(await readFile(path.join(output, file)));
}
await writeFile(path.join(output, "version"), hash.digest("hex"));
