import { describe, expect, it, vi } from "vitest";
import { createAppApi } from "@shared/bridge";
import type { Track } from "@shared/types/player";
import type { TaskbarLyricLayoutEvent } from "@shared/types/window";

describe("共享桥接兼容上游接口", () => {
  it("桌面与 Android 共用新增的搜索、动态封面及播放记录调用", async () => {
    const invoke = vi.fn().mockResolvedValue(null);
    const transport = {
      invoke,
      send: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
      removeAllListeners: vi.fn(),
    };
    const api = createAppApi(
      transport,
      {
        installType: "apk",
        platform: "android",
        osInfo: { type: "Android", arch: "arm64", release: "13" },
      },
      () => "",
    );
    const track = { id: "song", title: "测试歌曲" } as Track;

    await api.library.quickSearch("测试");
    await api.lyrics.searchTTML(track);
    await api.motionCover.resolve(track, "am");
    await api.stats.getRecentTracks(5);
    expect(invoke.mock.calls).toEqual([
      ["library:quickSearch", "测试"],
      ["lyrics:searchTTML", track],
      ["motionCover:resolve", track, "am"],
      ["stats:getRecentTracks", 5],
    ]);

    const data = new ArrayBuffer(4);
    await api.system.saveFile(data, "歌词.png", "保存歌词图片");
    expect(invoke).toHaveBeenLastCalledWith("system:saveFile", data, "歌词.png", "保存歌词图片");

    const callback = vi.fn();
    const unsubscribe = api.taskbarLyric.onLayout(callback);
    const [channel, handler] = transport.on.mock.calls[0] as unknown as [
      string,
      (event: unknown, data: TaskbarLyricLayoutEvent) => void,
    ];
    const layout: TaskbarLyricLayoutEvent = {
      isCentered: false,
      systemType: "win11",
      isLight: false,
      anchor: "left",
      maxWidth: 320,
      height: 24,
    };
    handler({}, layout);
    expect(callback).toHaveBeenCalledWith(layout);
    unsubscribe();
    expect(transport.removeListener).toHaveBeenCalledWith(channel, handler);
  });
});
