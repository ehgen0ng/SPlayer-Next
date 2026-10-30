import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({
  userId: "90071992547409931",
  cookies: { euin: "encrypted-user" } as Record<string, string>,
  request: vi.fn(),
}));
vi.mock("../core/request", () => ({
  getQQMusicUin: () => session.userId,
  getQQMusicCookies: () => session.cookies,
  qmRequest: session.request,
}));

import userPlaylist from "./user_playlist";
import songList from "./song_list";

describe("QM 账号歌单与喜欢目录", () => {
  beforeEach(() => {
    session.userId = "90071992547409931";
    session.cookies = { euin: "encrypted-user" };
    session.request.mockReset();
  });

  it("账号 ID 保持字符串，按目录标记排除我喜欢而不跳过首个自建歌单", async () => {
    session.request.mockResolvedValue({
      v_playlist: [
        { tid: "11", dirId: 1, dirName: "第一张歌单", songNum: 8 },
        { tid: "12", dirId: 201, dirName: "我喜欢" },
        { tid: "13", dirId: 2, dirName: "第二张歌单" },
      ],
    });
    await expect(userPlaylist({ kind: "created" })).resolves.toMatchObject({
      userId: "90071992547409931",
      hasMore: false,
      playlists: [{ id: "11", name: "第一张歌单", trackCount: 8 }, { id: "13" }],
    });
    expect(session.request).toHaveBeenCalledWith(
      "music.musicasset.PlaylistBaseRead",
      "GetPlaylistByUin",
      { uin: "90071992547409931" },
      { session: false },
    );
  });

  it("收藏歌单使用加密账号及真实分页偏移，响应不泄露凭据", async () => {
    session.request.mockResolvedValue({
      v_list: [{ tid: "20", name: "收藏", logo: "cover", nickname: "创建者", songnum: 3 }],
      hasmore: 1,
    });
    const page = await userPlaylist({ kind: "subscribed", offset: 100 });
    expect(session.request).toHaveBeenCalledWith(
      "music.musicasset.PlaylistFavRead",
      "CgiGetPlaylistFavInfo",
      { uin: "encrypted-user", offset: 100, size: 100 },
      { session: false },
    );
    expect(page).toMatchObject({
      hasMore: true,
      nextOffset: 101,
      playlists: [{ id: "20", name: "收藏", cover: "cover", creator: "创建者", trackCount: 3 }],
    });
    expect(JSON.stringify(page)).not.toContain("encrypted-user");
  });

  it("无效列表与缺少加密账号明确报错，不伪造空收藏", async () => {
    session.request.mockResolvedValue({});
    await expect(userPlaylist({ kind: "created" })).rejects.toThrow("缺少列表");
    session.cookies = {};
    await expect(userPlaylist({ kind: "subscribed" })).rejects.toThrow("重新扫码");
  });

  it("我喜欢使用固定目录 201，并转换时长与歌曲 MID", async () => {
    session.request.mockResolvedValue({
      songlist: [{ id: 1, mid: "song-mid", title: "歌曲", interval: 120 }],
      total_song_num: 201,
      hasmore: 1,
    });
    await expect(songList({ id: "liked", offset: 100 })).resolves.toMatchObject({
      code: 200,
      nextOffset: 101,
      hasMore: true,
      songs: [{ id: "1", mid: "song-mid", duration: 120000 }],
    });
    expect(session.request).toHaveBeenCalledWith(
      "music.srfDissInfo.DissInfo",
      "CgiGetDiss",
      expect.objectContaining({
        disstid: 0,
        dirid: 201,
        song_begin: 100,
        enc_host_uin: "encrypted-user",
      }),
      { session: false },
    );
  });

  it("请求中切换账号会丢弃旧歌单响应", async () => {
    session.request.mockImplementation(async () => {
      session.userId = "2";
      return { v_playlist: [] };
    });
    await expect(userPlaylist({ kind: "created" })).rejects.toThrow("账号已变更");
  });

  it("未登录不能读取喜欢目录，公开歌单仍能匿名读取", async () => {
    session.userId = "0";
    session.cookies = {};
    await expect(songList({ id: "liked" })).rejects.toThrow("请先登录");
    session.request.mockResolvedValue({ songlist: [], total_song_num: 0 });
    await expect(songList({ id: "123" })).resolves.toMatchObject({ code: 200, songs: [] });
    expect(session.request).toHaveBeenCalledWith(
      "music.srfDissInfo.aiDissInfo",
      "uniform_get_Dissinfo",
      expect.anything(),
      { session: false },
    );
  });
});
