import type { SavedPlatformAccount } from "@shared/types/apis";
import { ALL_PLATFORMS, type Platform, type PlatformProfile } from "@shared/types/platform";
import { useDataStore } from "./data";
import { useUserStore } from "./user";
import { useQQMusicStore } from "./qqmusic";
import { useStatusStore } from "./status";
import { getPlatformAccountAdapter } from "@/apis/login/platform";

/** 三平台共用公开账号列表，歌曲内容仍由各平台当前账号持有 */
export const useAccountsStore = defineStore("accounts", () => {
  const data = useDataStore();
  const netease = useUserStore();
  const qqmusic = useQQMusicStore();
  const accounts = shallowRef<SavedPlatformAccount[]>([]);
  const busy = ref(false);
  let revision = 0;
  let kugouStatusRequest = 0;

  /**
   * 读取平台当前资料，网易云沿用原用户 Store
   * @param platform - 音乐平台
   * @returns 当前资料或空值
   */
  const getProfile = (platform: Platform): PlatformProfile | null => {
    if (platform !== "netease") return data.getPlatformProfile(platform);
    const profile = netease.profile;
    return profile
      ? {
          userId: String(profile.userId),
          nickname: profile.nickname,
          avatarUrl: profile.avatarUrl ?? "",
          isVip: !!profile.vipType,
        }
      : null;
  };

  const platform = computed(() => data.activeAccountPlatform);
  const profile = computed(() => getProfile(platform.value));

  /** 刷新已保存账号的公开列表，丢弃旧操作返回的列表 */
  const refresh = async (): Promise<void> => {
    const version = ++revision;
    const latest = await window.api.apis.listAccounts();
    if (version === revision) accounts.value = latest;
  };

  /**
   * 清除待替换平台的界面内容，不影响其他平台的活动账号
   * @param target - 音乐平台
   */
  const prepare = (target: Platform): void => {
    if (target === "netease") netease.prepareAccountSwitch();
    else if (target === "qqmusic") qqmusic.prepareAccountSwitch();
    else {
      kugouStatusRequest++;
      data.clearPlatformProfile(target);
    }
  };

  /**
   * 校验平台当前凭据并加载该账号的内容
   * @param target - 音乐平台
   * @returns 是否登录成功
   */
  const fetchStatus = async (target: Platform): Promise<boolean> => {
    if (target === "netease") return netease.fetchStatus();
    if (target === "qqmusic") return qqmusic.fetchStatus();
    const request = ++kugouStatusRequest;
    const latest = await getPlatformAccountAdapter(target).fetchProfile();
    if (request !== kugouStatusRequest) return getProfile("kugou") !== null;
    data.setPlatformProfile(target, latest);
    return latest !== null;
  };

  /**
   * 切换同平台保存账号，跨平台切换仅选择其当前账号
   * @param account - 要使用的公开账号记录
   * @returns 账号校验是否成功
   */
  const switchAccount = async (account: SavedPlatformAccount): Promise<boolean> => {
    if (busy.value) return false;
    busy.value = true;
    try {
      if (getProfile(account.platform)?.userId !== account.profile.userId || !account.active) {
        prepare(account.platform);
        await window.api.apis.switchAccount(account.platform, account.profile.userId);
        if (!(await fetchStatus(account.platform))) return false;
      }
      data.activeAccountPlatform = account.platform;
      useStatusStore().searchPlatform = account.platform;
      return true;
    } finally {
      await refresh().finally(() => {
        busy.value = false;
      });
    }
  };

  /**
   * 移除保存账号，同平台账号优先接续，选中平台清空后按平台顺序接续
   * @param account - 要移除的账号
   */
  const removeAccount = async (account: SavedPlatformAccount): Promise<void> => {
    if (busy.value) return;
    busy.value = true;
    const selected = account.active && data.activeAccountPlatform === account.platform;
    try {
      if (account.active) prepare(account.platform);
      await window.api.apis.removeAccount(account.platform, account.profile.userId);
      if (account.active) {
        await refresh();
        const remaining = accounts.value.find(
          (item) => item.platform === account.platform && item.active,
        );
        if (remaining) {
          await fetchStatus(account.platform);
          if (selected) {
            data.activeAccountPlatform = account.platform;
            useStatusStore().searchPlatform = account.platform;
          }
        } else if (selected) {
          const index = ALL_PLATFORMS.indexOf(account.platform);
          const following = [...ALL_PLATFORMS.slice(index + 1), ...ALL_PLATFORMS.slice(0, index)];
          for (const target of following) {
            const next =
              accounts.value.find((item) => item.platform === target && item.active) ??
              accounts.value.find((item) => item.platform === target);
            if (!next) continue;
            if (!next.active) {
              prepare(target);
              await window.api.apis.switchAccount(target, next.profile.userId);
            }
            if (!(await fetchStatus(target))) continue;
            data.activeAccountPlatform = target;
            useStatusStore().searchPlatform = target;
            break;
          }
        }
      }
    } finally {
      await refresh().finally(() => {
        busy.value = false;
      });
    }
  };

  return {
    accounts,
    busy,
    platform,
    profile,
    getProfile,
    fetchStatus,
    refresh,
    switchAccount,
    removeAccount,
  };
});
