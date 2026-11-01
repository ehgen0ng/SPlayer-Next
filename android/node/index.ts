import path from "node:path";
import { initDatabase } from "@main/database";
import { store } from "@main/store";
import type { ConfigPath } from "@main/store/types";
import { registerApisIpc } from "@main/ipc/apis";
import { registerCommentsIpc } from "@main/ipc/comments";
import { registerLyricsIpc } from "@main/ipc/lyrics";
import { registerNowPlayingIpc } from "@main/ipc/nowPlaying";
import { registerPlaylistIpc } from "@main/ipc/playlist";
import { registerPluginIpc } from "@main/ipc/plugin";
import { registerStatsIpc } from "@main/ipc/stats";
import { pluginRegistry } from "@main/plugins/registry";
import * as playbackBridge from "@main/plugins/playbackBridge";
import { setLocale } from "@main/utils/i18n";
import { coreLog } from "@main/utils/logger";
import { broadcast } from "@main/utils/broadcast";
import { trackSchema } from "@main/services/music";
import { z } from "zod/v4";
import { invokeNative, postNative, setInvokeHandler } from "./bridge";
import { dispatch, ipcMain } from "./runtime/ipc";
import { applyPlaybackSnapshot } from "./playerControl";
import { resolvePlaybackSource } from "./source";
import { initNativeHistory } from "./history";
import type { AndroidPlaybackSnapshot } from "@shared/types/android";
import { audioSourcePreferencesSchema } from "@shared/types/audioSource";
import { fetchPersonalFm, submitFmTrash } from "@/apis/recommend/netease";
import { searchSongs } from "@/apis/search";

/** 初始化共享业务，只在应用进程中运行一次 */
const start = async (): Promise<void> => {
  const addon = { exports: {} };
  process.dlopen(addon as NodeModule, path.join(process.argv[3], "libbetter_sqlite3.so"));
  initDatabase({ nativeBinding: addon.exports });
  initNativeHistory();
  Object.assign(console, {
    log: coreLog.info,
    info: coreLog.info,
    warn: coreLog.warn,
    error: coreLog.error,
    debug: coreLog.debug,
  });

  registerApisIpc();
  registerCommentsIpc();
  registerLyricsIpc();
  registerNowPlayingIpc(undefined, false);
  registerPlaylistIpc();
  registerPluginIpc();
  registerStatsIpc();
  ipcMain.handle("fm:more", (_event, options) => fetchPersonalFm(options));
  ipcMain.handle("fm:dislike", (_event, id: string, playedSeconds: number) =>
    submitFmTrash(id, playedSeconds),
  );
  ipcMain.handle("android:voiceSearch", async (_event, platform, song, artist) => {
    const source = z.enum(["netease", "qqmusic", "kugou"]).parse(platform);
    const title = z.string().trim().max(200).parse(song);
    const singer = z.string().trim().max(200).parse(artist);
    const keyword = [title, singer].filter(Boolean).join(" ");
    if (!keyword) throw new Error("请提供歌名或歌手");
    const result = await searchSongs(source, keyword, 0, 20);
    return result.items[0] ?? null;
  });

  ipcMain.handle("config:get", (_event, key: string) => store.get(key as ConfigPath));
  ipcMain.handle("config:getAll", () => store.store);
  ipcMain.handle("config:set", async (_event, key: string, value: unknown) => {
    if (key === "cache.songCache.sizeLimitGb") {
      const size = z.number().positive().finite().parse(value);
      await invokeNative("cache:setLimit", size * 1024 ** 3);
    }
    store.set(key, value);
    store.flushImmediate();
  });
  ipcMain.handle("config:reset", async () => {
    store.clear();
    store.flushImmediate();
    await invokeNative("cache:setLimit", store.get("cache.songCache.sizeLimitGb") * 1024 ** 3);
  });
  ipcMain.on("system:setLocale", (_event, locale) => setLocale(locale));
  ipcMain.handle("android:resolve", (_event, track, quality, preferences, requestId) =>
    resolvePlaybackSource(
      trackSchema.parse(track),
      z.enum(["lq", "sq", "hq", "lossless", "hi-res"]).parse(quality),
      audioSourcePreferencesSchema.parse(preferences),
      z.string().parse(requestId),
    ),
  );
  ipcMain.handle("android:initialize", async () => {
    const status = await invokeNative<AndroidPlaybackSnapshot>("android:snapshot");
    applyPlaybackSnapshot(status);
    await invokeNative("cache:setLimit", store.get("cache.songCache.sizeLimitGb") * 1024 ** 3);
  });
  setInvokeHandler(dispatch);
  pluginRegistry.init();
  playbackBridge.init();
  postNative({ type: "ready" });
  coreLog.info("Android 共享业务运行时已就绪", { node: process.version });
  process.on("unhandledRejection", (error) => coreLog.error("未处理的异步错误", error));
  broadcast("system:runtimeReady", { version: process.version });
};

void start().catch((error) => {
  postNative({ type: "fatal", error: String(error?.stack ?? error) });
});
