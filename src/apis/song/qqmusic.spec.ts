import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@shared/types/player";

const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@/apis/qqmusic", () => ({ qqmusicCall: mocks.call }));
import { resolveQQMusicUrl } from "./qqmusic";

const track: Track = {
  id: "song-mid",
  mediaId: "media-mid",
  source: "qqmusic",
  title: "歌曲",
  artists: [],
  duration: 269000,
};

beforeEach(() => mocks.call.mockReset());

describe("QQ 官方试听文件识别", () => {
  it.each([
    ["https://stream.qqmusic.qq.com/RS02media-mid.mp3?vkey=test", true],
    ["https://stream.qqmusic.qq.com/audio/RS02media-mid.mp3", true],
    ["https://stream.qqmusic.qq.com/M500media-mid.mp3?name=RS02media-mid.mp3", false],
    ["https://stream.qqmusic.qq.com/RS02folder.mp3/M800media-mid.mp3", false],
  ])("按返回地址的文件名识别 %s", async (url, isTrial) => {
    mocks.call.mockResolvedValue({ code: 200, data: [{ url }] });
    await expect(resolveQQMusicUrl(track, "hq")).resolves.toEqual({
      available: true,
      url,
      isTrial,
    });
    expect(mocks.call).toHaveBeenCalledWith("song_url", {
      mid: "song-mid",
      mediaMid: "media-mid",
      level: "hq",
    });
  });

  it.each([60000, 0])("不根据歌曲时长 %s 推断试听", async (duration) => {
    mocks.call.mockResolvedValue({
      code: 200,
      data: [{ url: "https://stream.qqmusic.qq.com/M500media-mid.mp3" }],
    });
    await expect(resolveQQMusicUrl({ ...track, duration }, "hq")).resolves.toMatchObject({
      available: true,
      isTrial: false,
    });
  });
});
