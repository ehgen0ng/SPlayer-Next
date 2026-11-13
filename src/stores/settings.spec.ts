import { afterEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { defaultSystemConfig } from "@shared/defaults/settings";
import { useSettingsStore } from "./settings";

vi.mock("@/platform", () => ({ isAndroid: true }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("设置初始化", () => {
  it("没有 structuredClone 时仍创建独立的嵌套配置副本", () => {
    vi.stubGlobal("structuredClone", undefined);
    setActivePinia(createPinia());
    const first = useSettingsStore();
    expect(first.system).toEqual(defaultSystemConfig);
    first.system.player.equalizer.bands[0] = 6;
    setActivePinia(createPinia());
    const second = useSettingsStore();
    expect(second.system.player.equalizer.bands[0]).toBe(0);
    expect(defaultSystemConfig.player.equalizer.bands[0]).toBe(0);
  });
});
