import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedPlatformAccount } from "@shared/types/apis";
import { useAccountsStore } from "./accounts";
import { useDataStore } from "./data";
import { useQQMusicStore } from "./qqmusic";
import { useUserStore } from "./user";

vi.mock("localforage", () => ({ default: { createInstance: () => ({}) } }));
const state = vi.hoisted(() => ({ status: { searchPlatform: "qqmusic" }, current: "1" }));
vi.mock("./status", () => ({ useStatusStore: () => state.status }));

/**
 * 构造公开账号样本
 * @param platform - 音乐平台
 * @param userId - 账号 ID
 * @param active - 是否为平台当前账号
 * @returns 保存账号的公开记录
 */
const account = (
  platform: SavedPlatformAccount["platform"],
  userId: string,
  active = false,
): SavedPlatformAccount => ({
  platform,
  active,
  profile: { userId, nickname: `${platform}-${userId}`, avatarUrl: "", isVip: false },
});

describe("三平台账号切换", () => {
  const call = vi.fn();
  const switchApi = vi.fn();
  const removeApi = vi.fn();
  const listApi = vi.fn();
  beforeEach(() => {
    setActivePinia(createPinia());
    state.current = "1";
    state.status.searchPlatform = "qqmusic";
    listApi.mockReset().mockResolvedValue([]);
    switchApi.mockReset().mockImplementation(async (_platform, id) => {
      state.current = id;
    });
    removeApi.mockReset().mockResolvedValue(undefined);
    call.mockReset().mockImplementation(async (_platform, name, params) => {
      if (name === "user_detail")
        return {
          ok: true,
          data: { code: 200, loggedIn: true, profile: account(_platform, state.current).profile },
        };
      if (name === "user_playlist")
        return {
          ok: true,
          data: {
            code: 200,
            userId: params.userId,
            playlists: [{ id: `${params.userId}-list`, name: params.kind }],
            hasMore: false,
          },
        };
      if (name === "song_list")
        return {
          ok: true,
          data: {
            code: 200,
            userId: params.userId,
            songs: [
              {
                id: `${params.userId}-song`,
                mid: `${params.userId}-song`,
                name: "歌曲",
                artist: "歌手",
                duration: 1000,
              },
            ],
            hasMore: false,
            total: 1,
          },
        };
      throw new Error(`意外接口 ${name}`);
    });
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        apis: { call, listAccounts: listApi, switchAccount: switchApi, removeAccount: removeApi },
      },
    });
  });

  it("QM 换号清除 A 收藏，仅加载 B 内容，同时保留网易云账号", async () => {
    const qm = useQQMusicStore();
    await qm.fetchStatus();
    expect(qm.likedPlaylistTracks[0].id).toBe("1-song");
    useUserStore().profile = { userId: 100, nickname: "网易云" };
    const accounts = useAccountsStore();
    expect(await accounts.switchAccount(account("qqmusic", "2"))).toBe(true);
    expect(qm.profile?.userId).toBe("2");
    expect(qm.createdPlaylists.map((item) => item.id)).toEqual(["2-list"]);
    expect(qm.likedPlaylistTracks.map((item) => item.id)).toEqual(["2-song"]);
    expect(useUserStore().profile?.userId).toBe(100);
  });

  it("切换平台当前账号仅选择其资料，不重新登录也不清空其他平台内容", async () => {
    const accounts = useAccountsStore();
    useDataStore().setPlatformProfile("qqmusic", account("qqmusic", "1").profile);
    useUserStore().profile = { userId: 100, nickname: "网易云" };
    expect(await accounts.switchAccount(account("netease", "100", true))).toBe(true);
    expect(accounts.platform).toBe("netease");
    expect(state.status.searchPlatform).toBe("netease");
    expect(switchApi).not.toHaveBeenCalled();
    expect(useDataStore().getPlatformProfile("qqmusic")?.userId).toBe("1");
  });

  it("网易云切换保存账号会隔离旧内容，移除非活动账号不影响当前会话", async () => {
    const netease = useUserStore();
    netease.profile = { userId: 1, nickname: "A" };
    netease.playlists = [{ id: "10", name: "旧歌单" }];
    vi.spyOn(netease, "fetchStatus").mockImplementation(async () => {
      netease.profile = { userId: 2, nickname: "B" };
      return true;
    });
    const accounts = useAccountsStore();
    expect(await accounts.switchAccount(account("netease", "2"))).toBe(true);
    expect(netease.playlists).toEqual([]);
    expect(netease.profile?.userId).toBe(2);
    await accounts.removeAccount(account("netease", "1"));
    expect(removeApi).toHaveBeenCalledWith("netease", "1");
    expect(netease.profile?.userId).toBe(2);
  });

  it("酷狗旧状态查询的迟到结果不能清掉换号后的资料", async () => {
    let finish!: (value: unknown) => void;
    call.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const accounts = useAccountsStore();
    const pending = accounts.fetchStatus("kugou");
    expect(await accounts.switchAccount(account("kugou", "2"))).toBe(true);
    finish({ ok: true, data: { code: 200, loggedIn: false } });
    await pending;
    expect(accounts.getProfile("kugou")?.userId).toBe("2");
  });

  it.each(["netease", "qqmusic", "kugou"] as const)(
    "%s 删除当前账号后加载同平台剩余账号，优先于其他平台",
    async (platform) => {
      const accounts = useAccountsStore();
      const data = useDataStore();
      const netease = useUserStore();
      netease.profile = { userId: 1, nickname: "网易云" };
      vi.spyOn(netease, "fetchStatus").mockImplementation(async () => {
        netease.profile = { userId: 2, nickname: "网易云 2" };
        return true;
      });
      await useQQMusicStore().fetchStatus();
      data.setPlatformProfile("kugou", account("kugou", "1").profile);
      data.activeAccountPlatform = platform;
      state.status.searchPlatform = platform;
      removeApi.mockImplementation(async () => {
        state.current = "2";
      });
      listApi.mockResolvedValue([
        account(platform, "2", true),
        account(platform === "qqmusic" ? "kugou" : "qqmusic", "1", true),
      ]);

      await accounts.removeAccount(account(platform, "1", true));

      expect(accounts.getProfile(platform)?.userId).toBe("2");
      expect(accounts.platform).toBe(platform);
      expect(state.status.searchPlatform).toBe(platform);
      expect(switchApi).not.toHaveBeenCalled();
      if (platform === "qqmusic") {
        expect(useQQMusicStore().likedPlaylistTracks.map((item) => item.id)).toEqual(["2-song"]);
        expect(useQQMusicStore().createdPlaylists.map((item) => item.id)).toEqual(["2-list"]);
      }
    },
  );

  it.each([
    ["qqmusic", "kugou", "netease"],
    ["qqmusic", "netease", null],
    ["kugou", "netease", "qqmusic"],
    ["netease", "qqmusic", "kugou"],
  ] as const)("%s 清空后顺序切换到 %s，跳过空平台", async (platform, target, other) => {
    const accounts = useAccountsStore();
    const data = useDataStore();
    useUserStore().profile = { userId: 1, nickname: "网易云" };
    vi.spyOn(useUserStore(), "fetchStatus").mockImplementation(async () => {
      useUserStore().profile = { userId: 2, nickname: "网易云 2" };
      return true;
    });
    data.setPlatformProfile("qqmusic", account("qqmusic", "1").profile);
    data.setPlatformProfile("kugou", account("kugou", "1").profile);
    data.activeAccountPlatform = platform;
    removeApi.mockImplementation(async () => {
      state.current = "2";
    });
    listApi.mockResolvedValue([
      ...(other ? [account(other, "1", true)] : []),
      account(target, "2", true),
    ]);

    await accounts.removeAccount(account(platform, "1", true));

    expect(accounts.platform).toBe(target);
    expect(accounts.profile?.userId).toBe("2");
    expect(accounts.getProfile(platform)).toBeNull();
    expect(state.status.searchPlatform).toBe(target);
    expect(switchApi).not.toHaveBeenCalled();
  });

  it("下一平台只有保存账号时先恢复凭据再显示资料", async () => {
    const accounts = useAccountsStore();
    useDataStore().setPlatformProfile("qqmusic", account("qqmusic", "1").profile);
    listApi.mockResolvedValue([account("kugou", "2")]);

    await accounts.removeAccount(account("qqmusic", "1", true));

    expect(switchApi).toHaveBeenCalledWith("kugou", "2");
    expect(accounts.platform).toBe("kugou");
    expect(accounts.profile?.userId).toBe("2");
  });

  it("删除后台平台的最后一个账号不改变顶部选中的账号", async () => {
    const accounts = useAccountsStore();
    useDataStore().setPlatformProfile("qqmusic", account("qqmusic", "1").profile);
    useDataStore().setPlatformProfile("kugou", account("kugou", "1").profile);
    listApi.mockResolvedValue([account("qqmusic", "1", true)]);
    call.mockClear();

    await accounts.removeAccount(account("kugou", "1", true));

    expect(accounts.platform).toBe("qqmusic");
    expect(accounts.profile?.userId).toBe("1");
    expect(accounts.getProfile("kugou")).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it("删除最后一个保存账号后显示未登录并释放忙碌状态", async () => {
    const accounts = useAccountsStore();
    useDataStore().setPlatformProfile("qqmusic", account("qqmusic", "1").profile);

    await accounts.removeAccount(account("qqmusic", "1", true));

    expect(accounts.profile).toBeNull();
    expect(accounts.accounts).toEqual([]);
    expect(accounts.busy).toBe(false);
    expect(switchApi).not.toHaveBeenCalled();
  });
});
