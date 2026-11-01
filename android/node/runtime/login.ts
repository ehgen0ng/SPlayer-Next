import { invokeNative } from "../bridge";

/**
 * 打开安卓官方登录页面并返回本次登录会话
 * @returns 用户取消时为空，否则为账号 Cookie
 */
export const openNeteaseLoginWindow = (): Promise<Record<string, string> | null> =>
  invokeNative("system:loginNetease");
