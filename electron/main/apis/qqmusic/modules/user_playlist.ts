import type { QMPlaylistItem, QMUserPlaylistsResponse } from "@shared/types/platform/qqmusic";
import type { QMModule } from "../core/types";
import { getQQMusicCookies, getQQMusicUin, qmRequest } from "../core/request";

interface UserPlaylist {
  tid?: string | number;
  dirId?: number | string;
  dirName?: string;
  name?: string;
  nick?: string;
  nickname?: string;
  picUrl?: string;
  bigpicUrl?: string;
  logo?: string;
  songNum?: number;
  songnum?: number;
}

/**
 * 读取当前 QQ 账号创建或收藏的歌单，不向渲染进程返回凭据
 * @param params - 歌单类别、分页偏移及预期账号
 * @returns 归一化歌单与下一页偏移
 */
const userPlaylist: QMModule = async (params): Promise<QMUserPlaylistsResponse> => {
  const userId = getQQMusicUin();
  if (userId === "0" || (params.userId && params.userId !== userId)) {
    throw new Error("QM 账号已变更，请重新登录");
  }
  const offset = Math.max(0, Number(params.offset) || 0);
  let items: UserPlaylist[];
  let hasMore = false;
  if (params.kind === "created") {
    const data = await qmRequest<{ v_playlist: UserPlaylist[] }>(
      "music.musicasset.PlaylistBaseRead",
      "GetPlaylistByUin",
      { uin: userId },
      { session: false },
    );
    items = data.v_playlist;
  } else if (params.kind === "subscribed") {
    const encryptedUin = getQQMusicCookies().euin;
    if (!encryptedUin) throw new Error("请重新扫码登录 QM 以读取收藏歌单");
    const data = await qmRequest<{ v_list: UserPlaylist[]; hasmore?: boolean | number }>(
      "music.musicasset.PlaylistFavRead",
      "CgiGetPlaylistFavInfo",
      { uin: encryptedUin, offset, size: 100 },
      { session: false },
    );
    items = data.v_list;
    hasMore = data.hasmore === true || data.hasmore === 1;
  } else {
    throw new Error("不支持的 QM 歌单类别");
  }
  if (!Array.isArray(items)) throw new Error("QM 歌单响应缺少列表");
  if (getQQMusicUin() !== userId) throw new Error("QM 账号已变更");
  const playlists: QMPlaylistItem[] = items
    .filter((item) => Number(item.dirId) !== 201)
    .map((item) => ({
      id: String(item.tid ?? ""),
      name: item.dirName || item.name || "",
      cover: item.bigpicUrl || item.picUrl || item.logo,
      creator: item.nick || item.nickname,
      trackCount: item.songNum ?? item.songnum ?? 0,
    }))
    .filter((item) => item.id !== "" && item.id !== "0");
  return { code: 200, userId, playlists, hasMore, nextOffset: offset + items.length };
};

export default userPlaylist;
