import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LyricLine } from "lyric-kit";

import { nextTick } from "vue";
import { useSettingsStore } from "@/stores/settings";
import DefaultLyrics from "./DefaultLyrics.vue";
import Lyrics from "./index.vue";

vi.mock("@/stores/settings", async () => {
  const { reactive } = await import("vue");
  const settings = reactive({
    lyric: {
      engine: "physics",
      alignment: "auto",
      springMass: 0.9,
      springDamping: 15,
      springStiffness: 90,
    },
  });
  return { useSettingsStore: () => settings };
});

const lyricGlobals = {
  stubs: { AMLLLyrics: true, LyricCredit: true },
};

const makeLine = (word: string): LyricLine => ({
  startTime: 1000,
  endTime: 2000,
  words: [{ word, startTime: 1000, endTime: 2000 }],
  translatedLyric: "译文",
  romanLyric: "",
  isBG: false,
  isDuet: false,
});

describe("默认歌词引擎配置同步", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    useSettingsStore().lyric.alignment = "auto";
  });

  afterEach(() => vi.unstubAllGlobals());

  it("应用歌词设置直接驱动默认引擎的水平对齐", async () => {
    const settings = useSettingsStore();
    const wrapper = mount(Lyrics, {
      props: { lyricLines: [makeLine("正文")] },
      global: lyricGlobals,
    });
    try {
      await flushPromises();
      const root = wrapper.get(".lp-root");
      expect(root.classes().filter((value) => value.startsWith("lp-align-"))).toEqual([]);
      settings.lyric.alignment = "center";
      await nextTick();
      expect(root.classes()).toContain("lp-align-center");
      settings.lyric.alignment = "right";
      await nextTick();
      expect(root.classes()).toContain("lp-align-right");
    } finally {
      wrapper.unmount();
    }
  });

  it("初始化和动态切换水平对齐保留原歌词 DOM，auto 恢复声部布局", async () => {
    const wrapper = mount(DefaultLyrics, {
      props: { lyricLines: [makeLine("正文")], alignment: "center" },
      global: lyricGlobals,
    });
    try {
      const original = wrapper.get(".lp-line").element;
      expect(wrapper.classes()).toContain("lp-align-center");
      for (const alignment of ["right", "left", "auto"] as const) {
        await wrapper.setProps({ alignment });
        expect(wrapper.get(".lp-line").element).toBe(original);
        const classes = wrapper.classes().filter((value) => value.startsWith("lp-align-"));
        expect(classes).toEqual(alignment === "auto" ? [] : [`lp-align-${alignment}`]);
      }
    } finally {
      wrapper.unmount();
    }
  });

  it("冻结时缓冲歌词更换，恢复后使用最新歌词和对齐配置", async () => {
    const wrapper = mount(DefaultLyrics, {
      props: { lyricLines: [makeLine("旧歌词")] },
      global: lyricGlobals,
    });
    try {
      wrapper.vm.freeze();
      await wrapper.setProps({ lyricLines: [makeLine("新歌词")], alignment: "right" });
      expect(wrapper.get(".lp-main").text()).toBe("旧歌词");
      wrapper.vm.resume();
      expect(wrapper.get(".lp-main").text()).toBe("新歌词");
      expect(wrapper.classes()).toContain("lp-align-right");
    } finally {
      wrapper.unmount();
    }
  });

  it("逐字遮罩同时提供旧 WebView 的前缀属性，换词和配置更新后仍保留", async () => {
    // happy-dom 不保留 WebKit 遮罩属性，检查引擎实际写入的声明
    const setProperty = vi.spyOn(CSSStyleDeclaration.prototype, "setProperty");
    const frames = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    vi.mocked(requestAnimationFrame).mockImplementation((callback) => {
      frames.set(++nextId, callback);
      return nextId;
    });
    vi.mocked(cancelAnimationFrame).mockImplementation((id) => frames.delete(id));
    const line = makeLine("逐字");
    line.words = [
      { word: "逐", startTime: 1000, endTime: 1500 },
      { word: "字", startTime: 1500, endTime: 2000 },
    ];
    const wrapper = mount(DefaultLyrics, {
      props: { lyricLines: [line], enableBalancedWrap: false },
      global: lyricGlobals,
    });
    try {
      for (const wordFadeWidth of [0.5, 0.8]) {
        await wrapper.setProps({ wordFadeWidth });
        const callbacks = [...frames.values()];
        frames.clear();
        for (const callback of callbacks) callback(performance.now());
        const words = wrapper.findAll(".lp-main > span");
        expect(words).toHaveLength(2);
        for (const word of words) {
          const style = (word.element as HTMLElement).style;
          for (const property of ["mask-image", "mask-size", "mask-repeat", "mask-position"]) {
            expect(style.getPropertyValue(property)).not.toBe("");
            expect(setProperty.mock.calls).toContainEqual([
              `-webkit-${property}`,
              style.getPropertyValue(property),
            ]);
          }
        }
        setProperty.mockClear();
      }
      await wrapper.setProps({ lyricLines: [makeLine("逐行歌词")] });
      const mainStyle = (wrapper.get(".lp-main").element as HTMLElement).style;
      expect(mainStyle.getPropertyValue("mask-image")).not.toBe("");
      expect(setProperty.mock.calls).toContainEqual([
        "-webkit-mask-image",
        mainStyle.getPropertyValue("mask-image"),
      ]);
    } finally {
      wrapper.unmount();
    }
  });
});
