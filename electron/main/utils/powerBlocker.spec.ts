import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  keepScreenAwake: true,
  nextId: 0,
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("electron", () => ({ powerSaveBlocker: { start: mocks.start, stop: mocks.stop } }));
vi.mock("@main/store", () => ({ store: { get: () => mocks.keepScreenAwake } }));
vi.mock("./logger", () => ({ systemLog: { info: vi.fn() } }));

let power: typeof import("./powerBlocker");

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.keepScreenAwake = true;
  mocks.nextId = 0;
  mocks.start.mockImplementation(() => mocks.nextId++);
  power = await import("./powerBlocker");
});

describe("播放时保持屏幕常亮", () => {
  it("无需展开播放页或显示主窗口，开始播放就阻止屏幕休眠", () => {
    power.updatePowerBlocker("playing");
    expect(mocks.start.mock.calls).toEqual([["prevent-app-suspension"], ["prevent-display-sleep"]]);
    expect(mocks.stop).not.toHaveBeenCalled();
  });

  it("首次加载和连续切歌期间保持同一组电源抑制，不反复释放屏幕常亮", () => {
    for (const state of ["loading", "playing", "loading", "playing"] as const) {
      power.updatePowerBlocker(state);
    }
    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(mocks.start).toHaveBeenCalledWith("prevent-display-sleep");
    expect(mocks.stop).not.toHaveBeenCalled();
  });

  it.each(["paused", "stopped", "idle"] as const)("进入 %s 时释放显示器和系统休眠抑制", (state) => {
    power.updatePowerBlocker("playing");
    power.updatePowerBlocker(state);
    expect(mocks.stop.mock.calls).toEqual([[0], [1]]);
    power.refreshPowerBlocker();
    expect(mocks.stop).toHaveBeenCalledTimes(2);
  });

  it("关闭常亮选项后仍保护后台播放，但允许屏幕按系统设置熄灭", () => {
    mocks.keepScreenAwake = false;
    power.updatePowerBlocker("playing");
    expect(mocks.start.mock.calls).toEqual([["prevent-app-suspension"]]);
  });

  it("播放中切换常亮开关立即生效且不影响后台播放抑制", () => {
    mocks.keepScreenAwake = false;
    power.updatePowerBlocker("playing");
    mocks.keepScreenAwake = true;
    power.refreshPowerBlocker();
    power.refreshPowerBlocker();
    expect(mocks.start).toHaveBeenCalledTimes(2);
    mocks.keepScreenAwake = false;
    power.refreshPowerBlocker();
    expect(mocks.stop.mock.calls).toEqual([[1]]);
    mocks.keepScreenAwake = true;
    power.refreshPowerBlocker();
    expect(mocks.start).toHaveBeenCalledTimes(3);
  });

  it("暂停时打开常亮选项不会强制点亮屏幕", () => {
    power.updatePowerBlocker("paused");
    power.refreshPowerBlocker();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("退出时释放全部抑制，后续重新播放仍能正常启用", () => {
    power.updatePowerBlocker("playing");
    power.releasePowerBlocker();
    power.releasePowerBlocker();
    expect(mocks.stop.mock.calls).toEqual([[0], [1]]);
    power.updatePowerBlocker("playing");
    expect(mocks.start).toHaveBeenCalledTimes(4);
  });
});
