/** 注册音源接口和会话管理的跨进程入口 */

import { ipcMain } from "@main/runtime/ipc";
import { clearNeteaseCookies, mergeNeteaseCookies, setNeteaseCookies } from "@main/apis/netease";
import { cookieToJson } from "@main/apis/netease/core/cookie";
import { clearQQMusicCookies, mergeQQMusicCookies } from "@main/apis/qqmusic";
import { clearKugouSession, mergeKugouSession, setKugouSession } from "@main/apis/kugou";
import { setQQMusicCookies } from "@main/apis/qqmusic/core/request";
import { cancelQQMusicQr } from "@main/apis/qqmusic/modules/login_qr";
import {
  listSavedAccounts,
  getSavedAccountCookies,
  deleteSavedAccount,
  rememberAccount,
} from "@main/database/sessions";
import { isPlatform } from "@shared/types/platform";
import { openNeteaseLoginWindow } from "@main/runtime/login";
import { coreLog } from "@main/utils/logger";
import type { ApiPlatform } from "@shared/types/apis";
import { callPlatformApi } from "@main/services/platformApi";

/**
 * 注册平台接口的进程通信处理器
 */
export const registerApisIpc = (): void => {
  ipcMain.handle("apis:listAccounts", () => listSavedAccounts());
  ipcMain.handle("apis:switchAccount", (_event, platform: ApiPlatform, userId: string) => {
    if (!isPlatform(platform)) throw new Error("不支持的账号平台");
    const cookies = getSavedAccountCookies(platform, userId);
    if (platform === "netease") setNeteaseCookies(cookies);
    if (platform === "qqmusic") {
      cancelQQMusicQr();
      setQQMusicCookies(cookies);
    }
    if (platform === "kugou") setKugouSession(cookies);
    const profile = listSavedAccounts().find(
      (item) => item.platform === platform && item.profile.userId === userId,
    )?.profile;
    if (profile) rememberAccount(platform, profile);
  });
  ipcMain.handle("apis:removeAccount", (_event, platform: ApiPlatform, userId: string) => {
    if (!isPlatform(platform)) throw new Error("不支持的账号平台");
    const accounts = listSavedAccounts();
    const active = accounts.some(
      (item) => item.platform === platform && item.profile.userId === userId && item.active,
    );
    const next = active
      ? accounts.find((item) => item.platform === platform && item.profile.userId !== userId)
      : undefined;
    const cookies = next ? getSavedAccountCookies(platform, next.profile.userId) : undefined;
    deleteSavedAccount(platform, userId);
    if (!active) return;
    if (platform === "netease") {
      if (cookies) setNeteaseCookies(cookies);
      else clearNeteaseCookies();
    }
    if (platform === "qqmusic") {
      cancelQQMusicQr();
      if (cookies) setQQMusicCookies(cookies);
      else clearQQMusicCookies();
    }
    if (platform === "kugou") {
      if (cookies) setKugouSession(cookies);
      else clearKugouSession();
    }
    if (next) rememberAccount(platform, next.profile);
  });
  ipcMain.handle(
    "apis:call",
    async (_evt, platform: ApiPlatform, name: string, params?: Record<string, unknown>) => {
      return callPlatformApi(platform, name, params);
    },
  );

  ipcMain.handle("apis:clearSession", (_evt, platform: ApiPlatform) => {
    const active = listSavedAccounts().find((item) => item.platform === platform && item.active);
    if (active) deleteSavedAccount(platform, active.profile.userId);
    if (platform === "netease") clearNeteaseCookies();
    if (platform === "qqmusic") {
      cancelQQMusicQr();
      clearQQMusicCookies();
    }
    if (platform === "kugou") clearKugouSession();
  });

  /** 打开官方网页登录，成功后把 cookies 合并写入 session */
  ipcMain.handle("apis:openLoginWeb", async (_evt, platform: ApiPlatform) => {
    try {
      if (platform === "netease") {
        const cookies = await openNeteaseLoginWindow();
        if (!cookies) return { ok: false, error: "canceled" };
        mergeNeteaseCookies(cookies);
        return { ok: true };
      }
      return { ok: false, error: "unsupported platform" };
    } catch (err) {
      coreLog.warn(`[apis] openLoginWeb ${platform} failed:`, err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** 手动写入 cookie 登录 */
  ipcMain.handle("apis:setCookie", (_evt, platform: ApiPlatform, raw: string) => {
    const parsed = cookieToJson(raw);
    if (platform === "netease") {
      if (!parsed.MUSIC_U) return { ok: false, error: "missing MUSIC_U" };
      mergeNeteaseCookies(parsed);
      return { ok: true };
    }
    if (platform === "qqmusic") {
      if (
        !parsed.uin &&
        !parsed.wxuin &&
        !parsed.p_uin &&
        !parsed.qm_keyst &&
        !parsed.qqmusic_key
      ) {
        return { ok: false, error: "missing uin or key" };
      }
      mergeQQMusicCookies(parsed);
      return { ok: true };
    }
    if (platform === "kugou") {
      if (!parsed.token || !parsed.userid) {
        return { ok: false, error: "missing token or userid" };
      }
      mergeKugouSession(parsed);
      return { ok: true };
    }
    return { ok: false, error: "unsupported platform" };
  });
};
