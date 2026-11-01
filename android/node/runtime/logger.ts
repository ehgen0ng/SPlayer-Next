import { inspect } from "node:util";
import { postNative } from "../bridge";

type Level = "debug" | "info" | "warn" | "error";

/**
 * 将作用域日志写入 Android 有界系统日志缓冲区
 * @param scope - 现有主进程日志作用域
 * @returns 与业务使用方式一致的日志方法
 */
const scoped = (scope: string): Record<Level, (...args: unknown[]) => void> =>
  Object.fromEntries(
    (["debug", "info", "warn", "error"] as const).map((level) => [
      level,
      (...args: unknown[]) => {
        const text = args
          .map((arg) =>
            typeof arg === "string" ? arg : inspect(arg, { depth: 3, maxArrayLength: 20 }),
          )
          .join(" ");
        postNative({ type: "log", level, message: `[${scope}] ${text}`.slice(0, 8000) });
      },
    ]),
  ) as Record<Level, (...args: unknown[]) => void>;

export const coreLog = scoped("core");
export const playerLog = scoped("player");
export const libraryLog = scoped("library");
export const systemLog = scoped("system");
export const neteaseLog = scoped("netease");
export const mediaLog = scoped("media");
export const pluginLog = scoped("plugin");
