import type { Track } from "@shared/types/player";
import { ErrorCode } from "@shared/types/errors";
import type { QualityLevel } from "@/utils/quality";
import { qqmusicCall } from "@/apis/qqmusic";

export type QQMusicPlayUrlResult =
  { available: true; url: string; isTrial: boolean } | { available: false; errorCode: ErrorCode };

interface SongUrlData {
  id: string;
  url: string;
  level?: string;
  format?: string;
  isFallback?: boolean;
}

interface SongUrlResponse {
  code: number;
  message?: string;
  data?: SongUrlData[];
}

/**
 * 解析 QM 单曲的播放 URL
 * @param track - 待解析的 Track（track.id 为 songmid）
 * @param songLevel - 音质偏好
 * @returns 播放地址及由官方试听文件标记识别的试听状态
 */
export const resolveQQMusicUrl = async (
  track: Track,
  songLevel: QualityLevel,
): Promise<QQMusicPlayUrlResult> => {
  try {
    const body = await qqmusicCall<SongUrlResponse>("song_url", {
      mid: track.id,
      mediaMid: track.mediaId,
      level: songLevel,
    });

    const item = body?.data?.[0];
    if (item?.url) {
      // QQ 官方播放器使用 RS02 文件请求试听片段，时长和付费状态不能代替此标记
      const isTrial = /^RS02[^/]+\.mp3$/i.test(new URL(item.url).pathname.split("/").at(-1)!);
      return {
        available: true,
        url: item.url,
        isTrial,
      };
    }

    return {
      available: false,
      errorCode: ErrorCode.URL_RESOLVE_FAILED,
    };
  } catch (err) {
    console.warn("[qqmusic] resolve URL failed:", err);
    return {
      available: false,
      errorCode: ErrorCode.URL_RESOLVE_FAILED,
    };
  }
};
