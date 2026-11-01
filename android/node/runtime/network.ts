/**
 * 通过内嵌 Node 的网络栈执行插件 HTTP 请求
 * @param url - 已校验的请求地址
 * @param options - 请求参数及取消信号
 * @returns 原始网络响应
 */
export const fetchNetwork = (url: string, options?: RequestInit): Promise<Response> =>
  fetch(url, options);
