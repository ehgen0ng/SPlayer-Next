import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginSourceHealth } from "./pluginSourceHealth";

afterEach(() => vi.useRealTimers());

describe("平台音源连续失败退避", () => {
  it("连续三次服务故障只暂停对应平台，一分钟后允许重试", () => {
    vi.useFakeTimers();
    const health = new PluginSourceHealth();
    for (let i = 0; i < 3; i++) health.failed("a", "tx", new Error("request timeout"));
    expect(health.isAvailable("a", "tx")).toBe(false);
    expect(health.isAvailable("a", "wy")).toBe(true);
    expect(health.isAvailable("b", "tx")).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(health.isAvailable("a", "tx")).toBe(true);
    health.failed("a", "tx", new Error("request timeout"));
    expect(health.isAvailable("a", "tx")).toBe(true);
  });

  it.each(["歌曲不存在", "不支持的音质: 192k", "get url failed", "PLUGIN_CANCELLED"])(
    "%s 不会暂停整个音源，成功请求也清除连续失败",
    (message) => {
      const health = new PluginSourceHealth();
      for (let i = 0; i < 5; i++) health.failed("a", "tx", new Error(message));
      expect(health.isAvailable("a", "tx")).toBe(true);
      health.failed("a", "tx", new Error("触发人机验证"));
      health.failed("a", "tx", new Error("触发人机验证"));
      health.succeeded("a", "tx");
      health.failed("a", "tx", new Error("触发人机验证"));
      expect(health.isAvailable("a", "tx")).toBe(true);
    },
  );

  it("忽略单曲错误并使失败记录保持有界", () => {
    const health = new PluginSourceHealth();
    health.failed("first", "tx", new Error("仅对认证用户开放"));
    health.failed("first", "tx", new Error("仅对认证用户开放"));
    health.failed("first", "tx", new Error("歌曲不存在"));
    health.failed("first", "tx", new Error("仅对认证用户开放"));
    expect(health.isAvailable("first", "tx")).toBe(true);
    for (let i = 0; i < 130; i++) {
      for (let n = 0; n < 3; n++) health.failed(`p${i}`, "tx", new Error("request timeout"));
    }
    expect(health.isAvailable("p0", "tx")).toBe(true);
    expect(health.isAvailable("p129", "tx")).toBe(false);
  });
});
