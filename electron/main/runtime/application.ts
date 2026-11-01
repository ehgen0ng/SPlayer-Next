import { app } from "electron";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * 获取应用数据目录，便携版沿用可整体迁移的 UserData 位置
 * @returns 平台提供的用户数据根目录
 */
export const getUserDataPath = (): string => {
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    const directory = path.join(process.env.PORTABLE_EXECUTABLE_DIR, "UserData");
    mkdirSync(directory, { recursive: true });
    app.setPath("userData", directory);
  }
  return app.getPath("userData");
};

/**
 * 获取随应用分发的插件目录
 * @returns 内置插件源码所在目录
 */
export const getBundledPluginsPath = (): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, "plugins")
    : path.join(app.getAppPath(), "resources", "plugins");

/**
 * 获取当前应用版本，供插件声明宿主能力
 * @returns 应用版本号
 */
export const getAppVersion = (): string => app.getVersion();

/**
 * 在应用退出前保存尚未落盘的配置
 * @param callback - 同步持久化操作
 */
export const onBeforeQuit = (callback: () => void): void => {
  app.on("before-quit", callback);
};
