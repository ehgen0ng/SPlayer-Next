// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SongCacheRow } from "@main/database/songCache";

const state = vi.hoisted(() => ({
  directory: "",
  rows: new Map<string, SongCacheRow>(),
  limit: 64 / 1024 ** 3,
  resolveMedia: vi.fn(),
  register: vi.fn((id: string) => `cache-stream://${id}`),
  update: vi.fn(),
  release: vi.fn(),
}));
vi.mock("@main/services/streaming/mediaSource", () => ({
  resolveStreamingMediaSource: state.resolveMedia,
}));
vi.mock("@main/services/engine", () => ({
  getEngine: () => ({
    registerCacheStream: state.register,
    updateCacheStream: state.update,
    releaseCacheStream: state.release,
  }),
}));
vi.mock("electron", () => ({ app: { on: vi.fn() } }));
vi.mock("@main/utils/config", () => ({ getSongCacheDir: () => state.directory }));
vi.mock("@main/utils/logger", () => ({
  songCacheLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@main/store", () => ({
  store: { get: (key: string) => (key.endsWith("sizeLimitGb") ? state.limit : true) },
}));
vi.mock("@main/database/songCache", () => ({
  findByKey: (key: string) => state.rows.get(key),
  findByFilename: (filename: string) =>
    [...state.rows.values()].find((row) => row.filename === filename),
  upsert: (row: SongCacheRow) => state.rows.set(row.cacheKey, row),
  deleteByKey: (key: string) => state.rows.delete(key),
  clearAll: () => state.rows.clear(),
  touchLastUsed: vi.fn(),
  listAllFilenames: () => [...state.rows.values()].map((row) => row.filename),
  listLruVictims: (limit: number) => [...state.rows.values()].slice(0, limit),
  totalSize: () => [...state.rows.values()].reduce((sum, row) => sum + row.size, 0),
}));

/**
 * 构造供真实流写入流程使用的固定大小音频响应
 * @returns 带音频类型和长度声明的测试响应
 */
const audioResponse = (): Response =>
  new Response(Buffer.alloc(32, 1), {
    headers: { "content-type": "audio/wav", "content-length": "32" },
  });

describe("歌曲预载缓存生命周期", () => {
  beforeEach(async () => {
    vi.resetModules();
    state.rows.clear();
    state.resolveMedia.mockReset().mockResolvedValue({ url: "https://server/audio?token=private" });
    state.directory = await fs.mkdtemp(path.join(os.tmpdir(), "splayer-cache-test-"));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(state.directory, { recursive: true, force: true });
  });

  it("流媒体缓存只在主进程解析认证地址", async () => {
    const fetcher = vi.fn(async (_url: string, _options: RequestInit) => audioResponse());
    vi.stubGlobal("fetch", fetcher);
    const cache = await import("./songCache");
    expect(await cache.fetchAsync("remote", "streaming", "streaming://server/song")).not.toBeNull();
    expect(state.resolveMedia).toHaveBeenCalledWith(
      "server",
      "song",
      expect.any(String),
      expect.any(AbortSignal),
      0,
    );
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://server/audio?token=private");
    expect(state.rows.get("remote")).not.toHaveProperty("url");
  });

  it("取消预载消费者不会中断共用的后台下载", async () => {
    let finish!: (response: Response) => void;
    let signal!: AbortSignal;
    const fetcher = vi.fn((_url: string, options: RequestInit) => {
      signal = options.signal!;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const cache = await import("./songCache");
    const preload = cache.fetchAsync("same", "netease", "https://music/same", "preload");
    const background = cache.fetchAsync("same", "netease", "https://music/same");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    cache.cancelPreload("preload");
    expect(signal.aborted).toBe(false);
    finish(audioResponse());
    expect(await preload).toBe(await background);
    expect(await background).not.toBeNull();
  });

  it("取消排队的预载不会占用下载槽位或留下待执行任务", async () => {
    const finishes: Array<(response: Response) => void> = [];
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finishes.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const cache = await import("./songCache");
    const first = cache.fetchAsync("first", "netease", "https://music/first");
    const second = cache.fetchAsync("second", "netease", "https://music/second");
    const queued = cache.fetchAsync("queued", "netease", "https://music/queued", "queued");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    cache.cancelPreload("queued");
    expect(await queued).toBeNull();
    finishes.splice(0).forEach((finish) => finish(audioResponse()));
    await Promise.all([first, second]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const next = cache.fetchAsync("next", "netease", "https://music/next");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    finishes[0]!(audioResponse());
    expect(await next).not.toBeNull();
  });

  it("取消唯一下载消费者会终止网络请求", async () => {
    const fetcher = vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal!.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const cache = await import("./songCache");
    const preload = cache.fetchAsync("cancel", "netease", "https://music/cancel", "cancel");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    cache.cancelPreload("cancel");
    expect(await preload).toBeNull();
    expect(state.rows.size).toBe(0);
  });

  it("LRU 保留已准备的音源，释放租约后可以正常淘汰", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => audioResponse()),
    );
    const cache = await import("./songCache");
    const pinned = await cache.fetchAsync("pinned", "netease", "https://music/pinned", "next");
    await cache.fetchAsync("second", "netease", "https://music/second");
    await cache.fetchAsync("third", "netease", "https://music/third");
    expect(await fs.stat(pinned!)).toBeDefined();
    expect(state.rows.has("pinned")).toBe(true);
    expect(state.rows.has("second")).toBe(false);
    cache.cancelPreload("next");
    await cache.fetchAsync("fourth", "netease", "https://music/fourth");
    expect(state.rows.has("pinned")).toBe(false);
  });
});

describe("渐进缓存交接", () => {
  beforeEach(async () => {
    vi.resetModules();
    state.rows.clear();
    state.directory = await fs.mkdtemp(path.join(os.tmpdir(), "splayer-growing-cache-"));
  });
  afterEach(async () => {
    const cache = await import("./songCache");
    await cache.clearAll();
    vi.unstubAllGlobals();
    await fs.rm(state.directory, { recursive: true, force: true });
  });

  it("下载一半即返回可读入口，播放接管后不取消下载也不再请求 URL", async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    let signal!: AbortSignal;
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
      signal = options.signal!;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            body = c;
            c.enqueue(new Uint8Array(16).fill(1));
          },
        }),
        { headers: { "content-length": "32", "content-type": "audio/wav" } },
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const cache = await import("./songCache");
    const source = await cache.fetchAsync(
      "partial",
      "qqmusic",
      "https://audio/one",
      "preload",
      true,
    );
    expect(source).toMatch(/^cache-stream:/);
    expect(state.rows.size).toBe(0);
    const part = state.register.mock.calls.at(-1) as unknown as [string, string];
    expect((await fs.stat(part[1])).size).toBe(16);
    expect(cache.getSourceSize(source!)).toBe(32);
    cache.setPlaybackSource(source!);
    cache.cancelPreload("preload");
    expect(signal.aborted).toBe(false);
    expect(state.release).not.toHaveBeenCalled();
    body.enqueue(new Uint8Array(16).fill(2));
    body.close();
    await vi.waitFor(() => expect(state.rows.size).toBe(1));
    expect(await cache.lookup("partial")).not.toBeNull();
    expect(state.update).toHaveBeenLastCalledWith(source, 32, true, false);
    expect(fetcher).toHaveBeenCalledOnce();
    cache.setPlaybackSource();
    expect(state.release).toHaveBeenCalledWith(source);
  });

  it("取消最后的消费者通知读取失败并释放入口", async () => {
    let signal!: AbortSignal;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, options: RequestInit) => {
        signal = options.signal!;
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(16).fill(1));
            },
          }),
          { headers: { "content-length": "32" } },
        );
      }),
    );
    const cache = await import("./songCache");
    const source = await cache.fetchAsync(
      "cancel",
      "qqmusic",
      "https://audio/one",
      "preload",
      true,
    );
    cache.cancelPreload("preload");
    expect(signal.aborted).toBe(true);
    await vi.waitFor(() => expect(state.release).toHaveBeenCalledWith(source));
    expect(state.update).toHaveBeenLastCalledWith(source, 16, false, true);
    expect(state.rows.size).toBe(0);
  });

  it("下载提前结束会通知原生失败，不留下可命中的残缺缓存", async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                body = c;
                c.enqueue(new Uint8Array(16).fill(1));
              },
            }),
            { headers: { "content-length": "32" } },
          ),
      ),
    );
    const cache = await import("./songCache");
    const source = await cache.fetchAsync(
      "broken",
      "qqmusic",
      "https://audio/one",
      "preload",
      true,
    );
    body.close();
    await vi.waitFor(() => expect(state.release).toHaveBeenCalledWith(source));
    expect(state.update).toHaveBeenLastCalledWith(source, 16, false, true);
    expect(await cache.lookup("broken")).toBeNull();
    expect(await fs.readdir(state.directory)).toEqual([]);
  });

  it("没有完整长度时等待文件完成，不把半个文件当成完整音频", async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                body = c;
                c.enqueue(new Uint8Array(16).fill(1));
              },
            }),
          ),
      ),
    );
    const cache = await import("./songCache");
    let finished = false;
    const pending = cache
      .fetchAsync("unknown", "qqmusic", "https://audio/one", "preload", true)
      .then((file) => {
        finished = true;
        return file;
      });
    await vi.waitFor(() => expect(body).toBeDefined());
    expect(finished).toBe(false);
    expect(state.register).not.toHaveBeenCalled();
    body.enqueue(new Uint8Array(16).fill(2));
    body.close();
    const file = await pending;
    expect(file).not.toMatch(/^cache-stream:/);
    expect((await fs.stat(file!)).size).toBe(32);
  });
});
