import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import QrLoginPanel from "./QrLoginPanel.vue";
import messages from "@/i18n/locales/zh-CN.json";
import type { QrLoginAdapter } from "@/apis/login/platform";

/**
 * 挂载二维码面板，使用实际生命周期与轮询计时器
 * @param adapter - 测试扫码适配器
 * @returns 组件实例
 */
const panel = (adapter: QrLoginAdapter) =>
  mount(QrLoginPanel, {
    props: { active: true, adapter },
    global: {
      plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": messages } })],
      stubs: { SLoading: true, SButton: { template: "<button><slot /></button>" } },
    },
  });

describe("二维码取消与并发控制", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("关闭时取消已显示的二维码，迟到成功不再触发登录回调", async () => {
    let finish!: (value: { state: "success" }) => void;
    const adapter = {
      create: vi.fn().mockResolvedValue({ key: "qr", content: "data:image/png;base64,x" }),
      check: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const wrapper = panel(adapter);
    await flushPromises();
    vi.advanceTimersByTime(1500);
    expect(adapter.check).toHaveBeenCalledOnce();
    await wrapper.setProps({ active: false });
    finish({ state: "success" });
    await flushPromises();
    expect(adapter.cancel).toHaveBeenCalledWith("qr");
    expect(wrapper.emitted("success")).toBeUndefined();
    wrapper.unmount();
  });

  it("生成中的窗口关闭后，迟到二维码立即取消，不启动轮询", async () => {
    let finish!: (value: { key: string; content: string }) => void;
    const adapter = {
      create: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
      check: vi.fn(),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const wrapper = panel(adapter);
    await wrapper.setProps({ active: false });
    finish({ key: "late", content: "data:image/png;base64,x" });
    await flushPromises();
    vi.advanceTimersByTime(5000);
    expect(adapter.cancel).toHaveBeenCalledWith("late");
    expect(adapter.check).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("慢轮询不会重叠，连接失败时显示可重试入口", async () => {
    const adapter = {
      create: vi.fn().mockResolvedValue({ key: "qr", content: "data:image/png;base64,x" }),
      check: vi.fn().mockReturnValue(new Promise(() => {})),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const wrapper = panel(adapter);
    await flushPromises();
    vi.advanceTimersByTime(6000);
    expect(adapter.check).toHaveBeenCalledOnce();
    wrapper.unmount();
    const failed = panel({
      create: vi.fn().mockRejectedValue(new Error("network")),
      check: vi.fn(),
    });
    await flushPromises();
    expect(failed.text()).toContain("二维码连接失败");
    expect(failed.find("button").text()).toBe("刷新二维码");
    failed.unmount();
  });
});
