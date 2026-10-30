import { createPinia, setActivePinia } from "pinia";
import { shallowMount, flushPromises } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "vue-i18n";
import { useUserStore } from "@/stores/user";
import { useDataStore } from "@/stores/data";
import { neteaseQrLoginAdapter } from "@/apis/login/netease";
import messages from "@/i18n/locales/zh-CN.json";
import PlatformAccount from "./PlatformAccount.vue";

vi.mock("localforage", () => ({ default: { createInstance: () => ({}) } }));
vi.mock("@/utils/config", () => ({ REPO_NAME: "SPlayer-Next" }));
vi.mock("@/composables/useToast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const stubs = {
  SCard: { template: "<div><slot /></div>" },
  STag: { template: "<span><slot /></span>" },
  SButton: { template: "<button><slot /></button>" },
  SDialog: {
    props: ["open"],
    template: "<section v-if='open'><slot /><slot name='footer' /></section>",
  },
  SInput: { name: "SInput", props: ["modelValue"], template: "<input />" },
  QrLoginPanel: { name: "QrLoginPanel", props: ["adapter", "active"], template: "<div />" },
  SDropdownMenu: true,
  SLogo: true,
  IconLucideMusic: true,
  IconLucideUnplug: true,
  IconLucideKey: true,
  IconLucideQrCode: true,
  IconLucideChevronDown: true,
  IconLucideLogIn: true,
  IconLucideX: true,
};

describe("设置中的 NCM 账号入口", () => {
  const setCookie = vi.fn();
  beforeEach(() => {
    setActivePinia(createPinia());
    setCookie.mockReset().mockResolvedValue({ ok: true });
    Object.defineProperty(window, "api", { configurable: true, value: { apis: { setCookie } } });
  });

  it("NCM 扫码入口复用原适配器，不创建辅助平台账号副本", async () => {
    const user = useUserStore();
    vi.spyOn(user, "fetchStatus").mockResolvedValue(false);
    const data = useDataStore();
    const saveProfile = vi.spyOn(data, "setPlatformProfile");
    const wrapper = shallowMount(PlatformAccount, {
      props: { platform: "netease" },
      global: {
        plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": messages } })],
        stubs,
      },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("NCM");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "扫码登录")!
      .trigger("click");
    expect(wrapper.findComponent({ name: "QrLoginPanel" }).props("adapter")).toBe(
      neteaseQrLoginAdapter,
    );
    expect(saveProfile).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("NCM Cookie 登录更新原用户 Store，并保留已经登录的 QM 资料", async () => {
    const user = useUserStore();
    vi.spyOn(user, "fetchStatus").mockImplementation(async () => {
      if (setCookie.mock.calls.length) user.profile = { userId: 42, nickname: "NCM 用户" };
      return user.isLoggedIn;
    });
    const data = useDataStore();
    data.setPlatformProfile("qqmusic", {
      userId: "100",
      nickname: "QM 用户",
      avatarUrl: "",
      isVip: false,
    });
    const wrapper = shallowMount(PlatformAccount, {
      props: { platform: "netease" },
      global: {
        plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": messages } })],
        stubs,
      },
    });
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Cookie 登录")!
      .trigger("click");
    wrapper.findComponent({ name: "SInput" }).vm.$emit("update:modelValue", "MUSIC_U=test;");
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "确认")!
      .trigger("click");
    await flushPromises();
    expect(setCookie).toHaveBeenCalledWith("netease", "MUSIC_U=test;");
    expect(user.profile?.nickname).toBe("NCM 用户");
    expect(data.getPlatformProfile("qqmusic")?.nickname).toBe("QM 用户");
    expect(data.getPlatformProfile("netease")).toBeNull();
    wrapper.unmount();
  });
});
