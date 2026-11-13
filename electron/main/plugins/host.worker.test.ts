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

test("真实工作线程完成注册和解析，并等待 LX 与原生插件的异步初始化", async () => {
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
    const messages: SandboxOut[] = [];
    worker.on("message", (message: SandboxOut) => messages.push(message));
    for (const native of [false, true]) {
      const pluginId = native ? "async-native" : "async-lx";
      const initialized = await exchange(worker, (message) => message.kind === "hostCall", {
        kind: "loadPlugin",
        pluginId,
        apiLevel: 5,
        locale: "zh-CN",
        appVersion: "1",
        userSettings: {},
        scriptInfo: { name: "异步初始化", description: "", author: "", homepage: "", version: "1" },
        source: native
          ? `splayer.storage.get("init").then(() => {
              splayer.register({ sources: { tx: { name: "QQ", actions: ["musicUrl"] } } });
              splayer.on("musicUrl", async () => ({ url: "https://example.invalid/audio" }));
            });`
          : `lx.on("request", async () => "https://example.invalid/audio");
             lx.request("https://example.invalid/init.conf", {}, (error, response) => {
               if (!error) lx.send("inited", { sources: {
                 tx: { name: "QQ", actions: ["musicUrl"], qualitys: ["hires"] }
               } });
             });`,
      });
      if (initialized.kind !== "hostCall") throw new Error("未收到初始化宿主调用");
      await exchange(worker, (message) => message.kind === "pong", { kind: "ping" });
      assert.equal(
        messages.some((message) => message.kind === "ready" && message.pluginId === pluginId),
        false,
      );
      const initializedReady = await exchange(
        worker,
        (message) => message.kind === "ready" && message.pluginId === pluginId,
        {
          kind: "hostResult",
          pluginId,
          callId: initialized.callId,
          ok: true,
          data: native ? true : { status: 200, headers: {}, body: "{}" },
        },
      );
      if (initializedReady.kind !== "ready") throw new Error("未收到初始化完成通知");
      assert.equal(initializedReady.sources.tx.name, "QQ");
      worker.postMessage({ kind: "unloadPlugin", pluginId } satisfies SandboxIn);
    }
    const pending = await exchange(worker, (message) => message.kind === "hostCall", {
      kind: "loadPlugin",
      pluginId: "cancelled-init",
      apiLevel: 5,
      locale: "zh-CN",
      appVersion: "1",
      userSettings: {},
      scriptInfo: { name: "取消初始化", description: "", author: "", homepage: "", version: "1" },
      source: `lx.request("https://example.invalid/init.conf", {}, (error) => {
        if (!error) lx.send("inited", { sources: {} });
      });`,
    });
    if (pending.kind !== "hostCall") throw new Error("未收到初始化请求");
    worker.postMessage({ kind: "unloadPlugin", pluginId: "cancelled-init" } satisfies SandboxIn);
    worker.postMessage({
      kind: "hostResult",
      pluginId: "cancelled-init",
      callId: pending.callId,
      ok: true,
      data: {},
    } satisfies SandboxIn);
    await exchange(worker, (message) => message.kind === "pong", { kind: "ping" });
    assert.equal(
      messages.some((message) => message.kind === "ready" && message.pluginId === "cancelled-init"),
      false,
    );
  } finally {
    await worker?.terminate();
    await rm(directory, { recursive: true, force: true });
  }
});
