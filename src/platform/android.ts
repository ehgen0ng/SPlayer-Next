import { registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";
import { createAppApi, type ApiTransport } from "@shared/bridge";

interface NativePlugin {
  invoke(options: { channel: string; args: unknown[] }): Promise<{ value: unknown }>;
  addListener(
    name: "event",
    listener: (event: { channel: string; data: unknown }) => void,
  ): Promise<PluginListenerHandle>;
}

const native = registerPlugin<NativePlugin>("SPlayer");
const listeners = new Map<string, Set<(event: unknown, data: any) => void>>();

/**
 * 请求安卓平台执行应用内部方法
 * @param channel - 原生或共享业务通道
 * @param args - 方法参数
 * @returns 原始业务结果
 */
export const invokeAndroid = async <T = void>(channel: string, ...args: unknown[]): Promise<T> => {
  const result = await native.invoke({ channel, args });
  return result.value as T;
};

/**
 * 订阅安卓平台事件，释放后移除空通道
 * @param channel - 事件通道
 * @param listener - 事件处理器
 * @returns 取消订阅方法
 */
export const onAndroid = <T>(channel: string, listener: (value: T) => void): (() => void) => {
  const handler = (_event: unknown, value: T): void => listener(value);
  let group = listeners.get(channel);
  if (!group) listeners.set(channel, (group = new Set()));
  group.add(handler);
  return () => {
    group.delete(handler);
    if (!group.size) listeners.delete(channel);
  };
};

/** 使用共享 API 映射连接当前 WebView，桌面继续由 preload 注入 */
export const installAndroidBridge = async (): Promise<void> => {
  const osInfo = await invokeAndroid<{ type: string; arch: string; release: string }>(
    "android:deviceInfo",
  );
  await native.addListener("event", ({ channel, data }) => {
    for (const listener of listeners.get(channel) ?? []) listener(undefined, data);
  });
  const transport: ApiTransport = {
    invoke: invokeAndroid,
    send: (channel, ...args) => {
      void invokeAndroid(channel, ...args).catch((error) => console.error(channel, error));
    },
    on: (channel, handler) => {
      let group = listeners.get(channel);
      if (!group) listeners.set(channel, (group = new Set()));
      group.add(handler);
    },
    removeListener: (channel, handler) => {
      const group = listeners.get(channel);
      group?.delete(handler);
      if (!group?.size) listeners.delete(channel);
    },
    removeAllListeners: (channel) => listeners.delete(channel),
  };
  window.api = createAppApi(
    transport,
    {
      installType: "apk",
      platform: "android",
      osInfo,
    },
    () => {
      throw new Error("安卓请通过系统文件选择器导入插件");
    },
  ) as typeof window.api;
};
