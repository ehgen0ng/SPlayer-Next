type Listener = (event: unknown, ...args: any[]) => unknown;

const handlers = new Map<string, Listener>();

/**
 * 注册静态业务通道，重复注册直接报错
 * @param channel - 既有 IPC 通道
 * @param listener - 共用业务处理器
 */
const register = (channel: string, listener: Listener): void => {
  if (handlers.has(channel)) throw new Error(`重复的业务通道: ${channel}`);
  handlers.set(channel, listener);
};

export const ipcMain = { handle: register, on: register };

/**
 * 执行已注册的业务处理器，不开放任意模块或方法访问
 * @param channel - 业务通道
 * @param args - 参数列表
 * @returns 业务处理器结果
 */
export const dispatch = (channel: string, args: unknown[]): unknown => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`安卓不支持此操作: ${channel}`);
  return handler(undefined, ...args);
};
