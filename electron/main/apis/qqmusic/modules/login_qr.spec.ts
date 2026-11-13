import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  version: 0,
  request: vi.fn(),
  merge: vi.fn(),
  sessions: [] as {
    status: number;
    error: Error | null;
    credential: { musicId: string; token: string } | null;
    dispose: ReturnType<typeof vi.fn>;
  }[],
}));
vi.mock("../core/request", () => ({ qmRequest: state.request, mergeQQMusicCookies: state.merge }));
vi.mock("@main/database/sessions", () => ({ getAccountVersion: () => state.version }));
vi.mock("@main/utils/logger", () => ({ coreLog: { info: vi.fn() } }));
vi.mock("../core/qrMqtt", () => ({
  QrMqtt: class {
    ready = Promise.resolve();
    status = 1;
    error = null;
    credential: { musicId: string; token: string } | null = null;
    dispose = vi.fn();
    constructor() {
      state.sessions.push(this);
    }
  },
}));
import { login_qr_key, login_qr_check, cancelQQMusicQr } from "./login_qr";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
describe("QM 原生扫码授权", () => {
  beforeEach(() => {
    state.version = 0;
    state.sessions = [];
    state.merge.mockReset();
    state.request
      .mockReset()
      .mockImplementation(async (_module, method) =>
        method === "CreateQRCode"
          ? { qrcodeID: "qr", qrcode: png, expiresIn: 900 }
          : { str_musicid: "100", musickey: "new-key", loginType: 6 },
      );
  });
  afterEach(() => cancelQQMusicQr());

  it("原生二维码生成使用匿名请求，同一二维码同时接受 QQ 和 QQ 音乐的授权事件", async () => {
    expect(await login_qr_key({})).toMatchObject({
      key: "qr",
      content: `data:image/png;base64,${png}`,
    });
    expect(state.request).toHaveBeenCalledWith(
      "music.login.LoginServer",
      "CreateQRCode",
      { tmeAppID: "qqmusic", ct: 11, cv: 14090008 },
      expect.objectContaining({ auth: false, comm: { ct: 23, cv: 0 } }),
    );
    state.sessions[0].credential = { musicId: "100", token: "scan-token" };
    expect(await login_qr_check({ key: "qr" })).toMatchObject({ status: 4 });
    expect(state.merge).toHaveBeenCalledWith(
      expect.objectContaining({ uin: "100", qm_keyst: "new-key", tmeLoginType: "6" }),
    );
  });

  it("交换失败时先验证扫码凭据，不把未经验证的密钥写入活动会话", async () => {
    await login_qr_key({});
    state.sessions[0].credential = { musicId: "100", token: "scan-token" };
    state.request.mockRejectedValueOnce(new Error("exchange"));
    await login_qr_check({ key: "qr" });
    expect(state.request).toHaveBeenLastCalledWith(
      "music.UserInfo.userInfoServer",
      "GetLoginUserInfo",
      {},
      expect.objectContaining({
        cookies: expect.objectContaining({ uin: "100", qm_keyst: "scan-token" }),
        autoRefresh: false,
      }),
    );
    expect(state.merge).toHaveBeenCalledWith(expect.objectContaining({ qm_keyst: "scan-token" }));
  });

  it("取消时正在交换的旧授权不能覆盖当前账号", async () => {
    await login_qr_key({});
    state.sessions[0].credential = { musicId: "100", token: "scan-token" };
    let finish!: (value: object) => void;
    state.request.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = login_qr_check({ key: "qr" });
    cancelQQMusicQr();
    finish({ str_musicid: "100", musickey: "old-key" });
    expect(await pending).toMatchObject({ status: 0 });
    expect(state.merge).not.toHaveBeenCalled();
  });

  it("换号会结束旧二维码，重复轮询不能重复提交授权", async () => {
    await login_qr_key({});
    state.version++;
    expect(await login_qr_check({ key: "qr" })).toMatchObject({ status: 0 });
    expect(state.sessions[0].dispose).toHaveBeenCalled();
    expect(state.merge).not.toHaveBeenCalled();
  });
});
