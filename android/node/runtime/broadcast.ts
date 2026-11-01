import { postNative } from "../bridge";

/**
 * 向当前安卓界面推送业务事件
 * @param channel - 事件名称
 * @param data - 事件数据
 * @param visibleOnly - 是否仅在界面可见时发送
 */
export const broadcast = (channel: string, data: unknown, visibleOnly = false): void => {
  postNative({ type: "event", channel, data, visibleOnly });
};

/**
 * 向主界面发送低频状态事件
 * @param channel - 事件名称
 * @param data - 事件数据
 */
export const sendToMain = (channel: string, data?: unknown): void => broadcast(channel, data);
