// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "@shared/types/platform";
const state = vi.hoisted(() => ({ db: null as DatabaseSync | null }));
vi.mock("./index", () => ({ getDb: () => state.db }));
import {
  saveSessionCookies,
  getSessionCookies,
  rememberAccount,
  listSavedAccounts,
  getSavedAccountCookies,
  deleteSavedAccount,
  clearSessionCookies,
  getAccountVersion,
} from "./sessions";

/**
 * 创建不同平台的凭据样本
 * @param platform - 音乐平台
 * @param id - 账号 ID
 * @returns 会话字段
 */
const cookies = (platform: Platform, id: string): Record<string, string> =>
  platform === "netease"
    ? { MUSIC_U: `key-${id}` }
    : platform === "qqmusic"
      ? { uin: id, qm_keyst: `key-${id}` }
      : { userid: id, token: `key-${id}` };

describe("三平台多账号持久化", () => {
  beforeEach(() => {
    state.db = new DatabaseSync(":memory:");
    state.db
      .exec(`CREATE TABLE account_sessions (platform TEXT PRIMARY KEY, cookies TEXT, account_id TEXT, updated_at INTEGER);
      CREATE TABLE platform_accounts (platform TEXT, user_id TEXT, cookies TEXT, profile TEXT, updated_at INTEGER, PRIMARY KEY(platform,user_id));`);
  });
  afterEach(() => state.db?.close());

  it.each(["netease", "qqmusic", "kugou"] as const)(
    "%s 保存两账号并往返恢复，列表不包含凭据",
    (platform) => {
      for (const id of ["1", "2"]) {
        saveSessionCookies(platform, cookies(platform, id));
        rememberAccount(platform, {
          userId: id,
          nickname: `账号 ${id}`,
          avatarUrl: "",
          isVip: false,
        });
      }
      const accounts = listSavedAccounts();
      expect(accounts).toHaveLength(2);
      expect(accounts.find((item) => item.active)?.profile.userId).toBe("2");
      expect(JSON.stringify(accounts)).not.toContain("key-");
      const first = getSavedAccountCookies(platform, "1");
      expect(first).toEqual(cookies(platform, "1"));
      saveSessionCookies(platform, first);
      rememberAccount(platform, accounts.find((item) => item.profile.userId === "1")!.profile);
      expect(listSavedAccounts().find((item) => item.active)?.profile.userId).toBe("1");
      expect(getSavedAccountCookies(platform, "2")).toEqual(cookies(platform, "2"));
    },
  );

  it("网易云续期更新当前账号，新增登录不会覆盖旧账号快照", () => {
    saveSessionCookies("netease", { MUSIC_U: "first" });
    rememberAccount("netease", { userId: "1", nickname: "A", avatarUrl: "", isVip: false });
    const version = getAccountVersion("netease");
    saveSessionCookies("netease", { MUSIC_U: "renewed" }, true);
    expect(getAccountVersion("netease")).toBe(version);
    expect(getSavedAccountCookies("netease", "1")).toEqual({ MUSIC_U: "renewed" });
    saveSessionCookies("netease", { MUSIC_U: "second" });
    expect(getAccountVersion("netease")).toBeGreaterThan(version);
    expect(listSavedAccounts()[0].active).toBe(false);
    expect(getSavedAccountCookies("netease", "1")).toEqual({ MUSIC_U: "renewed" });
  });

  it("相同 ID 在不同平台独立存储，删除单个账号不清除其他平台", () => {
    for (const platform of ["netease", "qqmusic", "kugou"] as const) {
      saveSessionCookies(platform, cookies(platform, "1"));
      rememberAccount(platform, { userId: "1", nickname: platform, avatarUrl: "", isVip: false });
    }
    deleteSavedAccount("qqmusic", "1");
    clearSessionCookies("qqmusic");
    expect(listSavedAccounts().map((item) => item.platform)).toEqual(["kugou", "netease"]);
    expect(getSessionCookies("netease")).toEqual({ MUSIC_U: "key-1" });
    expect(() => getSavedAccountCookies("qqmusic", "1")).toThrow("账号未保存");
  });

  it("原有单账号在验证资料后加入列表，退出当前会话保留其他快照", () => {
    state
      .db!.prepare("INSERT INTO account_sessions VALUES (?, ?, NULL, 1)")
      .run("qqmusic", JSON.stringify(cookies("qqmusic", "100")));
    rememberAccount("qqmusic", { userId: "100", nickname: "旧账号", avatarUrl: "", isVip: false });
    expect(listSavedAccounts()).toMatchObject([{ active: true, profile: { userId: "100" } }]);
    clearSessionCookies("qqmusic");
    expect(listSavedAccounts()).toMatchObject([{ active: false }]);
    expect(getSavedAccountCookies("qqmusic", "100")).toEqual(cookies("qqmusic", "100"));
  });
});
