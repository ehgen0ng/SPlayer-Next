/**
 * 主进程音源 API 统一类型
 */

/** 支持的音源平台 */
export type ApiPlatform = "netease" | "qqmusic" | "kugou";

/** 已保存账号的公开资料，凭据仅在主进程持有 */
export interface SavedPlatformAccount {
  platform: ApiPlatform;
  profile: import("./platform").PlatformProfile;
  active: boolean;
}

/** 通用响应包装 */
export type ApiCallResponse =
  | { ok: true; status?: number; body?: unknown; data?: unknown }
  | { ok: false; error: string; status?: number; body?: unknown };

/** 渲染端统一入口 */
export interface ApisApi {
  /** 列出三个平台已保存的账号，不包含登录凭据 */
  listAccounts: () => Promise<SavedPlatformAccount[]>;
  /**
   * 切换指定平台的活动账号
   * @param platform - 音乐平台
   * @param userId - 已保存的账号 ID
   */
  switchAccount: (platform: ApiPlatform, userId: string) => Promise<void>;
  /**
   * 移除本地保存的账号，当前账号会同时退出
   * @param platform - 音乐平台
   * @param userId - 已保存的账号 ID
   */
  removeAccount: (platform: ApiPlatform, userId: string) => Promise<void>;
  /**
   * 调用任意音源接口
   * @param platform 音源平台
   * @param name 接口名
   * @param params 接口参数
   */
  call: (
    platform: ApiPlatform,
    name: string,
    params?: Record<string, unknown>,
  ) => Promise<ApiCallResponse>;
  /**
   * 清空指定平台的登录态
   * @param platform 音源平台
   */
  clearSession: (platform: ApiPlatform) => Promise<void>;
  /**
   * 打开官方网页登录
   * @param platform 音源平台
   * @returns 登录成功 `{ ok: true }`；用户取消 / 失败 `{ ok: false, error }`
   */
  openLoginWeb: (platform: ApiPlatform) => Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * 手动写入 cookie 登录（目前仅 netease）
   * @param platform 音源平台
   * @param cookie 形如 `MUSIC_U=xxx; __csrf=yyy` 的 cookie 字符串
   */
  setCookie: (
    platform: ApiPlatform,
    cookie: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}
