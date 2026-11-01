import { invokeNative } from "../bridge";

/**
 * 使用 Android 文件选择器读取插件源码
 * @returns 选中的源码，取消时为空
 */
export const pickPluginSource = (): Promise<string | null> => invokeNative("system:pickPlugin");

/**
 * 安卓车机不提供本地歌词库入口
 * @returns 明确的能力不可用错误
 */
export const pickLyricRepoDir = (): Promise<never> =>
  Promise.reject(new Error("安卓车机不支持本地歌词库"));
