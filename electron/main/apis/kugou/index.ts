/**
 * KG 主进程服务
 *
 * 统一入口：callKugou(name, params)
 */

import { createHash } from "node:crypto";
import { modules } from "./modules";
import type { KGParams } from "./core/types";
import { getSessionCookies, saveSessionCookies, getAccountVersion } from "@main/database/sessions";

export const getKugouSession = (): Record<string, string> => getSessionCookies("kugou");

/**
 * 合并酷狗凭据，换号时仅保留设备标识
 * @param values - 新登录或续期返回的会话字段
 */
export const mergeKugouSession = (values: Record<string, string>): void => {
  const current = getKugouSession();
  const base =
    values.userid && values.userid !== current.userid
      ? { guid: current.guid || "", dfid: current.dfid || "" }
      : current;
  saveSessionCookies("kugou", { ...base, ...values });
  clearKugouCache();
};

/**
 * 整体恢复已保存的酷狗会话并清理账号相关缓存
 * @param values - 完整会话字段
 */
export const setKugouSession = (values: Record<string, string>): void => {
  saveSessionCookies("kugou", values);
  clearKugouCache();
};

/** 清除当前酷狗账号并保留设备身份 */
export const clearKugouSession = (): void => {
  const session = getKugouSession();
  const device = {
    ...(session.guid ? { guid: session.guid } : {}),
    ...(session.dfid ? { dfid: session.dfid } : {}),
  };
  saveSessionCookies("kugou", device);
  clearKugouCache();
};

/** 2 分钟响应缓存 */
const DEFAULT_TTL = 2 * 60 * 1000;
const MAX_ENTRIES = 200;
const NON_CACHEABLE = new Set([
  "login_qr_key",
  "login_qr_check",
  "user_detail",
  "song_url",
  "comment",
]);

interface CacheEntry {
  value: unknown;
  expireAt: number;
}

const cache = new Map<string, CacheEntry>();

const hashParams = (params: unknown): string =>
  createHash("md5")
    .update(JSON.stringify(params ?? {}))
    .digest("hex")
    .slice(0, 8);

const cacheGet = (key: string): unknown => {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expireAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
};

const cacheSet = (key: string, value: unknown, ttl = DEFAULT_TTL): void => {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expireAt: Date.now() + ttl });
};

export const clearKugouCache = (): void => {
  cache.clear();
};

const isEmptyResult = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (Array.isArray(v.songs) && v.songs.length === 0) return true;
  if (Array.isArray(v.albums) && v.albums.length === 0) return true;
  if (Array.isArray(v.artists) && v.artists.length === 0) return true;
  if (Array.isArray(v.playlists) && v.playlists.length === 0) return true;
  return false;
};

/**
 * 调用任意 KG API
 * @param name - 模块名称（search / lyric）
 * @param params - 业务参数
 * @returns 业务数据
 */
export const callKugou = async <T = unknown>(name: string, params: KGParams = {}): Promise<T> => {
  const fn = Object.hasOwn(modules, name) ? modules[name] : undefined;
  if (!fn) throw new Error(`unknown kg api: ${name}`);

  if (NON_CACHEABLE.has(name)) return (await fn(params)) as T;

  const version = getAccountVersion("kugou");
  const key = `${version}|${name}|${hashParams(params)}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit as T;

  const value = (await fn(params)) as T;
  if (version === getAccountVersion("kugou") && !isEmptyResult(value)) cacheSet(key, value);
  return value;
};
