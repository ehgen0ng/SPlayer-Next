import type { QMSong } from "@shared/types/platform/qqmusic";
import type { Playlist, Track } from "@shared/types/player";
import { qqmusic as qmApi } from "@/apis/qqmusic";
import { qqSongsToTracks } from "@/utils/format/qqmusic";

interface PlaylistResponse {
  code?: number;
  message?: string;
  id?: string | number;
  name?: string;
  description?: string;
  creator?: string;
  cover?: string;
  total?: number;
  songs?: QMSong[];
  userId?: string;
  hasMore?: boolean;
  nextOffset?: number;
}

/**
 * 分页拉取 QQ 歌单的全部歌曲
 * @param id - 歌单 ID，liked 表示当前账号的我喜欢
 * @param fallbackName - 服务端未返回名称时使用的标题
 * @param options - 取消信号与预期账号
 * @returns 歌单资料及完整曲目
 */
export const fetchQQMusicPlaylist = async (
  id: string,
  fallbackName: string,
  options: { signal?: AbortSignal; userId?: string } = {},
): Promise<{ playlist: Playlist; tracks: Track[] }> => {
  const tracks: Track[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let body: PlaylistResponse;
  let metadata: PlaylistResponse | undefined;
  do {
    options.signal?.throwIfAborted();
    body = await qmApi.song_list<PlaylistResponse>({ id, offset, userId: options.userId });
    options.signal?.throwIfAborted();
    if (body.code !== 200) throw new Error(body.message || `QM 歌单请求失败: ${body.code}`);
    if (options.userId && body.userId !== options.userId) throw new Error("QM 账号已变更");
    metadata ??= body;
    const batch = qqSongsToTracks(body.songs);
    const previousCount = tracks.length;
    for (const track of batch) {
      if (seen.has(track.id)) continue;
      seen.add(track.id);
      tracks.push(track);
    }
    if (body.hasMore) {
      if (!body.nextOffset || body.nextOffset <= offset || tracks.length === previousCount) {
        throw new Error("QM 歌单分页未返回后续歌曲");
      }
      offset = body.nextOffset;
    }
  } while (body.hasMore);
  return {
    playlist: {
      id: String(metadata.id ?? id),
      name: metadata.name || fallbackName,
      cover: metadata.cover || tracks[0]?.cover,
      description: metadata.description,
      owner: metadata.creator,
      trackCount: metadata.total ?? tracks.length,
    },
    tracks,
  };
};
