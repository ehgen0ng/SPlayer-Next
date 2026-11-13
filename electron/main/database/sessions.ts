import { getDb } from "./index";
import type { Platform, PlatformProfile } from "@shared/types/platform";
import type { SavedPlatformAccount } from "@shared/types/apis";

interface SessionRow {
  cookies: string;
  account_id: string | null;
}

const accountVersions: Record<Platform, number> = { netease: 0, qqmusic: 0, kugou: 0 };

/**
 * 读取平台会话的账号代次，用于丢弃换号前的异步结果
 * @param platform - 音乐平台
 * @returns 当前账号代次
 */
export const getAccountVersion = (platform: Platform): number => accountVersions[platform];

/**
 * 读取某平台的 Cookie，未登录返回空对象
 * @param platform - 音乐平台
 * @returns 当前会话字段
 */
export const getSessionCookies = (platform: Platform): Record<string, string> => {
  const row = getDb()
    .prepare("SELECT cookies FROM account_sessions WHERE platform = ?")
    .get(platform) as Pick<SessionRow, "cookies"> | undefined;
  return row ? (JSON.parse(row.cookies) as Record<string, string>) : {};
};

/**
 * 整体替换平台会话，同一账号的续期同步更新已保存的凭据
 * @param platform - 音乐平台
 * @param cookies - 完整会话字段
 * @param keepAccount - 网易云续期时保留已验证的账号身份
 */
export const saveSessionCookies = (
  platform: Platform,
  cookies: Record<string, string>,
  keepAccount = false,
): void => {
  const db = getDb();
  const previous = db
    .prepare("SELECT cookies, account_id FROM account_sessions WHERE platform = ?")
    .get(platform) as SessionRow | undefined;
  const old = previous ? (JSON.parse(previous.cookies) as Record<string, string>) : {};
  let accountId: string | null = null;
  let changed: boolean;
  if (platform === "netease") {
    changed = old.MUSIC_U !== cookies.MUSIC_U && !keepAccount;
    if (cookies.MUSIC_U && (!changed || keepAccount)) accountId = previous?.account_id ?? null;
  } else if (platform === "qqmusic") {
    const id = cookies.qm_str_musicid || cookies.uin || cookies.wxuin || cookies.p_uin;
    if (id && (cookies.qm_keyst || cookies.qqmusic_key)) accountId = id.replace(/^o/, "");
    const oldId = old.qm_str_musicid || old.uin || old.wxuin || old.p_uin;
    changed = (oldId?.replace(/^o/, "") ?? null) !== accountId;
  } else {
    if (cookies.token && cookies.userid) accountId = cookies.userid;
    changed = (old.token ? old.userid : null) !== accountId;
  }
  const serialized = JSON.stringify(cookies);
  db.prepare(
    `INSERT INTO account_sessions (platform, cookies, account_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(platform) DO UPDATE SET cookies = excluded.cookies,
       account_id = excluded.account_id, updated_at = excluded.updated_at`,
  ).run(platform, serialized, accountId, Date.now());
  if (accountId) {
    db.prepare(
      `UPDATE platform_accounts SET cookies = ?, updated_at = ? WHERE platform = ? AND user_id = ?`,
    ).run(serialized, Date.now(), platform, accountId);
  }
  if (changed) accountVersions[platform]++;
};

/**
 * 保存服务端确认的账号资料和当前凭据，兼容原有单账号数据
 * @param platform - 音乐平台
 * @param profile - 已验证的公开资料
 */
export const rememberAccount = (platform: Platform, profile: PlatformProfile): void => {
  const db = getDb();
  const cookies = getSessionCookies(platform);
  if (platform === "netease" && !cookies.MUSIC_U) return;
  if (platform === "qqmusic" && !(cookies.qm_keyst || cookies.qqmusic_key)) return;
  if (platform === "kugou" && !cookies.token) return;
  db.prepare(
    `INSERT INTO platform_accounts (platform, user_id, cookies, profile, updated_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(platform, user_id) DO UPDATE SET
       cookies = excluded.cookies, profile = excluded.profile, updated_at = excluded.updated_at`,
  ).run(platform, profile.userId, JSON.stringify(cookies), JSON.stringify(profile), Date.now());
  db.prepare("UPDATE account_sessions SET account_id = ? WHERE platform = ?").run(
    profile.userId,
    platform,
  );
};

/**
 * 列出已保存账号的公开资料和各平台的当前选择
 * @returns 按平台和更新时间排列的账号列表
 */
export const listSavedAccounts = (): SavedPlatformAccount[] => {
  const rows = getDb()
    .prepare(
      `SELECT a.platform, a.profile, s.account_id = a.user_id AS active
       FROM platform_accounts a LEFT JOIN account_sessions s ON s.platform = a.platform
       ORDER BY a.platform, a.updated_at DESC, a.user_id`,
    )
    .all() as { platform: Platform; profile: string; active: number | null }[];
  return rows.map((row) => ({
    platform: row.platform,
    profile: JSON.parse(row.profile) as PlatformProfile,
    active: !!row.active,
  }));
};

/**
 * 读取保存的凭据，仅供主进程恢复账号
 * @param platform - 音乐平台
 * @param userId - 已保存账号的 ID
 * @returns 完整会话字段
 */
export const getSavedAccountCookies = (
  platform: Platform,
  userId: string,
): Record<string, string> => {
  const row = getDb()
    .prepare("SELECT cookies FROM platform_accounts WHERE platform = ? AND user_id = ?")
    .get(platform, userId) as { cookies: string } | undefined;
  if (!row) throw new Error("账号未保存，请重新登录");
  return JSON.parse(row.cookies) as Record<string, string>;
};

/**
 * 删除保存的账号资料和凭据
 * @param platform - 音乐平台
 * @param userId - 账号 ID
 */
export const deleteSavedAccount = (platform: Platform, userId: string): void => {
  getDb()
    .prepare("DELETE FROM platform_accounts WHERE platform = ? AND user_id = ?")
    .run(platform, userId);
};

/**
 * 清空平台当前会话，保留其他已保存的账号
 * @param platform - 音乐平台
 */
export const clearSessionCookies = (platform: Platform): void => {
  saveSessionCookies(platform, {});
};
