import type { Playlist } from "@shared/types/player";
import type { QMUserPlaylistsResponse } from "@shared/types/platform/qqmusic";
import { qqmusicCall } from "@/apis/qqmusic";

/**
 * 拉取当前 QQ 账号的完整歌单列表
 * @param userId - 预期登录账号
 * @param kind - 自建或收藏歌单
 * @param signal - 取消信号
 * @returns 按服务端顺序排列的歌单
 */
export const fetchQQMusicUserPlaylists = async (
  userId: string,
  kind: "created" | "subscribed",
  signal: AbortSignal,
): Promise<Playlist[]> => {
  const playlists = new Map<string, Playlist>();
  let offset = 0;
  while (!signal.aborted) {
    const page = await qqmusicCall<QMUserPlaylistsResponse>("user_playlist", {
      userId,
      kind,
      offset,
    });
    signal.throwIfAborted();
    if (page.code !== 200 || page.userId !== userId) throw new Error("QM 账号已变更");
    for (const item of page.playlists) {
      playlists.set(item.id, {
        id: item.id,
        name: item.name,
        cover: item.cover,
        owner: item.creator,
        trackCount: item.trackCount,
      });
    }
    if (!page.hasMore) return [...playlists.values()];
    if (page.nextOffset <= offset) throw new Error("QM 歌单分页未返回后续内容");
    offset = page.nextOffset;
  }
  signal.throwIfAborted();
  return [];
};
