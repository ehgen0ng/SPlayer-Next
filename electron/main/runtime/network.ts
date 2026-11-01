import { net } from "electron";

/**
 * 通过桌面网络栈发送请求，保留系统代理并绕过应用自定义协议
 * @param url - HTTP 或 HTTPS 地址
 * @param options - 请求参数及取消信号
 * @returns 原始网络响应
 */
export const fetchNetwork = (url: string, options?: RequestInit): Promise<Response> =>
  net.fetch(url, { ...options, bypassCustomProtocolHandlers: true });
