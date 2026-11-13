import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_PLATFORMS, type Platform } from "@shared/types/platform";

const mocks = vi.hoisted(() => ({
  db: null as import("node:sqlite").DatabaseSync | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  setNetease: vi.fn(),
  clearNetease: vi.fn(),
  setQQMusic: vi.fn(),
  clearQQMusic: vi.fn(),
  setKugou: vi.fn(),
  clearKugou: vi.fn(),
  cancelQr: vi.fn(),
}));
vi.mock("@main/database/index", () => ({ getDb: () => mocks.db }));
vi.mock("@main/runtime/ipc", () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, handler),
  },
}));
vi.mock("@main/apis/netease", () => ({
  setNeteaseCookies: mocks.setNetease,
  clearNeteaseCookies: mocks.clearNetease,
  mergeNeteaseCookies: vi.fn(),
}));
vi.mock("@main/apis/qqmusic", () => ({
  clearQQMusicCookies: mocks.clearQQMusic,
  mergeQQMusicCookies: vi.fn(),
}));
vi.mock("@main/apis/qqmusic/core/request", () => ({ setQQMusicCookies: mocks.setQQMusic }));
vi.mock("@main/apis/qqmusic/modules/login_qr", () => ({ cancelQQMusicQr: mocks.cancelQr }));
vi.mock("@main/apis/kugou", () => ({
  setKugouSession: mocks.setKugou,
  clearKugouSession: mocks.clearKugou,
  mergeKugouSession: vi.fn(),
}));
vi.mock("@main/runtime/login", () => ({ openNeteaseLoginWindow: vi.fn() }));
vi.mock("@main/utils/logger", () => ({ coreLog: { warn: vi.fn() } }));
vi.mock("@main/services/platformApi", () => ({ callPlatformApi: vi.fn() }));

import {
  clearSessionCookies,
  getSessionCookies,
  listSavedAccounts,
  rememberAccount,
  saveSessionCookies,
} from "@main/database/sessions";
import { registerApisIpc } from "./apis";

/**
 * 保存测试账号并激活对应会话
 * @param platform - 音乐平台
 * @param id - 账号 ID
 * @returns 用于核对恢复结果的凭据
 */
const saveAccount = (platform: Platform, id: string): Record<string, string> => {
  const cookies: Record<string, string> =
    platform === "netease"
      ? { MUSIC_U: `key-${id}` }
      : platform === "qqmusic"
        ? { uin: id, qm_keyst: `key-${id}` }
        : { userid: id, token: `key-${id}` };
  saveSessionCookies(platform, cookies);
  rememberAccount(platform, { userId: id, nickname: id, avatarUrl: "", isVip: false });
  return cookies;
};

describe("删除保存账号的会话接续", () => {
  beforeEach(() => {
    mocks.db = new DatabaseSync(":memory:");
    mocks.db.exec(`
      CREATE TABLE account_sessions (platform TEXT PRIMARY KEY, cookies TEXT, account_id TEXT, updated_at INTEGER);
      CREATE TABLE platform_accounts (platform TEXT, user_id TEXT, cookies TEXT, profile TEXT, updated_at INTEGER, PRIMARY KEY(platform,user_id));
    `);
    for (const [platform, set, clear] of [
      ["netease", mocks.setNetease, mocks.clearNetease],
      ["qqmusic", mocks.setQQMusic, mocks.clearQQMusic],
      ["kugou", mocks.setKugou, mocks.clearKugou],
    ] as const) {
      set.mockImplementation((cookies) => saveSessionCookies(platform, cookies));
      clear.mockImplementation(() => clearSessionCookies(platform));
    }
    mocks.handlers.clear();
    registerApisIpc();
  });
  afterEach(() => mocks.db?.close());

  it.each(ALL_PLATFORMS)("%s 删除当前账号后恢复最近使用的同平台账号", (platform) => {
    const expected = saveAccount(platform, "1");
    saveAccount(platform, "2");
    saveAccount(platform, "3");
    mocks.db!.prepare("UPDATE platform_accounts SET updated_at = ? WHERE user_id = ?").run(10, "1");
    mocks.db!.prepare("UPDATE platform_accounts SET updated_at = ? WHERE user_id = ?").run(1, "2");
    mocks.handlers.get("apis:removeAccount")!(null, platform, "3");
    expect(getSessionCookies(platform)).toEqual(expected);
    expect(listSavedAccounts().find((item) => item.active)?.profile.userId).toBe("1");
    expect(listSavedAccounts().map((item) => item.profile.userId)).not.toContain("3");
    if (platform === "qqmusic") expect(mocks.cancelQr).toHaveBeenCalledOnce();
  });

  it.each(ALL_PLATFORMS)("%s 删除最后一个账号只清空该平台会话", (platform) => {
    for (const target of ALL_PLATFORMS) saveAccount(target, "1");
    mocks.handlers.get("apis:removeAccount")!(null, platform, "1");
    expect(getSessionCookies(platform)).toEqual({});
    expect(listSavedAccounts()).toHaveLength(2);
    expect(listSavedAccounts().every((item) => item.active && item.platform !== platform)).toBe(
      true,
    );
  });

  it.each(ALL_PLATFORMS)("%s 删除非当前账号不更改当前会话", (platform) => {
    saveAccount(platform, "1");
    const expected = saveAccount(platform, "2");
    mocks.handlers.get("apis:removeAccount")!(null, platform, "1");
    expect(getSessionCookies(platform)).toEqual(expected);
    expect(listSavedAccounts()).toMatchObject([{ active: true, profile: { userId: "2" } }]);
    expect(mocks.cancelQr).not.toHaveBeenCalled();
  });
});
