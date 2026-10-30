import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchQQMusicPlaylist } from "./qqmusic";

describe("QM 歌单分页加载", () => {
  const call = vi.fn();
  /**
   * 构造用于核对分页顺序的歌曲
   * @param mid - 歌曲 MID
   * @returns 轻量歌曲样本
   */
  const song = (mid: string) => ({ id: mid, mid, name: mid, artist: "", duration: 1000 });
  beforeEach(() => {
    call.mockReset();
    Object.defineProperty(window, "api", {
      configurable: true,
      value: { apis: { call } },
    });
  });

  it("取全分页并去重，后续页缺失元数据时保留首屏歌单名称", async () => {
    call
      .mockResolvedValueOnce({
        ok: true,
        data: {
          code: 200,
          id: "100",
          name: "我的歌单",
          total: 3,
          songs: [song("a"), song("b")],
          hasMore: true,
          nextOffset: 2,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          code: 200,
          songs: [song("b"), song("c")],
          hasMore: false,
        },
      });
    const result = await fetchQQMusicPlaylist("100", "默认名称");
    expect(result.playlist).toMatchObject({ id: "100", name: "我的歌单", trackCount: 3 });
    expect(result.tracks.map((track) => track.id)).toEqual(["a", "b", "c"]);
    expect(call.mock.calls[1]).toMatchObject(["qqmusic", "song_list", { offset: 2 }]);
  });

  it("重复页不再继续循环，也不返回不完整列表冒充成功", async () => {
    call
      .mockResolvedValueOnce({
        ok: true,
        data: {
          code: 200,
          songs: [song("a")],
          hasMore: true,
          nextOffset: 1,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          code: 200,
          songs: [song("a")],
          hasMore: true,
          nextOffset: 2,
        },
      });
    await expect(fetchQQMusicPlaylist("100", "歌单")).rejects.toThrow("未返回后续歌曲");
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("取消后不再读取下一页或提交已取消的歌曲", async () => {
    const controller = new AbortController();
    call.mockImplementation(async () => {
      controller.abort();
      return { ok: true, data: { code: 200, songs: [song("a")], hasMore: true, nextOffset: 1 } };
    });
    await expect(
      fetchQQMusicPlaylist("100", "歌单", { signal: controller.signal }),
    ).rejects.toThrow();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("账号不匹配的喜欢目录响应不会交给调用方", async () => {
    call.mockResolvedValue({ ok: true, data: { code: 200, userId: "old", songs: [song("a")] } });
    await expect(fetchQQMusicPlaylist("liked", "我喜欢", { userId: "new" })).rejects.toThrow(
      "账号已变更",
    );
  });
});
