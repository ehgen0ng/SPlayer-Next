import { EventEmitter } from "node:events";
import type { WebClientSession, WebClientSurface } from "@main/runtime/webClient";
import { invokeNative, nativeEvents } from "../bridge";

let surface: WebClientSurface | null = null;
let ready: Promise<void> | null = null;
const lifecycle = new EventEmitter();

/**
 * 安卓车机使用原生系统网络，不支持桌面代理配置
 * @param config - 共用业务传入的出口配置
 */
const setProxy = async (config: { mode: "direct" | "fixed_servers" }): Promise<void> => {
  if (config.mode !== "direct") throw new Error("安卓不支持桌面代理配置");
};

/**
 * 建立不携带账号与应用桥接权限的 SDK 专用 WebView
 * @returns SDK 执行环境就绪信号
 */
export const webClientReady = (): Promise<void> => {
  ready ??= invokeNative<{ userAgent: string }>("web:initialize")
    .then(({ userAgent }) => {
      surface = {
        session: { setProxy },
        isDestroyed: () => surface === null,
        getUserAgent: () => userAgent,
        executeJavaScriptInIsolatedWorld: async (_world, scripts) => {
          let result: unknown;
          for (const { code } of scripts) result = await invokeNative("web:evaluate", code);
          return result;
        },
        on: (event, listener) => lifecycle.on(event, listener),
        once: (event, listener) => lifecycle.once(event, listener),
        removeListener: (event, listener) => lifecycle.removeListener(event, listener),
      };
    })
    .catch((error) => {
      ready = null;
      throw error;
    });
  return ready;
};

/**
 * 获取已经初始化的 SDK 专属环境
 * @returns 当前可用环境
 */
export const getWebClientSurface = (): WebClientSurface | null => surface;

/**
 * 创建由 Java 标准 CookieManager 管理的业务会话
 * @returns 与网页 SDK Cookie 完全分离的请求会话
 */
export const createWebClientSession = (): WebClientSession => ({
  cookies: {
    get: ({ url }) => invokeNative("web:getCookies", url),
    set: (cookie) => invokeNative("web:setCookie", cookie),
  },
  clearStorageData: () => invokeNative("web:clearCookies"),
  setProxy,
  fetch: async (url, options) => {
    const headers = new Headers(options.headers);
    if (options.credentials === "include") {
      const cookie = await invokeNative<string>("web:cookieHeader", url);
      if (cookie) headers.set("Cookie", cookie);
    }
    const response = await fetch(url, { ...options, headers });
    if (options.credentials === "include") {
      await invokeNative("web:storeCookies", url, response.headers.getSetCookie());
    }
    return response;
  },
});

/**
 * 注册应用进程退出时的清理操作
 * @param callback - 清理现有请求队列
 */
export const onWebClientQuit = (callback: () => void): void => {
  process.once("exit", callback);
};

nativeEvents.on("web:destroyed", () => {
  surface = null;
  ready = null;
  lifecycle.emit("destroyed");
});
