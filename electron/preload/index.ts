import os from "node:os";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import { electronAPI } from "@electron-toolkit/preload";
import { createAppApi } from "@shared/bridge";

/**
 * 推断安装类型
 * @returns nsis | portable | appx | dmg | appimage
 */
const getInstallType = (): "nsis" | "portable" | "appx" | "dmg" | "appimage" => {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return "portable";
  if (process.execPath.includes("WindowsApps")) return "appx";
  if (process.platform === "darwin") return "dmg";
  if (process.platform === "linux") return "appimage";
  return "nsis";
};

const api = createAppApi(
  ipcRenderer,
  {
    installType: getInstallType(),
    platform: process.platform,
    osInfo: { type: os.type(), arch: os.arch(), release: os.release() },
  },
  (file) => webUtils.getPathForFile(file),
);

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("api", api);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI;
  // @ts-ignore (define in dts)
  window.api = api;
}
