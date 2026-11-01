import { resolve } from "node:path";
import { defineConfig } from "vite";
import { rendererConfig } from "./electron.vite.config";

export default defineConfig({
  ...rendererConfig,
  base: "./",
  define: { ...rendererConfig.define, "import.meta.env.VITE_PLATFORM": JSON.stringify("android") },
  optimizeDeps: {
    ...rendererConfig.optimizeDeps,
    entries: ["index.html", "src/components/**/*.vue"],
  },
  build: {
    ...rendererConfig.build,
    outDir: "dist/android/web",
    target: "es2020",
    rolldownOptions: { input: resolve(import.meta.dirname, "index.html") },
  },
});
