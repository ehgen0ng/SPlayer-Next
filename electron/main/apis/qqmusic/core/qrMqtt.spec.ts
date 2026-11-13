// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
const state = vi.hoisted(() => ({
  sockets: [] as (EventEmitter & {
    send: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  })[],
}));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    default: class extends EventEmitter {
      send = vi.fn();
      terminate = vi.fn();
      constructor() {
        super();
        state.sockets.push(this);
      }
    },
  };
});
import { QrMqtt } from "./qrMqtt";

/**
 * 创建消息代理的扫码事件包
 * @param kind - 扫码事件名称
 * @param payload - 事件数据
 * @returns MQTT v5 PUBLISH 样本
 */
const event = (kind: string, payload: object = {}): Buffer => {
  const topic = Buffer.from("management.qrcode_login/qr");
  const properties = Buffer.from([
    0x26,
    0,
    4,
    ...Buffer.from("type"),
    0,
    kind.length,
    ...Buffer.from(kind),
  ]);
  const body = Buffer.concat([
    Buffer.from([0, topic.length]),
    topic,
    Buffer.from([properties.length]),
    properties,
    Buffer.from(JSON.stringify(payload)),
  ]);
  const size =
    body.length < 128 ? [body.length] : [(body.length % 128) | 128, Math.floor(body.length / 128)];
  return Buffer.concat([Buffer.from([0x30, ...size]), body]);
};

/**
 * 完成测试代理的连接与订阅握手
 * @param session - 二维码订阅
 * @returns 当前代理连接
 */
const ready = async (session: QrMqtt) => {
  const socket = state.sockets.at(-1)!;
  socket.emit("open");
  socket.emit("message", Buffer.from([0x20, 3, 0, 0, 0]));
  socket.emit("message", Buffer.from([0x90, 4, 0, 1, 0, 0]));
  await session.ready;
  return socket;
};

describe("QM 原生二维码 MQTT 生命周期", () => {
  beforeEach(() => {
    state.sockets = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("连接及订阅使用原生二维码协议，扫码完成立即释放心跳和缓冲", async () => {
    const session = new QrMqtt("qr", 180000);
    const socket = await ready(session);
    const connect = socket.send.mock.calls[0][0] as Buffer;
    expect(connect.toString()).toContain("pass");
    expect(connect.toString()).toContain("management.user");
    expect((socket.send.mock.calls[1][0] as Buffer).toString()).toContain(
      "management.qrcode_login/qr",
    );
    socket.emit("message", event("scanned"));
    expect(session.status).toBe(2);
    socket.emit(
      "message",
      event("cookies", {
        cookies: { qqmusic_uin: { value: "123" }, qqmusic_key: { value: "secret" } },
      }),
    );
    expect(session.credential).toEqual({ musicId: "123", token: "secret" });
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("跨帧的扫码事件仅在包完整时解析", async () => {
    const session = new QrMqtt("qr", 180000);
    const socket = await ready(session);
    const message = event("scanned");
    socket.emit("message", message.subarray(0, 7));
    expect(session.status).toBe(1);
    socket.emit("message", message.subarray(7));
    expect(session.status).toBe(2);
    session.dispose();
  });

  it("到期或用户取消后不继续发送心跳，迟到授权不会恢复凭据", async () => {
    const session = new QrMqtt("qr", 1000);
    const socket = await ready(session);
    vi.advanceTimersByTime(1000);
    expect(session.status).toBe(0);
    expect(session.error?.message).toContain("过期");
    socket.emit(
      "message",
      event("cookies", {
        cookies: { qqmusic_uin: { value: "123" }, qqmusic_key: { value: "late" } },
      }),
    );
    expect(session.credential).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("连接失败时结束等待，不悬挂生成任务", async () => {
    const session = new QrMqtt("qr", 180000);
    const rejected = expect(session.ready).rejects.toThrow("连接失败");
    state.sockets[0].emit("error", new Error("network"));
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
