import { invokeNative } from "../bridge";

/**
 * 通过安卓系统展示插件通知
 * @param title - 插件名称
 * @param message - 已校验的通知内容
 * @returns 原生通知发送结果
 */
export const showPluginNotification = (title: string, message: string): Promise<void> =>
  invokeNative("system:notify", title, message);
