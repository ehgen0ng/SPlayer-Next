import { beforeEach, describe, expect, it, vi } from "vitest";
import { reactive } from "vue";
import { flushPromises, shallowMount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import type { Track, TrackDetail } from "@shared/types/player";
import AudioInfoDialog from "./AudioInfoDialog.vue";
import messages from "@/i18n/locales/zh-CN.json";

const mocks = vi.hoisted(() => ({
  isAndroid: false,
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
vi.mock("@/platform", () => ({
  /** 按测试场景提供构建平台 */
  get isAndroid() {
    return mocks.isAndroid;
  },
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
  mocks.isAndroid = false;
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
  it("安卓区分应用输出流与系统未知格式，不展示播放速度及音频处理分组", async () => {
    mocks.isAndroid = true;
    mocks.status.audioInfoOpen = true;
    mocks.getStreamInfo.mockResolvedValue({
      success: true,
      data: {
        outputSampleRate: 48000,
        outputBits: 16,
        outputChannels: 2,
        deviceName: "",
        isExclusive: false,
        isResampling: null,
      },
    });
    const wrapper = mountDialog();
    await flushPromises();
    expect(wrapper.find(".grid-cols-4").text()).toContain("48.0 kHz");
    const sections = wrapper.findAll("section");
    expect(sections[0]!.text()).toContain("44.1 kHz");
    expect(sections[1]!.text()).toContain("未知");
    expect(sections[1]!.text()).toContain("由 Android 系统管理");
    expect(sections).toHaveLength(2);
    expect(wrapper.text()).not.toContain("播放速度");
    expect(wrapper.text()).not.toContain("音频处理");
    wrapper.unmount();
  });

  it("安卓没有输出流时不拿歌曲参数代替输出参数", async () => {
    mocks.isAndroid = true;
    mocks.status.audioInfoOpen = true;
    mocks.getStreamInfo.mockResolvedValue({ success: true });
    const wrapper = mountDialog();
    await flushPromises();
    const cards = wrapper.find(".grid-cols-4").text();
    expect(cards).not.toContain("44.1 kHz");
    expect(cards).not.toContain("16 bit");
    expect(cards).not.toContain("多声道");
    expect(wrapper.findAll("section")[0]!.text()).toContain("44.1 kHz");
    wrapper.unmount();
  });

  it("换源后忽略旧输出流查询的迟到结果", async () => {
    let finish!: (value: unknown) => void;
    mocks.getStreamInfo.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mocks.status.audioInfoOpen = true;
    const wrapper = mountDialog();
    await flushPromises();
    mocks.getStreamInfo.mockResolvedValue({
      success: true,
      data: { outputSampleRate: 48000, outputBits: 16, outputChannels: 2 },
    });
    mocks.status.currentSource = "https://music.example/next.flac";
    await flushPromises();
    finish({ success: true, data: { outputSampleRate: 96000, outputBits: 24, outputChannels: 2 } });
    await flushPromises();
    expect(wrapper.find(".grid-cols-4").text()).toContain("48.0 kHz");
    expect(wrapper.find(".grid-cols-4").text()).not.toContain("96.0 kHz");
    wrapper.unmount();
  });

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
