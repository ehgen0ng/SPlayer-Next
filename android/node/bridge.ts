import { EventEmitter } from "node:events";
import type { AndroidMessage } from "@shared/types/android";

interface NativeBinding {
  postMessage(message: string): void;
  onMessage(callback: (message: string) => void): void;
}

const binding = (
  process as NodeJS.Process & { _linkedBinding(name: string): NativeBinding }
)._linkedBinding("splayer");
const pending = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }
>();
let sequence = 0;
let handler: ((channel: string, args: unknown[]) => unknown) | undefined;
export const nativeEvents = new EventEmitter();

/**
 * 发送一条应用内部消息
 * @param message - 类型化的请求、结果或事件
 */
export const postNative = (message: AndroidMessage): void => {
  binding.postMessage(JSON.stringify(message));
};

/**
 * 等待原生能力执行结果，超时后移除挂起请求
 * @param channel - 原生方法名
 * @param args - 方法参数
 * @returns 原生平台的实际结果
 */
export const invokeNative = <T>(channel: string, ...args: unknown[]): Promise<T> => {
  if (pending.size >= 64) return Promise.reject(new Error("原生请求过多"));
  const id = `node:${++sequence}`;
  return new Promise<T>((resolve, reject) => {
    // 文档选择由用户关闭或 Activity 销毁结束，不应用网络请求的等待期限
    const timer =
      channel === "system:pickPlugin"
        ? undefined
        : setTimeout(() => {
            pending.delete(id);
            reject(new Error(`原生请求超时: ${channel}`));
          }, 60_000);
    pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
    try {
      postNative({ type: "invoke", id, channel, args });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
};

/**
 * 绑定共享业务方法的唯一入口
 * @param callback - 通道分发函数
 */
export const setInvokeHandler = (callback: (channel: string, args: unknown[]) => unknown): void => {
  handler = callback;
};

binding.onMessage((text) => {
  const message = JSON.parse(text) as AndroidMessage;
  if (message.type === "result") {
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.value);
  } else if (message.type === "event") {
    nativeEvents.emit(message.channel, message.data);
  } else if (message.type === "invoke") {
    void Promise.resolve()
      .then(() => {
        if (!handler) throw new Error("业务服务尚未就绪");
        return handler(message.channel, message.args);
      })
      .then(
        (value) => postNative({ type: "result", id: message.id, value }),
        (error) =>
          postNative({ type: "result", id: message.id, error: String(error?.message ?? error) }),
      );
  }
});
