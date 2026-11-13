import { PluginErrorCodes } from "@shared/defaults/plugin-api";

const FAILURE_LIMIT = 3;
const RETRY_DELAY_MS = 60_000;
const MAX_ENTRIES = 128;

/** 按插件和平台暂缓连续网络或认证失败，不把单曲缺失计为全平台故障 */
export class PluginSourceHealth {
  private readonly failures = new Map<
    string,
    { count: number; failedAt: number; retryAt: number }
  >();

  /**
   * 检查平台音源是否可以重试，过期记录随访问释放
   * @param pluginId - 插件标识
   * @param source - 插件平台标识
   * @returns 是否允许调用
   */
  isAvailable(pluginId: string, source: string): boolean {
    const key = `${pluginId}:${source}`;
    const failure = this.failures.get(key);
    if (!failure) return true;
    const now = Date.now();
    if (failure.retryAt > now) return false;
    if (now - failure.failedAt >= RETRY_DELAY_MS) this.failures.delete(key);
    return true;
  }

  /**
   * 记录连续服务故障，其他错误中断连续失败计数
   * @param pluginId - 插件标识
   * @param source - 插件平台标识
   * @param error - 请求抛出的错误
   */
  failed(pluginId: string, source: string, error: unknown): void {
    const key = `${pluginId}:${source}`;
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string } | null)?.code;
    const unavailable =
      code === PluginErrorCodes.REQUEST_TIMEOUT ||
      code === PluginErrorCodes.NETWORK_ERROR ||
      /timeout|timed out|超时|network error|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ERR_CONNECTION|人机验证|仅对认证用户开放|鉴权失败|认证失败|unauthorized|authentication required/iu.test(
        message,
      );
    if (!unavailable) {
      this.failures.delete(key);
      return;
    }
    const now = Date.now();
    const previous = this.failures.get(key);
    const count = previous && now - previous.failedAt < RETRY_DELAY_MS ? previous.count + 1 : 1;
    this.failures.delete(key);
    this.failures.set(key, {
      count,
      failedAt: now,
      retryAt: count >= FAILURE_LIMIT ? now + RETRY_DELAY_MS : 0,
    });
    if (this.failures.size > MAX_ENTRIES) this.failures.delete(this.failures.keys().next().value!);
  }

  /**
   * 成功取址后恢复该平台的连续失败计数
   * @param pluginId - 插件标识
   * @param source - 插件平台标识
   */
  succeeded(pluginId: string, source: string): void {
    this.failures.delete(`${pluginId}:${source}`);
  }
}

export const pluginSourceHealth = new PluginSourceHealth();
