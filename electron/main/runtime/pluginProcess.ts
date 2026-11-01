import { app, utilityProcess } from "electron";
import path from "node:path";
import type { SandboxIn, SandboxOut } from "@shared/types/plugin";

/** 插件生命周期仅依赖消息、退出事件及可终止的隔离执行环境 */
export interface PluginProcess {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  /**
   * 订阅插件宿主消息
   * @param event - 消息事件
   * @param callback - 沙箱消息处理器
   */
  on(event: "message", callback: (message: SandboxOut) => void): unknown;
  /**
   * 订阅插件宿主退出
   * @param event - 退出事件
   * @param callback - 接收退出码
   */
  on(event: "exit", callback: (code: number) => void): unknown;
  /**
   * 向隔离环境发送指令
   * @param message - 插件协议消息
   */
  postMessage(message: SandboxIn): void;
  /** 终止整个宿主，后续由现有注册表决定是否重启 */
  kill(): void;
}

/**
 * 创建桌面插件宿主进程
 * @returns 使用既有沙箱协议的进程
 */
export const createPluginProcess = (): PluginProcess =>
  utilityProcess.fork(path.join(app.getAppPath(), "out", "main", "host.worker.js"), [], {
    serviceName: "splayer-plugin-host",
    stdio: "pipe",
  });
