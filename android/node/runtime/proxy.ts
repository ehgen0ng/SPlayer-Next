/**
 * 安卓在线请求沿用系统路由，车机设置不提供桌面手动代理
 * @returns 无应用级代理覆盖
 */
export const getNetworkProxyUrl = (): null => null;

/**
 * 使用内嵌 Node 的网络实现发送在线平台请求
 * @param input - 请求地址
 * @param init - 请求参数
 * @returns 原始响应
 */
export const fetchWithProxy = (input: string | URL, init?: RequestInit): Promise<Response> =>
  fetch(input, init);
