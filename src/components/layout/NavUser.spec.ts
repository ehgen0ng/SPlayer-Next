import { describe, expect, it, vi } from "vitest";
import { shallowMount, flushPromises } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import messages from "@/i18n/locales/zh-CN.json";
import NavUser from "./NavUser.vue";

const state = vi.hoisted(() => ({ loggedIn: true, saved: false }));

vi.mock("@/stores/accounts", () => ({
  useAccountsStore: () => ({
    profile: state.loggedIn
      ? { userId: "1", nickname: "原头像昵称", avatarUrl: "", isVip: false }
      : null,
    platform: "qqmusic",
    accounts: state.saved ? [{ platform: "qqmusic", profile: { userId: "1" }, active: false }] : [],
    refresh: vi.fn().mockResolvedValue(undefined),
    fetchStatus: vi.fn().mockResolvedValue(true),
    getProfile: vi.fn(),
  }),
}));
vi.mock("@/stores/qqmusic", () => ({
  useQQMusicStore: () => ({
    profile: { userId: "1" },
    createdPlaylists: [],
    subscribedPlaylists: [],
    likedPlaylistTracks: [],
    fetchStatus: vi.fn().mockResolvedValue(true),
  }),
}));
vi.mock("@/stores/user", () => ({
  useUserStore: () => ({
    profile: null,
    createdPlaylists: [],
    subscribedPlaylists: [],
    likedSongIds: new Set(),
    fetchStatus: vi.fn().mockResolvedValue(false),
  }),
}));
vi.mock("@/stores/data", () => ({ useDataStore: () => ({ getPlatformProfile: () => null }) }));
vi.mock("@/stores/status", () => ({ useStatusStore: () => ({}) }));
vi.mock("@/settings/useSettingsDialog", () => ({ useSettingsDialog: () => ({ show: vi.fn() }) }));

const options = {
  global: {
    plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": messages } })],
    stubs: {
      SPopover: {
        props: ["open"],
        template:
          "<div><div data-avatar @click=\"$emit('update:open', !open)\"><slot name='trigger' /></div><div v-if='open' data-popover><slot /></div></div>",
      },
      SDialog: {
        props: ["open"],
        template: "<section v-if='open' data-dialog><slot /></section>",
      },
      SButton: { template: "<button><slot /></button>" },
      SavedAccounts: { template: "<div data-accounts />" },
      LoginDialog: { props: ["open"], template: "<div v-if='open' data-login />" },
    },
  },
};

describe("原头像菜单的账号切换入口", () => {
  it("保留原头像昵称，下拉只加切换按钮，点击后才渲染账号选择弹窗", async () => {
    const wrapper = shallowMount(NavUser, options);
    await flushPromises();
    expect(wrapper.find("[data-avatar]").text()).toBe("原头像昵称");
    expect(wrapper.find("[data-accounts]").exists()).toBe(false);
    await wrapper.find("[data-avatar]").trigger("click");
    expect(wrapper.find("[data-popover]").text()).toContain("切换账号");
    expect(wrapper.find("[data-accounts]").exists()).toBe(false);
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "切换账号")!
      .trigger("click");
    expect(wrapper.find("[data-popover]").exists()).toBe(false);
    expect(wrapper.find("[data-dialog] [data-accounts]").exists()).toBe(true);
    wrapper.unmount();
  });

  it("未登录但存在保存账号时，头像仍打开原登录弹窗", async () => {
    state.loggedIn = false;
    state.saved = true;
    const wrapper = shallowMount(NavUser, options);
    await flushPromises();
    expect(wrapper.find("[data-dialog]").exists()).toBe(false);
    await wrapper.find("button").trigger("click");
    expect(wrapper.find("[data-login]").exists()).toBe(true);
    expect(wrapper.find("[data-dialog]").exists()).toBe(false);
    wrapper.unmount();
  });
});
