import { describe, expect, it, vi } from "vitest";
import type { AudioQuality } from "@shared/types/player";
import {
  matchesAudioSource,
  selectAudioSource,
  type SourceSelectionAttempt,
} from "./audioSourceSelection";

const lossless: AudioQuality = {
  codec: "flac",
  sampleRate: 44100,
  bitsPerSample: 16,
  channels: 2,
  bitRate: 900000,
};
const hires = { ...lossless, sampleRate: 96000, bitsPerSample: 24 };

describe("可选的音源身份校验", () => {
  const track = { artists: [{ name: "莫文蔚" }], duration: 300000 };

  it("默认关闭时不因歌手别名或不同版本时长排除音源", () => {
    expect(matchesAudioSource(track, { ...lossless, artist: "Karen Mok", duration: 315000 })).toBe(
      true,
    );
  });

  it("两个开关相互独立，时长允许五秒差异", () => {
    expect(
      matchesAudioSource(track, { ...lossless, artist: "莫文蔚", duration: 315000 }, true),
    ).toBe(true);
    expect(
      matchesAudioSource(track, { ...lossless, artist: "其他歌手", duration: 305000 }, false, true),
    ).toBe(true);
    expect(matchesAudioSource(track, { ...lossless, duration: 305001 }, false, true)).toBe(false);
    expect(matchesAudioSource(track, { ...lossless, artist: "其他歌手" }, true)).toBe(false);
  });

  it("缺少标签或未知时长不直接判错", () => {
    for (const duration of [undefined, 0, -1, Number.NaN]) {
      expect(matchesAudioSource(track, { ...lossless, duration }, true, true)).toBe(true);
    }
  });

  it("兼容英文大小写、重音、合唱和双语标签，不以姓名子串误匹配", () => {
    expect(
      matchesAudioSource(
        { artists: [{ name: "Beyoncé" }], duration: 0 },
        { ...lossless, artist: "BEYONCE feat. Jay-Z" },
        true,
      ),
    ).toBe(true);
    expect(matchesAudioSource(track, { ...lossless, artist: "Karen Mok（莫文蔚）" }, true)).toBe(
      true,
    );
    expect(
      matchesAudioSource(
        { artists: [{ name: "Ann" }], duration: 0 },
        { ...lossless, artist: "Anne-Marie" },
        true,
      ),
    ).toBe(false);
  });

  it("校验后再择优，莫文蔚《爱》不会被同名高码率音源替代", async () => {
    const pluginIds = ["wrong-artist", "wrong-duration", "correct"];
    const result = await selectAudioSource(
      "lossless",
      async (attempt) => {
        const id = pluginIds.find((id) => !attempt.skipPluginIds.includes(id));
        return id ? { pluginId: id, url: id } : null;
      },
      {
        pluginIds,
        track,
        verifyArtist: true,
        verifyDuration: true,
        probe: async (url) => ({
          success: true,
          data: {
            ...(url === "correct" ? lossless : hires),
            artist: url === "wrong-artist" ? "小虎队" : "莫文蔚",
            duration: url === "wrong-duration" ? 260000 : 300000,
          },
        }),
      },
    );
    expect(result?.source.pluginId).toBe("correct");
  });
});

describe("公共并发选源", () => {
  it("全部候选在任意结果返回前启动，同音质按排序而非完成顺序选择", async () => {
    const pluginIds = ["a", "b", "c", "d", "e"];
    const finish = new Map<string, (value: { pluginId: string; url: string }) => void>();
    const resolve = vi.fn((attempt: SourceSelectionAttempt) => {
      const id = pluginIds.find((id) => !attempt.skipPluginIds.includes(id))!;
      return new Promise<{ pluginId: string; url: string }>((done) => finish.set(id, done));
    });
    const result = selectAudioSource("lossless", resolve, {
      pluginIds,
      probe: async () => ({ success: true, data: lossless }),
    });
    expect([...finish.keys()]).toEqual(pluginIds);
    for (const id of [...pluginIds].reverse()) finish.get(id)!({ pluginId: id, url: id });
    expect((await result)?.source.pluginId).toBe("a");
    expect(resolve).toHaveBeenCalledTimes(5);
  });

  it("降级复用已达标来源，只重试仍未达标者，同一地址仅探测一次", async () => {
    const pluginIds = ["a", "b"];
    const resolve = vi.fn(async (attempt: SourceSelectionAttempt) => {
      if (!attempt.skipOfficialOnline) return null;
      const id = pluginIds.find((id) => !attempt.skipPluginIds.includes(id))!;
      return { pluginId: id, url: id };
    });
    const probe = vi.fn(async (url: string) => ({
      success: true,
      data: url === "a" ? lossless : { ...lossless, codec: "mp3", bitRate: 320000 },
    }));
    expect(
      (await selectAudioSource("hi-res", resolve, { pluginIds, probe }))?.source.pluginId,
    ).toBe("a");
    expect(resolve.mock.calls.map(([attempt]) => [attempt.quality, attempt.skipPluginIds])).toEqual(
      [
        ["hi-res", ["b"]],
        ["hi-res", ["a"]],
        ["hi-res", ["a", "b"]],
        ["lossless", ["a"]],
      ],
    );
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("不同插件的相同 URL 共用在途探测，失败来源不阻断其他结果", async () => {
    const pluginIds = ["a", "b", "c"];
    const probe = vi.fn(async () => ({ success: true, data: hires }));
    const result = await selectAudioSource(
      "hi-res",
      async (attempt) => {
        const id = pluginIds.find((id) => !attempt.skipPluginIds.includes(id))!;
        if (id === "c") throw new Error("接口失败");
        return { pluginId: id, url: "same" };
      },
      { pluginIds, probe },
    );
    expect(result?.source.pluginId).toBe("a");
    expect(probe).toHaveBeenCalledOnce();
  });

  it("取消后不探测迟到地址，也不开始官方兜底或降级", async () => {
    const controller = new AbortController();
    let finish!: (value: { pluginId: string; url: string }) => void;
    const resolve = vi.fn(
      () =>
        new Promise<{ pluginId: string; url: string }>((done) => {
          finish = done;
        }),
    );
    const probe = vi.fn();
    const result = selectAudioSource("hi-res", resolve, {
      pluginIds: ["a"],
      probe,
      signal: controller.signal,
    });
    controller.abort();
    finish({ pluginId: "a", url: "late" });
    expect(await result).toBeNull();
    expect(resolve).toHaveBeenCalledOnce();
    expect(probe).not.toHaveBeenCalled();
  });
});
