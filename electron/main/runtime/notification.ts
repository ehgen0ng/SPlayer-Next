import { Notification } from "electron";

/**
 * 展示插件发出的系统通知
 * @param title - 已安装插件的名称
 * @param message - 已校验的通知内容
 */
export const showPluginNotification = (title: string, message: string): void => {
  if (!Notification.isSupported()) throw new Error("System notifications are unavailable");
  new Notification({ title, body: message }).show();
};
