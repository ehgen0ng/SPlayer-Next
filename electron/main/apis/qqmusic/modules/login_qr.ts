import { qmRequest, mergeQQMusicCookies } from "../core/request";
import {
  credentialToSession,
  getCredentialMusicId,
  type QQMusicCredential,
} from "../core/credential";
import { QrMqtt } from "../core/qrMqtt";
import { getAccountVersion } from "@main/database/sessions";
import { coreLog } from "@main/utils/logger";
import type { QMModule } from "../core/types";

const WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36";
interface PendingLogin {
  key: string;
  type: string;
  version: number;
  mqtt?: QrMqtt;
  pending?: Promise<QQMusicCredential>;
}
let active: PendingLogin | null = null;
let requestSerial = 0;

/**
 * 关闭当前 QM 二维码并释放临时凭据
 * @param key - 指定二维码，省略时取消当前登录
 */
export const cancelQQMusicQr = (key?: string): void => {
  if (key && active?.key !== key) return;
  requestSerial++;
  if (active?.mqtt) {
    active.mqtt.dispose();
    active.mqtt.credential = null;
  }
  active = null;
};

/**
 * 生成支持 QQ 和 QQ 音乐 App 的原生二维码，或微信二维码
 * @param params - 登录类型 qq 或 wx
 * @returns 二维码 ID 与图片
 */
export const login_qr_key: QMModule = async (params) => {
  cancelQQMusicQr();
  const serial = requestSerial;
  const version = getAccountVersion("qqmusic");
  const type = String(params.type ?? "qq");
  if (type === "wx") {
    const searchParams = new URLSearchParams({
      appid: "wx48db31d50e334801",
      redirect_uri: "https://y.qq.com/portal/wx_redirect.html?login_type=2&surl=https://y.qq.com/",
      response_type: "code",
      scope: "snsapi_login",
      state: "STATE",
      href: "https://y.qq.com/mediastyle/music_v17/src/css/popup_wechat.css#wechat_redirect",
    });
    const res = await fetch(`https://open.weixin.qq.com/connect/qrconnect?${searchParams}`, {
      headers: { "User-Agent": WEB_UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`获取微信登录页面失败: HTTP ${res.status}`);
    const html = await res.text();
    const match = /uuid=([^"]+)"/.exec(html) || /uuid=([a-zA-Z0-9_-]+)/.exec(html);
    if (!match) throw new Error("获取微信登录二维码 uuid 失败");
    const uuid = match[1];

    const qrRes = await fetch(`https://open.weixin.qq.com/connect/qrcode/${uuid}`, {
      headers: {
        Referer: "https://open.weixin.qq.com/connect/qrconnect",
        "User-Agent": WEB_UA,
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!qrRes.ok) throw new Error(`获取微信登录二维码图片失败: HTTP ${qrRes.status}`);
    const qrBuffer = await qrRes.arrayBuffer();
    const base64 = Buffer.from(qrBuffer).toString("base64");

    if (serial !== requestSerial) throw new Error("二维码已关闭");
    active = { key: uuid, type, version };
    return {
      code: 200,
      key: uuid,
      content: `data:image/jpeg;base64,${base64}`,
      type: "wx",
    };
  }
  const data = await qmRequest<{ qrcodeID: string; qrcode: string; expiresIn?: number }>(
    "music.login.LoginServer",
    "CreateQRCode",
    { tmeAppID: "qqmusic", ct: 11, cv: 14090008 },
    { session: false, auth: false, comm: { ct: 23, cv: 0 }, autoRefresh: false },
  );
  if (serial !== requestSerial || version !== getAccountVersion("qqmusic")) {
    throw new Error("二维码已关闭");
  }
  const image = Buffer.from(data.qrcode.split(",").at(-1) ?? "", "base64");
  if (
    !data.qrcodeID ||
    !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    throw new Error("QM 二维码响应无效");
  }
  const mqtt = new QrMqtt(data.qrcodeID, Math.min(data.expiresIn || 180, 180) * 1000);
  const session: PendingLogin = { key: data.qrcodeID, type: "qq", version, mqtt };
  active = session;
  try {
    await mqtt.ready;
    if (active !== session) throw new Error("二维码已关闭");
    return {
      code: 200,
      key: session.key,
      content: `data:image/png;base64,${image.toString("base64")}`,
      type: "qq",
    };
  } catch (error) {
    if (active === session) cancelQQMusicQr();
    throw error;
  }
};

/**
 * 查询扫码状态，确认新凭据有效后才切换活动账号
 * @param params - 二维码 ID 和登录类型
 * @returns 与通用二维码面板兼容的状态
 */
export const login_qr_check: QMModule = async (params) => {
  const session = active;
  if (!session || session.key !== String(params.key ?? "")) return { code: 200, status: 0 };
  if (session.version !== getAccountVersion("qqmusic")) {
    cancelQQMusicQr(session.key);
    return { code: 200, status: 0 };
  }
  let credential: QQMusicCredential;
  if (session.type === "wx") {
    const query = new URLSearchParams({ uuid: session.key, _: String(Date.now()) });
    const response = await fetch(`https://lp.open.weixin.qq.com/connect/l/qrconnect?${query}`, {
      headers: { Referer: "https://open.weixin.qq.com/", "User-Agent": WEB_UA },
      signal: AbortSignal.timeout(35000),
    });
    const value = await response.text();
    if (active !== session) return { code: 200, status: 0 };
    const match = /window\.wx_errcode=(\d+);window\.wx_code='([^']*)'/.exec(value);
    const code = Number(match?.[1]);
    if (code === 404) return { code: 200, status: 2 };
    if (code === 402 || code === 403) {
      cancelQQMusicQr(session.key);
      return { code: 200, status: 0 };
    }
    if (code !== 405 || !match?.[2]) return { code: 200, status: 1 };
    session.pending ??= qmRequest<QQMusicCredential>(
      "music.login.LoginServer",
      "Login",
      { code: match[2], strAppid: "wx48db31d50e334801" },
      { session: false, auth: false, comm: { tmeLoginType: 1 }, autoRefresh: false },
    );
    credential = await session.pending;
  } else {
    const mqtt = session.mqtt!;
    if (mqtt.error) throw mqtt.error;
    const scanned = mqtt.credential;
    if (!scanned) return { code: 200, status: mqtt.status };
    session.pending ??= (async () => {
      try {
        const result = await qmRequest<QQMusicCredential>(
          "music.login.LoginServer",
          "Login",
          { musicid: Number(scanned.musicId), qrCodeID: session.key, token: scanned.token },
          { session: false, auth: false, comm: { tmeLoginType: 6 }, autoRefresh: false },
        );
        if (!result.musickey || !getCredentialMusicId(result)) throw new Error("QM 登录凭据不完整");
        return result;
      } catch {
        const direct: QQMusicCredential = {
          str_musicid: scanned.musicId,
          musickey: scanned.token,
          loginType: 6,
        };
        await qmRequest(
          "music.UserInfo.userInfoServer",
          "GetLoginUserInfo",
          {},
          {
            session: false,
            cookies: credentialToSession(direct, 6),
            autoRefresh: false,
          },
        );
        return direct;
      }
    })();
    credential = await session.pending;
  }
  if (active !== session || session.version !== getAccountVersion("qqmusic"))
    return { code: 200, status: 0 };
  if (!getCredentialMusicId(credential) || !credential.musickey)
    throw new Error("QM 登录响应缺少有效凭据");
  const cookies = credentialToSession(credential, session.type === "wx" ? 1 : 6);
  cancelQQMusicQr(session.key);
  mergeQQMusicCookies(cookies);
  coreLog.info("[qm-login] 扫码登录成功");
  return {
    code: 200,
    status: 4,
    nickname: credential.nick || credential.nickname,
    avatarUrl: credential.logo || credential.avatarUrl,
  };
};

/**
 * 取消指定的 QM 扫码登录
 * @param params - 二维码 ID
 * @returns 取消结果
 */
export const login_qr_cancel: QMModule = async (params) => {
  cancelQQMusicQr(String(params.key ?? ""));
  return { code: 200 };
};
