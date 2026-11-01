import path from "node:path";

/**
 * 读取 Android 服务传入的私有文件目录
 * @returns 应用内部存储目录
 */
export const getUserDataPath = (): string => process.argv[2];

/**
 * 定位随 Node 入口释放的内置插件
 * @returns 内置插件目录
 */
export const getBundledPluginsPath = (): string =>
  path.join(path.dirname(process.argv[1]), "plugins");

/**
 * 获取构建时写入的应用版本
 * @returns 应用版本号
 */
export const getAppVersion = (): string => process.argv[4];

/**
 * 在运行时主动退出前刷新配置
 * @param callback - 同步持久化操作
 */
export const onBeforeQuit = (callback: () => void): void => {
  process.on("exit", callback);
};
