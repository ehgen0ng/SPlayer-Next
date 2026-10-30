import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { reactive } from "vue";
import { shallowMount, flushPromises } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import Sortable from "sortablejs";
import type { PluginInfo, PluginsConfig } from "@shared/types/plugin";
import { defaultPluginsConfig } from "@shared/defaults/plugin-api";
import { setByPath } from "@shared/utils/path";
import { usePluginsStore } from "./plugins";
import PluginList from "@/components/settings/custom/PluginList.vue";
import messages from "@/i18n/locales/zh-CN.json";

const mocks = vi.hoisted(() => ({
  config: {} as PluginsConfig,
  items: [] as PluginInfo[],
  setSystem: vi.fn(),
  uninstall: vi.fn(),
}));
vi.mock("@/stores/settings", () => ({
  useSettingsStore: () => ({ system: { plugins: mocks.config }, setSystem: mocks.setSystem }),
}));
vi.mock("@/composables/useToast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/**
 * 构造已就绪的音源或辅助插件
 * @param id - 插件标识
 * @param audio - 是否提供歌曲音源
 * @returns 插件信息
 */
const plugin = (id: string, audio = true): PluginInfo => ({
  manifest: {
    id,
    name: id,
    version: "1.0.0",
    apiLevel: 1,
    grant: [],
    hash: "test",
    installedAt: 0,
    fileName: `${id}.js`,
  },
  enabled: true,
  status: {
    state: "ready",
    sources: { tx: { name: "QM", actions: [audio ? "musicUrl" : "musicLyric"] } },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  mocks.config = reactive(structuredClone(defaultPluginsConfig));
  mocks.items = [plugin("a"), plugin("lyrics", false), plugin("b"), plugin("c")];
  mocks.setSystem.mockImplementation(async (path: string, value: unknown) => {
    setByPath({ plugins: mocks.config }, path, value);
  });
  mocks.uninstall.mockImplementation(async (id: string) => {
    mocks.items = mocks.items.filter((info) => info.manifest.id !== id);
    return { ok: true };
  });
  Object.assign(window, {
    api: {
      plugins: {
        list: async () => mocks.items,
        onStatus: () => () => {},
        uninstall: mocks.uninstall,
      },
    },
  });
});

describe("插件音源排序", () => {
  it("读取已保存顺序，新插件追加在末尾，原始状态列表保持完整", async () => {
    mocks.config.priority.musicUrl = ["b", "a"];
    const store = usePluginsStore();
    await store.load();
    expect(store.orderedList.map((info) => info.manifest.id)).toEqual(["b", "a", "lyrics", "c"]);
    expect(store.list.map((info) => info.manifest.id)).toEqual(["a", "lyrics", "b", "c"]);
  });

  it("手动排序去重并保存到既有优先级配置，重新创建 Store 后仍生效", async () => {
    const store = usePluginsStore();
    await store.load();
    await store.setOrder(["c", "c", "missing", "b", "a"]);
    expect(mocks.setSystem).toHaveBeenCalledWith("plugins.priority.musicUrl", [
      "c",
      "b",
      "a",
      "lyrics",
    ]);
    setActivePinia(createPinia());
    const restored = usePluginsStore();
    await restored.load();
    expect(restored.orderedList.map((info) => info.manifest.id)).toEqual(["c", "b", "a", "lyrics"]);
  });

  it("有成功记录的音源排在前面，相同次数保留当前顺序", async () => {
    const store = usePluginsStore();
    await store.load();
    await store.setAutoSortMusicSources(true);
    store.recordMusicSuccess("b");
    expect(store.orderedList.map((info) => info.manifest.id)).toEqual(["b", "a", "lyrics", "c"]);
    store.recordMusicSuccess("a");
    expect(store.orderedList.map((info) => info.manifest.id)).toEqual(["b", "a", "lyrics", "c"]);
    store.recordMusicSuccess("a");
    expect(store.orderedList.map((info) => info.manifest.id)).toEqual(["a", "b", "lyrics", "c"]);
    expect(mocks.config.musicSourceSuccesses).toEqual({ b: 1, a: 2 });
  });

  it("开启和关闭都不立即改顺序，关闭后成功记录也不会改变顺序", async () => {
    mocks.config.autoSortMusicSources = false;
    const store = usePluginsStore();
    await store.load();
    await store.setOrder(["c", "lyrics", "b", "a"]);
    store.recordMusicSuccess("a");
    store.recordMusicSuccess("a");
    await store.setAutoSortMusicSources(true);
    expect(store.orderedList.map((info) => info.manifest.id)).toEqual(["c", "lyrics", "b", "a"]);
    store.recordMusicSuccess("a");
    const current = store.orderedList.map((info) => info.manifest.id);
    expect(current).toEqual(["a", "c", "lyrics", "b"]);
    await store.setAutoSortMusicSources(false);
    for (let i = 0; i < 5; i++) store.recordMusicSuccess("b");
    expect(store.orderedList.map((info) => info.manifest.id)).toEqual(current);
    await store.setAutoSortMusicSources(true);
    expect(store.orderedList.map((info) => info.manifest.id)).toEqual(current);
    store.recordMusicSuccess("b");
    expect(store.orderedList.map((info) => info.manifest.id)).toEqual(["b", "a", "c", "lyrics"]);
  });

  it("禁用、非音源和已卸载插件不会增加成功数", async () => {
    mocks.items[0]!.enabled = false;
    const store = usePluginsStore();
    await store.load();
    for (const id of ["a", "lyrics", "missing"]) store.recordMusicSuccess(id);
    expect(mocks.config.musicSourceSuccesses).toEqual({});
  });

  it("卸载时清理排序和成功记录，插件升级重新加载保留记录", async () => {
    const store = usePluginsStore();
    await store.load();
    await store.setOrder(["c", "b", "a", "lyrics"]);
    store.recordMusicSuccess("c");
    mocks.items[3]!.manifest.version = "2.0.0";
    await store.load();
    expect(store.musicSourceSuccesses.c).toBe(1);
    await store.uninstall("c");
    expect(store.musicSourceSuccesses.c).toBeUndefined();
    expect(mocks.config.priority.musicUrl).toEqual(["b", "a", "lyrics"]);
  });

  it("带点号的插件标识按完整键保存成功次数", async () => {
    mocks.items.push(plugin("audio.custom"));
    const store = usePluginsStore();
    await store.load();
    store.recordMusicSuccess("audio.custom");
    expect(mocks.config.musicSourceSuccesses).toEqual({ "audio.custom": 1 });
  });

  it("首位未声明音源能力的插件不能挡住已有 4 次成功的音源", async () => {
    mocks.items = [plugin("api-cf", false), plugin("hywmusic_"), plugin("other")];
    mocks.config.priority.musicUrl = ["api-cf", "hywmusic_", "other"];
    mocks.config.musicSourceSuccesses = { hywmusic_: 4 };
    mocks.config.autoSortMusicSources = true;
    const store = usePluginsStore();
    await store.load();
    expect(store.orderedList.map((info) => info.manifest.id)).toEqual([
      "hywmusic_",
      "api-cf",
      "other",
    ]);
  });
});

describe("已安装插件的排序入口", () => {
  it.each([false, true])("自动排名同步卡片和未编辑的弹窗，保护手动编辑=%s", async (edited) => {
    const store = usePluginsStore();
    await store.load();
    await store.setAutoSortMusicSources(true);
    const wrapper = mountList();
    await wrapper
      .findAll("button")
      .find((node) => node.text() === "排序")!
      .trigger("click");
    if (edited) await wrapper.findAll('button[aria-label="上移插件"]')[2]!.trigger("click");
    store.recordMusicSuccess("c");
    await flushPromises();
    expect(wrapper.findAll("article").map((node) => node.text())).toEqual([
      "c",
      "a",
      "lyrics",
      "b",
    ]);
    expect(
      wrapper.findAll("[data-plugin-id]").map((node) => node.attributes("data-plugin-id")),
    ).toEqual(edited ? ["a", "b", "lyrics", "c"] : ["c", "a", "lyrics", "b"]);
    await wrapper
      .findAll("button")
      .find((node) => node.text() === "取消")!
      .trigger("click");
    expect(store.orderedList.map((info) => info.manifest.id)).toEqual(["c", "a", "lyrics", "b"]);
    await wrapper
      .findAll("button")
      .find((node) => node.text() === "排序")!
      .trigger("click");
    expect(
      wrapper.findAll("[data-plugin-id]").map((node) => node.attributes("data-plugin-id")),
    ).toEqual(["c", "a", "lyrics", "b"]);
    wrapper.unmount();
  });

  /** 挂载插件页面并保留排序按钮、开关和弹窗交互 */
  const mountList = () =>
    shallowMount(PluginList, {
      global: {
        plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": messages } })],
        stubs: {
          SButton: { template: "<button><slot /><slot name='icon' /></button>" },
          SSwitch: {
            props: ["modelValue"],
            emits: ["update:modelValue"],
            template: `<button role="switch" :aria-checked="modelValue" @click="$emit('update:modelValue', !modelValue)" />`,
          },
          SDialog: {
            props: ["open"],
            emits: ["update:open"],
            template: `<section v-if="open" role="dialog"><slot /><slot name="footer" :close="() => $emit('update:open', false)" /></section>`,
          },
          PluginCard: {
            name: "PluginCard",
            props: ["info"],
            template: `<article>{{ info.manifest.name }}</article>`,
          },
          STabs: true,
          PluginMarket: true,
          PluginDetailDialog: true,
          PluginSettingsForm: true,
        },
      },
    });

  it("显示精简说明和自动排序开关，切换不会让卡片立即重排", async () => {
    mocks.config.autoSortMusicSources = false;
    const store = usePluginsStore();
    await store.load();
    store.recordMusicSuccess("c");
    const wrapper = mountList();
    expect(wrapper.text()).toContain("成功次数越多，排序越靠前");
    await wrapper.get('[role="switch"]').trigger("click");
    expect(store.autoSortMusicSources).toBe(true);
    expect(wrapper.findAll("article").map((node) => node.text())).toEqual([
      "a",
      "lyrics",
      "b",
      "c",
    ]);
    await wrapper.get('[role="switch"]').trigger("click");
    expect(store.autoSortMusicSources).toBe(false);
    wrapper.unmount();
  });

  it("排序弹窗可以上下移动并保存，自动排序开关保持原值", async () => {
    const store = usePluginsStore();
    await store.load();
    await store.setAutoSortMusicSources(true);
    const wrapper = mountList();
    await wrapper
      .findAll("button")
      .find((node) => node.text() === "排序")!
      .trigger("click");
    await wrapper.findAll('button[aria-label="上移插件"]')[2]!.trigger("click");
    await wrapper
      .findAll("button")
      .find((node) => node.text() === "确认")!
      .trigger("click");
    await flushPromises();
    expect(store.orderedList.map((info) => info.manifest.id)).toEqual(["a", "b", "lyrics", "c"]);
    expect(store.autoSortMusicSources).toBe(true);
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("拖动期间保留原顺序，完成后仅在确认时保存", async () => {
    const store = usePluginsStore();
    await store.load();
    await store.setAutoSortMusicSources(true);
    const wrapper = mountList();
    await wrapper
      .findAll("button")
      .find((node) => node.text() === "排序")!
      .trigger("click");
    const item = wrapper.get('[data-plugin-id="a"]').element as HTMLElement;
    const from = item.parentElement!;
    const sortable = Sortable.get(from)!;
    const event = { item, from, oldIndex: 0, newIndex: 3 } as Sortable.SortableEvent;
    sortable.option("onStart")!.call(sortable, event);
    store.recordMusicSuccess("c");
    await flushPromises();
    expect(
      wrapper.findAll("[data-plugin-id]").map((node) => node.attributes("data-plugin-id")),
    ).toEqual(["a", "lyrics", "b", "c"]);
    from.appendChild(item);
    sortable.option("onUpdate")!.call(sortable, event);
    await flushPromises();
    expect(
      wrapper.findAll("[data-plugin-id]").map((node) => node.attributes("data-plugin-id")),
    ).toEqual(["lyrics", "b", "c", "a"]);
    expect(store.orderedList.map((info) => info.manifest.id)).toEqual(["c", "a", "lyrics", "b"]);
    await wrapper
      .findAll("button")
      .find((node) => node.text() === "确认")!
      .trigger("click");
    await flushPromises();
    expect(store.orderedList.map((info) => info.manifest.id)).toEqual(["lyrics", "b", "c", "a"]);
    wrapper.unmount();
  });
});
