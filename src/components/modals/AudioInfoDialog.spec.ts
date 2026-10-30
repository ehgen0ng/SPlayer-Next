import { beforeEach, describe, expect, it, vi } from "vitest";
import { reactive } from "vue";
import { flushPromises, shallowMount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import type { Track, TrackDetail } from "@shared/types/player";
import AudioInfoDialog from "./AudioInfoDialog.vue";
import messages from "@/i18n/locales/zh-CN.json";

const mocks = vi.hoisted(() => ({
  getStreamInfo: vi.fn(),
  getSourceSize: vi.fn(),
  status: {
    audioInfoOpen: false,
    trackLoading: false,
    currentSource: "https://music.example/a.flac",
    state: "playing",
    outputDevices: [],
    speed: 1,
  },
  media: { track: null as Track | null, detail: null as TrackDetail | null },
}));
vi.mock("@/stores/media", () => ({ useMediaStore: () => mocks.media }));
vi.mock("@/stores/status", () => ({ useStatusStore: () => mocks.status }));
vi.mock("@/stores/settings", () => ({
  useSettingsStore: () => ({
    system: { player: { outputDevice: null, audioOutputMode: "shared" } },
  }),
}));

/** 挂载输出信息弹窗并保留文件参数展示 */
const mountDialog = () =>
  shallowMount(AudioInfoDialog, {
    global: {
      plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": messages } })],
      stubs: {
        SDialog: { props: ["open"], template: "<div v-if='open'><slot /></div>" },
        SCard: { template: "<div><slot /></div>" },
        SButton: true,
      },
    },
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.status = reactive({
    ...mocks.status,
    audioInfoOpen: false,
    trackLoading: false,
    currentSource: "https://music.example/a.flac",
    state: "playing",
  });
  mocks.media = reactive({
    track: {
      id: "song",
      source: "qqmusic",
      title: "雨爱",
      artists: [],
      duration: 260480,
      fileSize: 1,
    },
    detail: {
      quality: {
        codec: "flac",
        sampleRate: 44100,
        bitsPerSample: 16,
        channels: 6,
        bitRate: 2595000,
      },
      externalLyrics: [],
    },
  });
  mocks.getStreamInfo.mockResolvedValue({
    success: true,
    data: { outputSampleRate: 44100, outputBits: 32, outputChannels: 2, sourceBits: 16 },
  });
  mocks.getSourceSize.mockReset().mockResolvedValue({ success: true, data: 84502272 });
  Object.assign(window, {
    api: {
      player: {
        getStreamInfo: mocks.getStreamInfo,
        getSourceSize: mocks.getSourceSize,
      },
    },
  });
});

describe("音源文件信息", () => {
  it("仅打开时查询实际大小，并区分原始文件与输出位深", async () => {
    const wrapper = mountDialog();
    expect(mocks.getSourceSize).not.toHaveBeenCalled();
    mocks.status.audioInfoOpen = true;
    await flushPromises();
    const fileSection = wrapper.findAll("section")[0]!;
    expect(fileSection.text()).toContain("80.6 MB");
    expect(fileSection.text()).toContain("16 bit");
    expect(fileSection.text()).toContain("多声道 · 6");
    expect(wrapper.text()).toContain("32 bit");
    mocks.status.state = "paused";
    await flushPromises();
    expect(mocks.getSourceSize).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("同一首歌换源后忽略旧大小，未知时不使用歌单声明的大小", async () => {
    let finish!: (value: unknown) => void;
    mocks.getSourceSize.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mocks.status.audioInfoOpen = true;
    const wrapper = mountDialog();
    await flushPromises();
    expect(wrapper.text()).toContain("未知");
    mocks.getSourceSize.mockResolvedValueOnce({ success: true, data: undefined });
    mocks.status.currentSource = "https://music.example/b.flac";
    await flushPromises();
    finish({ success: true, data: 84502272 });
    await flushPromises();
    expect(wrapper.text()).toContain("未知");
    expect(wrapper.text()).not.toContain("80.6 MB");
    expect(wrapper.text()).not.toContain("1 B");
    wrapper.unmount();
  });
});
