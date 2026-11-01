import path from "node:path";
import { Worker } from "node:worker_threads";
import type { PluginProcess } from "@main/runtime/pluginProcess";

/**
 * 用可终止的 Node 工作线程运行现有沙箱，复用原宿主的心跳与重启流程
 * @returns 遵循同一消息协议的插件宿主
 */
export const createPluginProcess = (): PluginProcess => {
  const worker = new Worker(path.join(path.dirname(process.argv[1]), "host.worker.cjs"), {
    stdout: true,
    stderr: true,
  });
  // 错误仍通过非零退出交给宿主统一处理，避免未订阅的 error 终止主运行时
  worker.on("error", (error) => console.error("[plugin-host]", error));
  return {
    stdout: worker.stdout,
    stderr: worker.stderr,
    on: (event, callback) => worker.on(event, callback),
    postMessage: (message) => worker.postMessage(message),
    kill: () => void worker.terminate(),
  };
};
