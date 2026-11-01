import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const vendor = path.join(root, "android/vendor");
const runtime = spawnSync("python3", [path.join(root, "scripts/prepare-android-runtime.py")], {
  cwd: root,
  stdio: "inherit",
});
if (runtime.error) throw runtime.error;
if (runtime.status !== 0) throw new Error("Android Node 24 运行时准备失败");

const require = createRequire(import.meta.url);
const sqlitePackage = require.resolve("better-sqlite3/package.json");
const sqlite = path.dirname(sqlitePackage);
const addon = path.dirname(createRequire(sqlitePackage).resolve("node-addon-api/package.json"));
const definitions = await readFile(path.join(sqlite, "deps/defines.gypi"), "utf8");
const macros = [...definitions.matchAll(/'([A-Z][A-Z0-9_]*(?:=[^']+)?)'/g)].map((m) => m[1]);
await writeFile(
  path.join(vendor, "sqlite.cmake"),
  [
    "# 从现有驱动的源码和编译配置生成，不另维护 SQLite 选项",
    `set(SPLAYER_SQLITE_ROOT "${sqlite.replaceAll("\\", "/")}")`,
    `set(SPLAYER_NODE_ADDON "${addon.replaceAll("\\", "/")}")`,
    `set(SPLAYER_SQLITE_DEFINES ${macros.join(" ")})`,
    "",
  ].join("\n"),
);
console.info("Android Node 24 与 SQLite 编译配置已就绪");
