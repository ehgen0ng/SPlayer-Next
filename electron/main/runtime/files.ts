import { dialog } from "electron";
import { readFile } from "node:fs/promises";

/**
 * 选择并读取用户要安装的插件源码
 * @returns 选中的源码，取消时为空
 */
export const pickPluginSource = async (): Promise<string | null> => {
  // Windows 无边框窗口不作为模态对话框父窗口，避免主窗口卡死
  const result = await dialog.showOpenDialog({
    title: "选择插件脚本",
    filters: [{ name: "Plugin Script", extensions: ["js"] }],
    properties: ["openFile"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return readFile(result.filePaths[0], "utf8");
};

/**
 * 选择桌面本地歌词库目录
 * @returns 目录路径，取消时为空
 */
export const pickLyricRepoDir = async (): Promise<string | null> => {
  const result = await dialog.showOpenDialog({
    title: "选择本地 TTML 歌词库目录",
    properties: ["openDirectory"],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
};
