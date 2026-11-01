import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import type { SandboxIn, SandboxOut } from "../../../shared/types/plugin";

/**
 * 在发送前订阅目标响应，忽略沙箱同期发出的日志与注册事件
 * @param worker - 实际 Node 工作线程
 * @param accept - 目标消息判定
 * @param message - 可选的测试指令
 * @returns 匹配的沙箱响应
 */
const exchange = (
  worker: Worker,
  accept: (message: SandboxOut) => boolean,
  message?: SandboxIn,
): Promise<SandboxOut> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("沙箱响应超时")), 5000);
    /**
     * 清除本次消息等待的监听和超时
     * @param error - 可选失败原因
     * @param response - 匹配的响应
     */
    const finish = (error?: Error, response?: SandboxOut): void => {
      clearTimeout(timer);
      worker.off("message", receive);
      worker.off("error", fail);
      if (error) reject(error);
      else resolve(response!);
    };
    /**
     * 仅消费当前请求的响应
     * @param response - 沙箱消息
     */
    const receive = (response: SandboxOut): void => {
      if (accept(response)) finish(undefined, response);
    };
    /**
     * 将实际线程错误转交测试
     * @param error - 线程错误
     */
    const fail = (error: Error): void => finish(error);
    worker.on("message", receive);
    worker.once("error", fail);
    if (message) worker.postMessage(message);
  });

test("同一沙箱在 Node 工作线程中完成注册、宿主存储调用和音源解析", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "splayer-worker-"));
  const entry = path.join(directory, "host.cjs");
  let worker: Worker | undefined;
  try {
    await build({
      entryPoints: [path.join(import.meta.dirname, "host.worker.ts")],
      outfile: entry,
      bundle: true,
      platform: "node",
      target: "node18",
      format: "cjs",
    });
    worker = new Worker(entry);
    await exchange(worker, (message) => message.kind === "hostReady");
    const ready = await exchange(worker, (message) => message.kind === "ready", {
      kind: "loadPlugin",
      pluginId: "android-transport-test",
      apiLevel: 5,
      locale: "zh-CN",
      appVersion: "1.0.0",
      userSettings: {},
      scriptInfo: { name: "消息验证", description: "", author: "", homepage: "", version: "1" },
      source: `
        splayer.register({ sources: { test: { name: "测试", actions: ["musicUrl"] } } });
        splayer.on("musicUrl", async (request) => {
          const origin = await splayer.storage.get("地址🎵");
          return { url: origin + "/" + request.musicInfo.songmid };
        });
      `,
    });
    assert.equal(ready.kind, "ready");
    const call = await exchange(worker, (message) => message.kind === "hostCall", {
      kind: "call",
      pluginId: "android-transport-test",
      requestId: "resolve-1",
      action: "musicUrl",
      params: { source: "test", quality: "hq", musicInfo: { songmid: "曲目" } },
    });
    assert.equal(call.kind, "hostCall");
    if (call.kind !== "hostCall") throw new Error("未收到宿主调用");
    assert.equal(call.method, "storage.get");
    assert.deepEqual(call.args, ["地址🎵"]);
    const result = await exchange(worker, (message) => message.kind === "result", {
      kind: "hostResult",
      pluginId: "android-transport-test",
      callId: call.callId,
      ok: true,
      data: "https://example.invalid/audio",
    });
    assert.deepEqual(result, {
      kind: "result",
      pluginId: "android-transport-test",
      requestId: "resolve-1",
      ok: true,
      data: { url: "https://example.invalid/audio/曲目" },
    });
    worker.postMessage({
      kind: "unloadPlugin",
      pluginId: "android-transport-test",
    } satisfies SandboxIn);
    await exchange(worker, (message) => message.kind === "pong", { kind: "ping" });
  } finally {
    await worker?.terminate();
    await rm(directory, { recursive: true, force: true });
  }
});
