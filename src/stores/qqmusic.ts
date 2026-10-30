import type { Playlist, Track } from "@shared/types/player";
import { fetchQQMusicLoginStatus, logoutQQMusic } from "@/apis/login/qqmusic";
import { fetchQQMusicUserPlaylists } from "@/apis/user/qqmusic";
import { fetchQQMusicPlaylist } from "@/apis/playlist/qqmusic";
import { useDataStore } from "@/stores/data";

/** 当前 QQ 账号的歌单与喜欢歌曲，退出或换号立即释放 */
export const useQQMusicStore = defineStore("qqmusic", () => {
  const data = useDataStore();
  const profile = computed(() => data.getPlatformProfile("qqmusic"));
  const isLoggedIn = computed(() => profile.value !== null);
  const createdPlaylists = shallowRef<Playlist[]>([]);
  const subscribedPlaylists = shallowRef<Playlist[]>([]);
  const likedPlaylistTracks = shallowRef<Track[]>([]);
  const likedSongIds = computed(() => new Set(likedPlaylistTracks.value.map((track) => track.id)));
  const likedPlaylistLoading = ref(false);
  const loading = ref(false);
  const error = ref("");
  const initialized = ref(false);
  let controller = new AbortController();
  let contentPromise: Promise<void> | null = null;
  let likedPromise: Promise<void> | null = null;
  let statusRequestId = 0;

  /**
   * 查询 QQ 歌曲的已同步红心状态
   * @param trackId - 歌曲 MID
   * @returns 是否已喜欢
   */
  const isLiked = (trackId: string): boolean => likedSongIds.value.has(trackId);

  /**
   * 刷新 QQ 我喜欢的完整曲目，并保持失败前的列表
   * @returns 当前同步任务
   */
  const ensureLikedPlaylist = (): Promise<void> => {
    if (likedPromise) return likedPromise;
    const userId = profile.value?.userId;
    if (!userId) return Promise.resolve();
    const signal = controller.signal;
    likedPlaylistLoading.value = true;
    const pending = (async () => {
      try {
        const { tracks } = await fetchQQMusicPlaylist("liked", "我喜欢", { userId, signal });
        if (!signal.aborted) likedPlaylistTracks.value = tracks;
      } catch (err) {
        if (!signal.aborted) {
          error.value = err instanceof Error ? err.message : String(err);
          console.warn("[qqmusic] liked playlist sync failed:", err);
        }
      } finally {
        if (!signal.aborted) {
          likedPlaylistLoading.value = false;
          likedPromise = null;
        }
      }
    })();
    likedPromise = pending;
    return pending;
  };

  /**
   * 同步 QQ 自建、收藏歌单和我喜欢，各类请求独立更新
   * @returns 当前同步任务
   */
  const loadContent = (): Promise<void> => {
    if (contentPromise) return contentPromise;
    const userId = profile.value?.userId;
    if (!userId) return Promise.resolve();
    const signal = controller.signal;
    loading.value = true;
    error.value = "";
    const pending = (async () => {
      const results = await Promise.allSettled([
        fetchQQMusicUserPlaylists(userId, "created", signal).then((items) => {
          if (!signal.aborted) createdPlaylists.value = items;
        }),
        fetchQQMusicUserPlaylists(userId, "subscribed", signal).then((items) => {
          if (!signal.aborted) subscribedPlaylists.value = items;
        }),
        ensureLikedPlaylist(),
      ]);
      if (signal.aborted) return;
      for (const result of results) {
        if (result.status === "rejected") {
          error.value =
            result.reason instanceof Error ? result.reason.message : String(result.reason);
          console.warn("[qqmusic] playlist sync failed:", result.reason);
        }
      }
      initialized.value = true;
      loading.value = false;
      contentPromise = null;
    })();
    contentPromise = pending;
    return pending;
  };

  watch(
    () => profile.value?.userId,
    () => {
      controller.abort();
      controller = new AbortController();
      statusRequestId++;
      contentPromise = null;
      likedPromise = null;
      createdPlaylists.value = [];
      subscribedPlaylists.value = [];
      likedPlaylistTracks.value = [];
      likedPlaylistLoading.value = false;
      loading.value = false;
      initialized.value = false;
      error.value = "";
      void loadContent();
    },
    { immediate: true, flush: "sync" },
  );

  /**
   * 校验 QQ 登录状态并按需刷新收藏
   * @param syncContent - 是否同步账号内容
   * @returns 是否仍然登录
   */
  const fetchStatus = async (syncContent = true): Promise<boolean> => {
    const requestId = ++statusRequestId;
    const latest = await fetchQQMusicLoginStatus();
    if (requestId !== statusRequestId) return isLoggedIn.value;
    data.setPlatformProfile("qqmusic", latest);
    if (latest && syncContent) await loadContent();
    return isLoggedIn.value;
  };

  /** 退出 QQ 账号并丢弃进行中的同步结果 */
  const logout = async (): Promise<void> => {
    statusRequestId++;
    await logoutQQMusic();
    data.clearPlatformProfile("qqmusic");
  };

  return {
    profile,
    isLoggedIn,
    createdPlaylists,
    subscribedPlaylists,
    likedPlaylistTracks,
    likedPlaylistLoading,
    loading,
    error,
    initialized,
    isLiked,
    ensureLikedPlaylist,
    loadContent,
    fetchStatus,
    logout,
  };
});
