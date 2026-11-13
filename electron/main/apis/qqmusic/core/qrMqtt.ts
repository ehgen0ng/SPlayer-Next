/** 原生 QM 二维码协议参考 NonsPlayer QQ 适配器（MIT），使用 MQTT v5 */
import WebSocket from "ws";
import { randomInt } from "node:crypto";

interface Cursor {
  position: number;
}

/**
 * 编码 MQTT 可变长度整数
 * @param value - 非负整数
 * @returns 最多四字节的协议字段
 */
const variable = (value: number): Buffer => {
  const bytes: number[] = [];
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value) byte |= 128;
    bytes.push(byte);
  } while (value);
  return Buffer.from(bytes);
};

/**
 * 编码 MQTT UTF-8 字符串
 * @param value - 字符串
 * @returns 带双字节长度前缀的内容
 */
const text = (value: string): Buffer => {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
};

/**
 * 编码 MQTT 用户属性
 * @param values - 属性键值对
 * @returns 含长度前缀的属性段
 */
const properties = (values: Record<string, string>): Buffer => {
  const data = Buffer.concat(
    Object.entries(values).map(([key, value]) =>
      Buffer.concat([Buffer.from([0x26]), text(key), text(value)]),
    ),
  );
  return Buffer.concat([variable(data.length), data]);
};

/**
 * 封装 MQTT 数据包
 * @param header - 类型与标记
 * @param body - 变长包体
 * @returns 可直接发送的二进制包
 */
const packet = (header: number, body: Buffer): Buffer =>
  Buffer.concat([Buffer.from([header]), variable(body.length), body]);

/**
 * 读取 MQTT 可变长度整数
 * @param data - 数据包
 * @param cursor - 读取位置
 * @returns 解码后的整数
 */
const readVariable = (data: Buffer, cursor: Cursor): number => {
  let result = 0;
  for (let index = 0; index < 4; index++) {
    if (cursor.position >= data.length) throw new Error("MQTT 数据不完整");
    const byte = data[cursor.position++];
    result += (byte & 127) * 128 ** index;
    if (!(byte & 128)) return result;
  }
  throw new Error("MQTT 长度无效");
};

/**
 * 读取 MQTT 字符串
 * @param data - 数据包
 * @param cursor - 读取位置
 * @returns UTF-8 字符串
 */
const readText = (data: Buffer, cursor: Cursor): string => {
  const length = data.readUInt16BE(cursor.position);
  cursor.position += 2;
  if (cursor.position + length > data.length) throw new Error("MQTT 字符串不完整");
  const value = data.toString("utf8", cursor.position, cursor.position + length);
  cursor.position += length;
  return value;
};

/**
 * 读取 MQTT v5 属性，保留事件类型和服务端重定向信息
 * @param data - 数据包
 * @param cursor - 读取位置
 * @returns 用户属性及服务端引用
 */
const readProperties = (data: Buffer, cursor: Cursor): Record<string, string> => {
  const size = readVariable(data, cursor);
  const end = cursor.position + size;
  if (end > data.length) throw new Error("MQTT 属性不完整");
  const values: Record<string, string> = {};
  while (cursor.position < end) {
    const id = readVariable(data, cursor);
    if (id === 0x26) {
      const key = readText(data, cursor);
      values[key] = readText(data, cursor);
    } else if ([0x03, 0x08, 0x12, 0x15, 0x1a, 0x1c, 0x1f].includes(id)) {
      values[String(id)] = readText(data, cursor);
    } else if ([0x01, 0x17, 0x19, 0x24, 0x25, 0x28, 0x29, 0x2a].includes(id)) {
      cursor.position++;
    } else if ([0x13, 0x21, 0x22, 0x23].includes(id)) {
      cursor.position += 2;
    } else if ([0x02, 0x11, 0x18, 0x27].includes(id)) {
      cursor.position += 4;
    } else if (id === 0x0b) {
      readVariable(data, cursor);
    } else if (id === 0x09 || id === 0x16) {
      const length = data.readUInt16BE(cursor.position);
      cursor.position += 2 + length;
    } else {
      throw new Error("不支持的 MQTT 属性");
    }
  }
  if (cursor.position !== end) throw new Error("MQTT 属性长度无效");
  return values;
};

export interface QrCredential {
  musicId: string;
  token: string;
}

/** 单个二维码的订阅连接，完成、取消或过期时立即释放 */
export class QrMqtt {
  status = 1;
  credential: QrCredential | null = null;
  error: Error | null = null;
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private socket: WebSocket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private timeout: ReturnType<typeof setTimeout>;
  private ping: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private redirects = 0;

  /**
   * 订阅二维码事件并限制连接存活时间
   * @param key - 服务端二维码 ID
   * @param lifetime - 二维码剩余有效期，单位毫秒
   */
  constructor(
    private readonly key: string,
    lifetime: number,
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.timeout = setTimeout(() => this.fail(new Error("二维码已过期")), lifetime);
    this.connect("/ws/handshake");
  }

  /** 释放连接、心跳及接收缓冲，不保留原始消息 */
  dispose(): void {
    this.stopped = true;
    clearTimeout(this.timeout);
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    this.buffer = Buffer.alloc(0);
    this.socket?.terminate();
    this.socket = null;
    this.rejectReady(new Error("二维码已关闭"));
  }

  /**
   * 终止失效的二维码并保留可显示的失败原因
   * @param error - 连接或协议错误
   */
  private fail(error: Error): void {
    if (this.stopped) return;
    this.status = 0;
    this.error = error;
    this.rejectReady(error);
    this.dispose();
  }

  /**
   * 连接原生 QM 消息代理，只允许同站点的协议重定向
   * @param path - 消息代理路径
   */
  private connect(path: string): void {
    const socket = new WebSocket(`wss://mu.y.qq.com${path}`, "mqtt", {
      handshakeTimeout: 8000,
      maxPayload: 64 * 1024,
      perMessageDeflate: false,
    });
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    socket.on("open", () => {
      const user = properties({
        tmeAppID: "qqmusic",
        business: "management",
        hashTag: this.key,
        clientTag: "management.user",
        userID: this.key,
      });
      const cursor = { position: 0 };
      readVariable(user, cursor);
      const auth = Buffer.concat([
        Buffer.from([0x15]),
        text("pass"),
        user.subarray(cursor.position),
      ]);
      socket.send(
        packet(
          0x10,
          Buffer.concat([
            text("MQTT"),
            Buffer.from([5, 2, 0, 45]),
            variable(auth.length),
            auth,
            text(`${Date.now()}${randomInt(10000)}`),
          ]),
        ),
      );
    });
    socket.on("error", () => {
      if (this.socket === socket) this.fail(new Error("QM 扫码连接失败，请重试"));
    });
    socket.on("close", () => {
      if (this.socket === socket) this.fail(new Error("QM 扫码连接已断开，请重试"));
    });
    socket.on("message", (data) => {
      if (this.stopped || this.socket !== socket) return;
      try {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        this.buffer = Buffer.concat([this.buffer, bytes]);
        if (this.buffer.length > 64 * 1024) throw new Error("QM 扫码消息过大");
        while (this.buffer.length > 1 && !this.stopped) {
          const cursor = { position: 1 };
          // MQTT 可变长度字段可能跨 WebSocket 帧
          let end = 1;
          while (end < this.buffer.length && this.buffer[end] & 128) end++;
          if (end >= this.buffer.length) break;
          const size = readVariable(this.buffer, cursor);
          if (this.buffer.length < cursor.position + size) break;
          const header = this.buffer[0];
          const body = this.buffer.subarray(cursor.position, cursor.position + size);
          this.buffer = this.buffer.subarray(cursor.position + size);
          this.receive(header, body, path);
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error("QM 扫码消息无效"));
      }
    });
  }

  /**
   * 处理连接确认、订阅确认和扫码状态消息
   * @param header - MQTT 包头
   * @param body - 完整包体
   * @param path - 当前代理路径
   */
  private receive(header: number, body: Buffer, path: string): void {
    const type = header >> 4;
    if (type === 2) {
      const cursor = { position: 2 };
      const values = readProperties(body, cursor);
      if ([0x9c, 0x9d].includes(body[1]) && values["28"] && this.redirects++ < 3) {
        const reference = values["28"];
        if (!/^[a-zA-Z0-9._:-]+$/.test(reference)) throw new Error("QM 代理地址无效");
        const old = this.socket;
        this.socket = null;
        old?.terminate();
        this.connect(`${path.replace(/\/[^/]*:[^/]*$/, "")}/${reference}`);
        return;
      }
      if (body[1] !== 0) throw new Error("QM 扫码连接被拒绝");
      this.socket?.send(
        packet(
          0x82,
          Buffer.concat([
            Buffer.from([0, 1]),
            properties({ authorization: "tmelogin", pubsub: "unicast" }),
            text(`management.qrcode_login/${this.key}`),
            Buffer.from([0]),
          ]),
        ),
      );
      this.ping = setInterval(() => this.socket?.send(Buffer.from([0xc0, 0])), 30000);
    } else if (type === 9) {
      const cursor = { position: 2 };
      readProperties(body, cursor);
      if (
        body.readUInt16BE(0) !== 1 ||
        cursor.position >= body.length ||
        body[cursor.position] >= 128
      ) {
        throw new Error("QM 扫码订阅被拒绝");
      }
      this.resolveReady();
    } else if (type === 3) {
      const cursor = { position: 0 };
      const topic = readText(body, cursor);
      const qos = (header >> 1) & 3;
      if (qos !== 0) throw new Error("QM 扫码消息 QoS 无效");
      const values = readProperties(body, cursor);
      if (topic !== `management.qrcode_login/${this.key}`) return;
      if (values.type === "scanned") this.status = 2;
      if (values.type === "cookies") {
        const payload = JSON.parse(body.toString("utf8", cursor.position)) as {
          cookies?: { qqmusic_uin?: { value?: string }; qqmusic_key?: { value?: string } };
        };
        const musicId = String(payload.cookies?.qqmusic_uin?.value ?? "");
        const token = payload.cookies?.qqmusic_key?.value;
        if (!/^\d+$/.test(musicId) || !token) throw new Error("QM 扫码凭据无效");
        this.credential = { musicId, token };
        this.status = 2;
        this.dispose();
      }
      if (["canceled", "timeout", "loginFailed"].includes(values.type)) {
        this.fail(new Error("QM 扫码已取消或过期"));
      }
    }
  }
}
