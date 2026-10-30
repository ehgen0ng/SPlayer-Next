import type { Playlist } from "@shared/types/player";
import type { Platform } from "@shared/types/platform";
import { useUserStore } from "@/stores/user";
import { useQQMusicStore } from "@/stores/qqmusic";

export type OnlinePlaylist = Playlist & { source: Platform };

/** 汇总已登录平台的收藏，保留原始 ID 与来源以便跳转和播放 */
export const useOnlineLibrary = () => {
  const netease = useUserStore();
  const qqmusic = useQQMusicStore();
  const isLoggedIn = computed(() => qqmusic.isLoggedIn || netease.isLoggedIn);
  const createdPlaylists = computed<OnlinePlaylist[]>(() => [
    ...qqmusic.createdPlaylists.map((playlist) => ({ ...playlist, source: "qqmusic" as const })),
    ...netease.createdPlaylists
      .slice(1)
      .map((playlist) => ({ ...playlist, source: "netease" as const })),
  ]);
  const subscribedPlaylists = computed<OnlinePlaylist[]>(() => [
    ...qqmusic.subscribedPlaylists.map((playlist) => ({ ...playlist, source: "qqmusic" as const })),
    ...netease.subscribedPlaylists.map((playlist) => ({ ...playlist, source: "netease" as const })),
  ]);
  const likedPlaylistTracks = computed(() => [
    ...qqmusic.likedPlaylistTracks,
    ...netease.likedPlaylistTracks,
  ]);
  const likedPlaylistLoading = computed(
    () => qqmusic.likedPlaylistLoading || netease.likedPlaylistLoading,
  );

  return {
    isLoggedIn,
    createdPlaylists,
    subscribedPlaylists,
    likedPlaylistTracks,
    likedPlaylistLoading,
  };
};
