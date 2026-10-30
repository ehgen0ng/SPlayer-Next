import fs from "node:fs";
import { parseStreamingSource } from "@shared/utils/streamingSource";
import { resolveStreamingMediaSource } from "@main/services/streaming/mediaSource";
import fsp, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { getEngine } from "@main/services/engine";
import { app } from "electron";
import { store } from "@main/store";
import { getSongCacheDir } from "@main/utils/config";
import { songCacheLog } from "@main/utils/logger";
import type { TrackSource } from "@shared/types/player";
import {
  clearAll as dbClearAll,
  deleteByKey,
  findByFilename,
  findByKey,
  listAllFilenames,
  listLruVictims,
  totalSize,
  touchLastUsed,
  upsert,
} from "@main/database/songCache";

/** 下载并发上限 */
const MAX_CONCURRENT = 2;
/** 一批 LRU 淘汰数 */
const EVICT_BATCH = 8;

/**
 * 拒绝的响应 Content-Type 前缀（命中即不入缓存）
 * 第三方代理常用 200 包一段 HTML/JSON 错误体冒充音频，这里第一道拦截
 */
const REJECTED_MIME_PREFIXES = ["text/html", "application/json", "application/xml", "text/xml"];

const isRejectedMime = (mime: string | null): boolean => {
  if (!mime) return false;
  const lower = mime.toLowerCase();
  return REJECTED_MIME_PREFIXES.some((prefix) => lower.startsWith(prefix));
};

/**
 * 文件头是否像音频
 *
 * 反向看首字节，挡 HTML/JSON 错误页冒充音频的常见骗局
 * 不做正向 magic 枚举（容器太多枚举不全反而漏判），剩余漏网坏文件由 player.ts:228
 * 的解码失败 invalidate 兜底
 */
const looksLikeAudio = async (filePath: string): Promise<boolean> => {
  let fd: FileHandle | null = null;
  try {
    fd = await fsp.open(filePath, "r");
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fd.read(buf, 0, 4, 0);
    if (bytesRead === 0) return false;
    // '<' = HTML/XML，'{' = JSON 对象，'[' = JSON 数组
    return buf[0] !== 0x3c && buf[0] !== 0x7b && buf[0] !== 0x5b;
  } catch {
    return false;
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
};

interface InFlight {
  promise: Promise<string | null>;
  controller: AbortController;
  owners: Set<string>;
  playable: Promise<string | null>;
  resolvePlayable: (source: string | null) => void;
  progressive: boolean;
  finished: boolean;
  available: number;
  stream?: { source: string; total: number; filename: string };
}

/** 当前生效的歌曲缓存目录 */
let cacheDir = getSongCacheDir();
/** 进行中的下载，按 cacheKey 去重 */
const inFlight = new Map<string, InFlight>();
/** 等待槽位的队列；只存 starter，槽位空出来时取队头执行 */
const waiting: Array<() => void> = [];
// 只保留正在预载或播放的入口，最后一个持有者释放时移除
const cacheStreams = new Map<string, InFlight>();
let playbackSource: string | undefined;
let activeDownloads = 0;
let preloadPin: { id: string; filename: string } | null = null;

/** sizeLimit 字节数；0/负数视为不限制 */
const sizeLimitBytes = (): number => {
  const gb = store.get("cache.songCache.sizeLimitGb") ?? 10;
  return gb > 0 ? gb * 1024 * 1024 * 1024 : Number.POSITIVE_INFINITY;
};

/** 是否启用歌曲缓存 */
const isCacheEnabled = (): boolean => store.get("cache.songCache.enabled") === true;

/**
 * 用 cache_key 派生唯一文件名
 * @param cacheKey - 缓存键
 * @returns 文件名
 */
const filenameFor = (cacheKey: string): string => {
  const hash = crypto.createHash("sha1").update(cacheKey).digest("hex").slice(0, 16);
  return `${hash}.bin`;
};

/** 获取文件的绝对路径
 * @param filename - 文件名
 * @returns 绝对路径
 */
const absPath = (filename: string): string => path.join(cacheDir, filename);

/**
 * 等待可用下载槽位，排队期间支持取消
 * @param signal - 下载任务的取消信号
 * @returns 成功取得槽位时返回 true，取得槽位前被取消时返回 false
 */
const acquireSlot = async (signal: AbortSignal): Promise<boolean> => {
  if (signal.aborted) return false;
  if (activeDownloads < MAX_CONCURRENT) {
    activeDownloads++;
    return true;
  }
  return new Promise((resolve) => {
    const start = (): void => {
      signal.removeEventListener("abort", abort);
      resolve(true);
    };
    const abort = (): void => {
      const index = waiting.indexOf(start);
      if (index >= 0) waiting.splice(index, 1);
      resolve(false);
    };
    waiting.push(start);
    signal.addEventListener("abort", abort, { once: true });
  });
};

/** 将下载槽位交给下一个等待者，没有等待者时减少活跃下载数 */
const releaseSlot = (): void => {
  const next = waiting.shift();
  if (next) next();
  else activeDownloads--;
};

/**
 * 为备用槽位保留缓存文件，防止切歌前被 LRU 淘汰
 * @param id - 持有缓存租约的预载任务标识
 * @param sourcePath - 预载音源路径，仅缓存目录内的文件会被保留
 */
export const pinPreload = (id: string, sourcePath: string): void => {
  if (path.dirname(sourcePath) === cacheDir)
    preloadPin = { id, filename: path.basename(sourcePath) };
};

/**
 * 释放预载租约，仅在没有其他消费者时中止共用下载
 * @param id - 要取消的预载任务标识
 */
export const cancelPreload = (id: string): void => {
  if (preloadPin?.id === id) preloadPin = null;
  for (const pending of new Set([...inFlight.values(), ...cacheStreams.values()])) {
    pending.owners.delete(id);
    releaseUnused(pending);
  }
};

/**
 * 清理没有消费者的缓存任务与原生入口
 * @param entry - 下载及其共享读取状态
 */
const releaseUnused = (entry: InFlight): void => {
  if (entry.owners.size) return;
  if (!entry.finished) {
    entry.controller.abort();
    return;
  }
  if (entry.stream) {
    getEngine().releaseCacheStream(entry.stream.source);
    cacheStreams.delete(entry.stream.source);
  }
};

/**
 * 交接当前播放的缓存租约，必须先接管再取消预载
 * @param source - 新音源，省略时释放当前播放
 */
export const setPlaybackSource = (source?: string): void => {
  if (source === playbackSource) return;
  const previous = playbackSource ? cacheStreams.get(playbackSource) : undefined;
  const next = source ? cacheStreams.get(source) : undefined;
  next?.owners.add("playback");
  playbackSource = next ? source : undefined;
  if (previous) {
    previous.owners.delete("playback");
    releaseUnused(previous);
  }
};

/**
 * 返回渐进缓存的完整大小，避免把当前已下载字节数当成文件大小
 * @param source - 渐进缓存音源
 * @returns 服务端声明的完整文件字节数
 */
export const getSourceSize = (source: string): number | undefined =>
  cacheStreams.get(source)?.stream?.total;

/**
 * 启动时孤儿清理
 * 删 .part；删表里有文件不在的；删目录里有表里没的
 */
const cleanupOrphans = async (): Promise<void> => {
  let entries: string[];
  try {
    entries = await fsp.readdir(cacheDir);
  } catch {
    return;
  }

  let partRemoved = 0;
  let orphanFiles = 0;
  for (const name of entries) {
    if (name.endsWith(".part")) {
      try {
        await fsp.unlink(path.join(cacheDir, name));
        partRemoved += 1;
      } catch {}
    }
  }

  const known = new Set(listAllFilenames());
  for (const name of entries) {
    if (name.endsWith(".part")) continue;
    if (!known.has(name)) {
      try {
        await fsp.unlink(path.join(cacheDir, name));
        orphanFiles += 1;
      } catch {}
    }
  }

  let missingRows = 0;
  for (const filename of known) {
    if (!fs.existsSync(path.join(cacheDir, filename))) {
      const row = findByFilename(filename);
      if (row) deleteByKey(row.cacheKey);
      missingRows += 1;
    }
  }

  songCacheLog.info(
    `[init] dir=${cacheDir} orphans.part=${partRemoved} orphan-files=${orphanFiles} missing-rows=${missingRows}`,
  );
};

/**
 * LRU 淘汰：超过 cap 时按 last_used_at 升序批量删
 * - 删超过 cap 的
 * - 删表里有文件不在的
 * - 删目录里有表里没的
 */
const evictIfNeeded = async (): Promise<void> => {
  const cap = sizeLimitBytes();
  let current = totalSize();
  if (current <= cap) return;

  let evicted = 0;
  let freed = 0;
  while (current > cap) {
    const victims = listLruVictims(EVICT_BATCH + 1).filter(
      (row) =>
        row.filename !== preloadPin?.filename &&
        ![...cacheStreams.values()].some((entry) => entry.stream?.filename === row.filename),
    );
    if (victims.length === 0) break;
    for (const victim of victims) {
      if (victim.filename === preloadPin?.filename) continue;
      try {
        await fsp.unlink(absPath(victim.filename));
      } catch {}
      deleteByKey(victim.cacheKey);
      current -= victim.size;
      freed += victim.size;
      evicted += 1;
      if (current <= cap) break;
    }
  }
  if (evicted > 0) songCacheLog.info(`[evict] count=${evicted} freed=${freed}`);
};

/**
 * 实际下载实现
 * @param cacheKey - 缓存键
 * @param source - 来源
 * @param streamUrl - 流 URL
 * @param entry - 下载状态及消费者租约
 * @returns 文件路径
 */
const runDownload = async (
  cacheKey: string,
  source: TrackSource,
  streamUrl: string,
  entry: InFlight,
): Promise<string | null> => {
  const { controller } = entry;
  const start = Date.now();
  const filename = filenameFor(cacheKey);
  const finalPath = absPath(filename);
  const partPath = `${finalPath}.part`;

  try {
    await fsp.mkdir(cacheDir, { recursive: true });
    if (source === "streaming") {
      const identity = parseStreamingSource(streamUrl);
      streamUrl = (
        await resolveStreamingMediaSource(
          identity.serverId,
          identity.trackId,
          crypto.randomUUID(),
          controller.signal,
          identity.serverRevision,
        )
      ).url;
    }
    const response = await fetch(streamUrl, {
      signal: controller.signal,
      headers: { "Accept-Encoding": "identity" },
    });
    if (!response.ok || !response.body) {
      songCacheLog.warn(`[fetch] fail key=${cacheKey} status=${response.status}`);
      await response.body?.cancel();
      return null;
    }

    const mime = response.headers.get("content-type");
    // 拦截第三方代理常用 200+html 错误页冒充音频
    if (isRejectedMime(mime)) {
      songCacheLog.warn(`[fetch] reject mime key=${cacheKey} mime=${mime}`);
      await response.body.cancel();
      return null;
    }
    const contentLengthHeader = response.headers.get("content-length");
    const declaredSize = contentLengthHeader ? Number(contentLengthHeader) : NaN;
    if (Number.isFinite(declaredSize) && declaredSize > sizeLimitBytes()) {
      songCacheLog.warn(`[fetch] skip oversize key=${cacheKey} declared=${declaredSize}`);
      await response.body.cancel();
      return null;
    }

    const nodeStream = Readable.fromWeb(response.body as never, { signal: controller.signal });
    const file = await fsp.open(partPath, "w");
    const encoding = response.headers.get("content-encoding");
    const knownLength =
      Number.isSafeInteger(declaredSize) &&
      declaredSize > 0 &&
      (!encoding || encoding === "identity");
    try {
      for await (const chunk of nodeStream) {
        controller.signal.throwIfAborted();
        await file.writeFile(chunk);
        entry.available += chunk.length;
        if (entry.available > sizeLimitBytes()) throw new Error("歌曲缓存超过容量限制");
        if (knownLength && entry.available > declaredSize) throw new Error("音频响应长度不一致");
        if (entry.progressive && knownLength && !entry.stream) {
          if (!(await looksLikeAudio(partPath))) throw new Error("响应不是音频文件");
          const source = getEngine().registerCacheStream(
            crypto.randomUUID(),
            partPath,
            finalPath,
            streamUrl,
            declaredSize,
          );
          entry.stream = { source, total: declaredSize, filename };
          cacheStreams.set(source, entry);
          getEngine().updateCacheStream(source, entry.available, false, false);
          entry.resolvePlayable(source);
        } else if (entry.stream) {
          getEngine().updateCacheStream(entry.stream.source, entry.available, false, false);
        }
      }
      if (knownLength && entry.available !== declaredSize) throw new Error("音频下载提前结束");
    } finally {
      nodeStream.destroy();
      await file.close();
    }

    const stat = await fsp.stat(partPath);
    if (stat.size === 0) {
      await fsp.unlink(partPath).catch(() => {});
      songCacheLog.warn(`[fetch] empty key=${cacheKey}`);
      return null;
    }
    if (stat.size > sizeLimitBytes()) {
      await fsp.unlink(partPath).catch(() => {});
      songCacheLog.warn(`[fetch] post oversize key=${cacheKey} actual=${stat.size}`);
      return null;
    }
    // 拦截首字节看着像音频才放行
    if (!(await looksLikeAudio(partPath))) {
      await fsp.unlink(partPath).catch(() => {});
      songCacheLog.warn(`[fetch] not audio key=${cacheKey} mime=${mime} size=${stat.size}`);
      return null;
    }

    controller.signal.throwIfAborted();
    await fsp.rename(partPath, finalPath);
    if (entry.stream)
      getEngine().updateCacheStream(entry.stream.source, entry.available, true, false);
    const now = Date.now();
    upsert({
      cacheKey,
      source,
      filename,
      size: stat.size,
      mime,
      cachedAt: now,
      lastUsedAt: now,
    });
    await evictIfNeeded();

    songCacheLog.info(`[fetch] done key=${cacheKey} size=${stat.size} ms=${Date.now() - start}`);
    return finalPath;
  } catch (err) {
    const cancelled = controller.signal.aborted;
    controller.abort();
    if (entry.stream)
      getEngine().updateCacheStream(entry.stream.source, entry.available, false, true);
    await fsp.unlink(partPath).catch(() => {});
    if (cancelled) {
      songCacheLog.info(`[fetch] cancel key=${cacheKey}`);
    } else {
      songCacheLog.error(`[fetch] error key=${cacheKey}`, err);
    }
    return null;
  }
};

/** 启动初始化：建目录 + 孤儿清理 */
export const init = async (): Promise<void> => {
  cacheDir = getSongCacheDir();
  await fsp.mkdir(cacheDir, { recursive: true });
  await cleanupOrphans();
  app.on("before-quit", () => {
    for (const entry of inFlight.values()) entry.controller.abort();
  });
};

/** 切换缓存目录后调用，让服务感知新前缀 */
export const reloadDir = (): void => {
  cacheDir = getSongCacheDir();
};

/** 查询命中；命中则更新 last_used_at 并返回本地绝对路径 */
export const lookup = async (cacheKey: string): Promise<string | null> => {
  if (!isCacheEnabled()) return null;
  const row = findByKey(cacheKey);
  if (!row) return null;
  const full = absPath(row.filename);
  if (!fs.existsSync(full)) {
    deleteByKey(cacheKey);
    return null;
  }
  touchLastUsed(cacheKey, Date.now());
  return full;
};

/**
 * 异步排队下载
 * @param cacheKey - 缓存键
 * @param source - 来源
 * @param streamUrl - 流 URL
 * @param preloadId - 可选的预载消费者标识，用于保留缓存文件和独立取消下载
 * @param progressive - 预载是否允许返回尚未下载完的共享读取入口
 * @returns 可读缓存入口或完整路径，失败、取消或禁止缓存时为空
 */
export const fetchAsync = (
  cacheKey: string,
  source: TrackSource,
  streamUrl: string,
  preloadId?: string,
  progressive = false,
): Promise<string | null> => {
  if (!isCacheEnabled()) return Promise.resolve(null);
  if (source === "streaming" && !store.get("cache.songCache.cacheStreaming"))
    return Promise.resolve(null);
  if (preloadId) preloadPin = { id: preloadId, filename: filenameFor(cacheKey) };
  const owner = preloadId ?? "background";
  const existing = inFlight.get(cacheKey);
  if (existing) {
    existing.owners.add(owner);
    if (progressive && preloadId) {
      existing.progressive = true;
      return existing.playable;
    }
    return existing.promise;
  }
  const controller = new AbortController();
  const { promise: playable, resolve: resolvePlayable } = Promise.withResolvers<string | null>();
  const entry: InFlight = {
    controller,
    owners: new Set([owner]),
    playable,
    resolvePlayable,
    progressive: Boolean(progressive && preloadId),
    finished: false,
    available: 0,
    promise: Promise.resolve(null),
  };
  inFlight.set(cacheKey, entry);
  entry.promise = (async () => {
    const acquired = await acquireSlot(controller.signal);
    let result: string | null = null;
    try {
      if (!acquired || controller.signal.aborted) return null;
      result = (await lookup(cacheKey)) ?? (await runDownload(cacheKey, source, streamUrl, entry));
      return result;
    } finally {
      entry.finished = true;
      entry.owners.delete("background");
      entry.resolvePlayable(result);
      if (inFlight.get(cacheKey) === entry) inFlight.delete(cacheKey);
      if (acquired) releaseSlot();
      if (!result && entry.stream) {
        getEngine().updateCacheStream(entry.stream.source, entry.available, false, true);
        entry.owners.clear();
      }
      releaseUnused(entry);
    }
  })();
  return entry.progressive ? playable : entry.promise;
};

/**
 * 取消正在进行的下载
 * @param cacheKey - 缓存键
 */
export const cancel = (cacheKey: string): void => {
  const entry = inFlight.get(cacheKey);
  if (entry) entry.controller.abort();
};

/**
 * 失效：删文件 + 删表
 * 如果表里没有或文件不存在则静默返回
 * @param sourcePath - 传入原始来源路径（streamUrl 或本地路径），用来找到对应的 cacheKey 和文件
 */
export const invalidate = async (sourcePath: string): Promise<void> => {
  const stream = cacheStreams.get(sourcePath);
  if (stream?.stream) {
    stream.controller.abort();
    sourcePath = absPath(stream.stream.filename);
  }
  if (path.dirname(sourcePath) !== cacheDir) return;
  const filename = path.basename(sourcePath);
  const row = findByFilename(filename);
  if (!row) return;
  deleteByKey(row.cacheKey);
  await fsp.unlink(absPath(filename)).catch(() => {});
  songCacheLog.info(`[invalidate] path=${sourcePath}`);
};

/** 清空全部 */
export const clearAll = async (): Promise<void> => {
  preloadPin = null;
  const pending = [...inFlight.values()];
  for (const entry of pending) entry.controller.abort();
  await Promise.allSettled(pending.map((entry) => entry.promise));
  playbackSource = undefined;
  for (const entry of cacheStreams.values()) {
    entry.owners.clear();
    releaseUnused(entry);
  }
  dbClearAll();
  try {
    const entries = await fsp.readdir(cacheDir);
    await Promise.all(entries.map((name) => fsp.unlink(path.join(cacheDir, name)).catch(() => {})));
  } catch {}
  songCacheLog.info("[clearAll] done");
};

/** 占用统计 */
export const stats = (): { size: number; path: string } => ({
  size: totalSize(),
  path: cacheDir,
});
