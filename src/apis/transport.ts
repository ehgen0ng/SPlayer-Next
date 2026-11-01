import type { ApiCallResponse, ApiPlatform } from "@shared/types/apis";

/**
 * 将界面的平台请求交给当前宿主，安卓后台直接复用对应业务入口
 * @param platform - 在线音乐平台
 * @param name - 已注册接口名
 * @param params - 业务参数
 * @returns 现有统一响应
 */
export const callPlatformApi = (
  platform: ApiPlatform,
  name: string,
  params?: Record<string, unknown>,
): Promise<ApiCallResponse> => window.api.apis.call(platform, name, params);
