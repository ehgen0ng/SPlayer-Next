import type { QMModule } from "../core/types";
import { getQQMusicCookies, getQQMusicUin, qmRequest } from "../core/request";
import { normalizeQMSong, type QMAudioInfo } from "../core/song";

interface DissResponse {
  code?: number;
  subcode?: number;
  msg?: string;
  songlist: Array<QMAudioInfo & { songInfo?: QMAudioInfo; musicData?: QMAudioInfo }>;
  total_song_num?: number;
  hasmore?: boolean | number;
  dissname?: string;
  desc?: string;
  nickname?: string;
  logo?: string;
  dirinfo?: {
    title?: string;
    desc?: string;
    picurl?: string;
    creator?: { nick?: string };
  };
}

/**
 * 分页读取 QQ 歌单，喜欢目录通过当前登录账号鉴权
 * @param params - 歌单 ID、分页偏移与预期账号，liked 表示我喜欢
 * @returns 歌单资料、歌曲及分页状态
 */
const songList: QMModule = async (params) => {
  const id = String(params.id ?? "");
  const liked = id === "liked";
  const userId = getQQMusicUin();
  if (params.userId && params.userId !== userId) throw new Error("QM 账号已变更");
  if (liked && userId === "0") throw new Error("请先登录 QM");
  if (!liked && (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
    throw new Error("无效的 QM 歌单 ID");
  }
  const offset = Math.max(0, Number(params.offset) || 0);
  const encryptedUin = getQQMusicCookies().euin;
  const authenticated = userId !== "0";
  const data = await qmRequest<DissResponse>(
    authenticated ? "music.srfDissInfo.DissInfo" : "music.srfDissInfo.aiDissInfo",
    authenticated ? "CgiGetDiss" : "uniform_get_Dissinfo",
    {
      disstid: liked ? 0 : Number(id),
      dirid: liked ? 201 : 0,
      tag: true,
      song_begin: offset,
      song_num: 100,
      userinfo: true,
      orderlist: true,
      onlysonglist: false,
      enc_host_uin: encryptedUin || "",
    },
    { session: false },
  );
  if (getQQMusicUin() !== userId) throw new Error("QM 账号已变更");
  if (data.code || data.subcode || !Array.isArray(data.songlist)) {
    throw new Error(data.msg || `QM 歌单请求失败: ${data.code || data.subcode || "缺少歌曲列表"}`);
  }
  const total = data.total_song_num ?? data.songlist.length;
  return {
    code: 200,
    userId,
    id,
    name: data.dirinfo?.title ?? data.dissname,
    description: data.dirinfo?.desc ?? data.desc,
    creator: data.dirinfo?.creator?.nick ?? data.nickname,
    cover: data.dirinfo?.picurl ?? data.logo,
    total,
    songs: data.songlist.map((song) => normalizeQMSong(song.songInfo ?? song.musicData ?? song)),
    hasMore:
      data.hasmore !== undefined
        ? data.hasmore === true || data.hasmore === 1
        : offset + data.songlist.length < total,
    nextOffset: offset + data.songlist.length,
  };
};

export default songList;
