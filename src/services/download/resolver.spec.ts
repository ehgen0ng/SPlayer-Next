import { beforeEach, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import type { DownloadResolvePayload, DownloadTask } from "@shared/types/download";

const mocks = vi.hoisted(() => ({
  source: vi.fn(),
  submit: vi.fn(),
  fail: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  offState: vi.fn(),
  offResolve: vi.fn(),
  resolve: (_payload: DownloadResolvePayload) => {},
  state: (_task: DownloadTask) => {},
}));
vi.mock("./source", () => ({ resolveDownloadSource: mocks.source }));
vi.mock("./lyric", () => ({ resolveDownloadLyric: vi.fn() }));
vi.mock("@/i18n", () => ({ default: { global: { t: (key: string) => key } } }));
vi.mock("@/composables/useToast", () => ({
  toast: { warning: mocks.warning, error: mocks.error },
}));
import { initDownloadResolver } from "./resolver";

const payload: DownloadResolvePayload = {
  taskId: "task",
  track: { id: "song", source: "qqmusic", title: "雨爱", artists: [], duration: 260480 },
  qualityLevel: "hi-res",
  tagOptions: {
    embedMeta: false,
    embedCover: false,
    embedLyric: false,
    writeLrc: false,
    saveTtml: false,
  },
  usePlaybackForDownload: false,
  lyricFileFormat: "lrc",
};
beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(window, {
    api: {
      download: {
        onResolve: (callback: typeof mocks.resolve) => {
          mocks.resolve = callback;
          return mocks.offResolve;
        },
        onState: (callback: typeof mocks.state) => {
          mocks.state = callback;
          return mocks.offState;
        },
        submitResolution: mocks.submit,
        failResolution: mocks.fail,
      },
    },
  });
});

it("降级结果同时回传实际档位和文件参数，保留用户请求", async () => {
  const quality = {
    codec: "flac",
    bitRate: 2595000,
    sampleRate: 44100,
    bitsPerSample: 16,
    channels: 6,
  };
  mocks.source.mockResolvedValue({ url: "https://music.example/file", format: "flac", quality });
  const off = initDownloadResolver(vi.fn());
  mocks.resolve(payload);
  await flushPromises();
  expect(mocks.submit).toHaveBeenCalledWith(
    "task",
    expect.objectContaining({ resolvedQuality: quality, resolvedQualityLevel: "lossless" }),
  );
  expect(mocks.warning).toHaveBeenCalledExactlyOnceWith("player.qualityFallback");
  expect(payload.qualityLevel).toBe("hi-res");
  off();
});

it("取消下载后不提交迟到结果，也不弹出解析失败提示", async () => {
  let finish!: (value: unknown) => void;
  mocks.source.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const update = vi.fn();
  const off = initDownloadResolver(update);
  mocks.resolve(payload);
  const task: DownloadTask = {
    taskId: "task",
    status: "canceled",
    track: payload.track,
    qualityLevel: "hi-res",
    received: 0,
    total: 0,
    createdAt: 0,
  };
  mocks.state(task);
  expect(mocks.source.mock.calls[0]![3].aborted).toBe(true);
  finish({ url: "https://music.example/late" });
  await flushPromises();
  expect(update).toHaveBeenCalledWith(task);
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(mocks.fail).not.toHaveBeenCalled();
  expect(mocks.error).not.toHaveBeenCalled();
  off();
  expect(mocks.offState).toHaveBeenCalledOnce();
  expect(mocks.offResolve).toHaveBeenCalledOnce();
});
