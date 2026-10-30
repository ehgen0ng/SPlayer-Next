import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDataStore } from "@/stores/data";
import { useQQMusicStore } from "./qqmusic";
import { useUserStore } from "./user";
import { useOnlineLibrary } from "@/composables/useOnlineLibrary";

vi.mock("localforage", () => ({ default: { createInstance: () => ({}) } }));

const profile = { userId: "100", nickname: "测试用户", avatarUrl: "", isVip: false };
/**
 * 构造带 MID 的同步歌曲样本
 * @param mid - 歌曲 MID
 * @returns 轻量歌曲样本
 */
const song = (mid: string) => ({ id: mid, mid, name: mid, artist: "歌手", duration: 1000 });

describe("QM 收藏同步与多平台合并", () => {
  const call = vi.fn();
  const clearSession = vi.fn();

  beforeEach(() => {
    setActivePinia(createPinia());
    clearSession.mockReset().mockResolvedValue(undefined);
    call.mockReset().mockImplementation(async (_platform, name, params) => {
      if (name === "user_detail") return { ok: true, data: { code: 200, loggedIn: true, profile } };
      if (name === "user_playlist")
        return {
          ok: true,
          data: {
            code: 200,
            userId: params.userId,
            hasMore: false,
            nextOffset: 1,
            playlists: [{ id: "10", name: params.kind, trackCount: 1 }],
          },
        };
      if (name === "song_list")
        return {
          ok: true,
          data: {
            code: 200,
            userId: params.userId,
            songs: [song("mid")],
            total: 1,
          },
        };
      throw new Error(`未预期的接口 ${name}`);
    });
    Object.defineProperty(window, "api", {
      configurable: true,
      value: { apis: { call, clearSession } },
    });
  });

  it("登录后自动同步自建、收藏与喜欢歌曲，换用 MID 查询红心", async () => {
    const store = useQQMusicStore();
    expect(await store.fetchStatus()).toBe(true);
    expect(store.createdPlaylists).toMatchObject([{ id: "10", name: "created" }]);
    expect(store.subscribedPlaylists).toMatchObject([{ id: "10", name: "subscribed" }]);
    expect(store.likedPlaylistTracks).toMatchObject([{ id: "mid", source: "qqmusic" }]);
    expect(store.isLiked("mid")).toBe(true);
  });

  it("恢复已保存的 QM 账号后分页取完整收藏与喜欢列表", async () => {
    const base = call.getMockImplementation()!;
    call.mockImplementation(async (platform, name, params) => {
      if (name === "user_playlist" && params.kind === "subscribed")
        return {
          ok: true,
          data: {
            code: 200,
            userId: "100",
            hasMore: params.offset === 0,
            nextOffset: params.offset + 1,
            playlists: [{ id: String(params.offset), name: "收藏" }],
          },
        };
      if (name === "song_list")
        return {
          ok: true,
          data: {
            code: 200,
            userId: "100",
            hasMore: params.offset === 0,
            nextOffset: params.offset + 1,
            songs: [song(`mid-${params.offset}`)],
            total: 2,
          },
        };
      return base(platform, name, params);
    });
    useDataStore().setPlatformProfile("qqmusic", profile);
    const store = useQQMusicStore();
    await store.loadContent();
    expect(store.subscribedPlaylists).toHaveLength(2);
    expect(store.likedPlaylistTracks.map((track) => track.id)).toEqual(["mid-0", "mid-1"]);
  });

  it("退出后返回的旧请求不能恢复账号收藏", async () => {
    let finish!: (value: unknown) => void;
    const blocked = new Promise((resolve) => {
      finish = resolve;
    });
    call.mockImplementation(() => blocked);
    const store = useQQMusicStore();
    useDataStore().setPlatformProfile("qqmusic", profile);
    const pending = store.loadContent();
    await store.logout();
    finish({ ok: true, data: { code: 200, userId: "100", playlists: [], songs: [song("old")] } });
    await pending;
    expect(store.isLoggedIn).toBe(false);
    expect(store.createdPlaylists).toEqual([]);
    expect(store.likedPlaylistTracks).toEqual([]);
    expect(clearSession).toHaveBeenCalledWith("qqmusic");
  });

  it("某一类同步失败保留上次结果，并不阻塞其他类目", async () => {
    const store = useQQMusicStore();
    await store.fetchStatus();
    const base = call.getMockImplementation()!;
    call.mockImplementation(async (platform, name, params) =>
      name === "user_playlist" && params.kind === "subscribed"
        ? { ok: false, error: "同步失败" }
        : base(platform, name, params),
    );
    await store.loadContent();
    expect(store.error).toBe("同步失败");
    expect(store.createdPlaylists).toHaveLength(1);
    expect(store.subscribedPlaylists).toHaveLength(1);
    expect(store.likedPlaylistTracks).toHaveLength(1);
  });

  it("合并同 ID 的两个平台歌单时保留来源，首个 QM 自建歌单不会丢失", async () => {
    const store = useQQMusicStore();
    await store.fetchStatus();
    const netease = useUserStore();
    netease.profile = { userId: 200, nickname: "NCM 用户" };
    netease.playlists = [
      { id: "liked", name: "我喜欢" },
      { id: "10", name: "NCM 自建" },
      { id: "20", name: "NCM 收藏" },
    ];
    netease.subcount = { createdPlaylistCount: 2, subPlaylistCount: 1, artistCount: 0 };
    const online = useOnlineLibrary();
    expect(online.createdPlaylists.value.map(({ id, source }) => [id, source])).toEqual([
      ["10", "qqmusic"],
      ["10", "netease"],
    ]);
    expect(online.subscribedPlaylists.value).toHaveLength(2);
  });
});
