import { app, session } from "electron";
import { getMainWindow } from "@main/window/main";

/** 网页业务请求使用的独立网络会话 */
export interface WebClientSession {
  cookies: {
    /**
     * 读取指定来源的会话 Cookie
     * @param filter - 请求来源
     * @returns Cookie 名称与值
     */
    get(filter: { url: string }): Promise<Array<{ name: string; value: string }>>;
    /**
     * 更新指定来源的 Cookie
     * @param cookie - Cookie 内容与作用域
     */
    set(cookie: {
      url: string;
      name: string;
      value: string;
      path: string;
      secure: boolean;
    }): Promise<void>;
  };
  /** 清理该业务会话的存储 */
  clearStorageData(): Promise<void>;
  /**
   * 设置业务请求使用的网络出口
   * @param config - 直接连接或桌面手动代理
   */
  setProxy(config: { mode: "direct" | "fixed_servers"; proxyRules?: string }): Promise<void>;
  /**
   * 使用会话执行网络请求
   * @param url - 请求地址
   * @param options - 请求参数
   * @returns 原始网络响应
   */
  fetch(url: string, options: RequestInit): Promise<Response>;
}

/** SDK 仅接触隔离的浏览器环境，不获得应用 IPC 或登录凭据 */
export interface WebClientSurface {
  session: Pick<WebClientSession, "setProxy">;
  /**
   * 检查浏览器环境是否失效
   * @returns 是否已销毁
   */
  isDestroyed(): boolean;
  /**
   * 读取当前浏览器 UA
   * @returns 用户代理字符串
   */
  getUserAgent(): string;
  /**
   * 在 SDK 专属环境执行脚本
   * @param worldId - 隔离环境标识
   * @param scripts - 可信宿主准备的脚本
   * @returns 脚本的可序列化结果
   */
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: Array<{ code: string }>): Promise<any>;
  /**
   * 订阅环境失效事件
   * @param event - 生命周期事件
   * @param listener - 取消当前任务的回调
   */
  on(event: string, listener: (...args: any[]) => void): unknown;
  /**
   * 订阅一次环境失效事件
   * @param event - 生命周期事件
   * @param listener - 取消当前任务的回调
   */
  once(event: string, listener: (...args: any[]) => void): unknown;
  /**
   * 释放当前任务持有的生命周期监听
   * @param event - 生命周期事件
   * @param listener - 原回调
   */
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}

/**
 * 等待桌面浏览器初始化
 * @returns 平台就绪信号
 */
export const webClientReady = (): Promise<void> => app.whenReady().then(() => undefined);

/**
 * 获取桌面主窗口供 SDK 使用的隔离环境
 * @returns 可用环境，主窗口未建立时为空
 */
export const getWebClientSurface = (): WebClientSurface | null =>
  getMainWindow()?.webContents ?? null;

/**
 * 创建与 SDK 执行环境分离的业务网络会话
 * @returns 不使用磁盘缓存的业务会话
 */
export const createWebClientSession = (): WebClientSession =>
  session.fromPartition("netease-web-api", { cache: false });

/**
 * 在平台退出时撤销排队中的网页请求
 * @param callback - 请求清理操作
 */
export const onWebClientQuit = (callback: () => void): void => {
  app.once("before-quit", callback);
};
