/**
 * 下载地址/歌词即时解析服务
 *
 * 批量下载整批入队后，主进程在轮到某任务且缺少 URL 时广播 download:resolve，
 * 这里解析 URL 与歌词后回传。解析请求因此保持一次一首，避免集中请求触发服务端风控。
 */
import type {
  DownloadResolution,
  DownloadResolvePayload,
  DownloadTask,
} from "@shared/types/download";
import i18n from "@/i18n";
import { resolveDownloadSource } from "@/services/download/source";
import { resolveDownloadLyric } from "@/services/download/lyric";
import { buildDownloadLyric } from "@/utils/lyric/serialize";
import { toast } from "@/composables/useToast";
import { getQualityLevel, QUALITY_LABELS, QUALITY_ORDER } from "@/utils/quality";

/**
 * 解析单个任务的音源与歌词
 * @param payload - 下载任务参数
 * @param signal - 任务取消信号
 * @returns 已校验音源和可选歌词
 */
const resolvePayload = async (
  payload: DownloadResolvePayload,
  signal: AbortSignal,
): Promise<DownloadResolution> => {
  const source = await resolveDownloadSource(
    payload.track,
    payload.qualityLevel,
    payload.usePlaybackForDownload,
    signal,
  );
  signal.throwIfAborted();
  if (!source) throw new Error("no download source");
  const actual = source.quality ? getQualityLevel(source.quality) : undefined;
  if (actual && QUALITY_ORDER.indexOf(actual) < QUALITY_ORDER.indexOf(payload.qualityLevel)) {
    toast.warning(
      i18n.global.t("player.qualityFallback", {
        requested: QUALITY_LABELS[payload.qualityLevel],
        actual: QUALITY_LABELS[actual],
      }),
    );
  }
  const { tagOptions } = payload;
  let lyricText: string | undefined;
  let ttmlText: string | undefined;
  if (tagOptions.embedLyric || tagOptions.writeLrc || tagOptions.saveTtml) {
    const lyric = await resolveDownloadLyric(payload.track);
    if (lyric) {
      const input = {
        content: lyric.content,
        translation: lyric.translation,
        translationFormat: lyric.translationFormat,
        romaji: lyric.romaji,
        romajiFormat: lyric.romajiFormat,
      };
      // 内嵌与 .lrc 文件共用所选格式（lrc/增强 LRC）
      if (tagOptions.embedLyric || tagOptions.writeLrc) {
        lyricText = buildDownloadLyric(input, lyric.format, payload.lyricFileFormat) ?? undefined;
      }
      // 完整 TTML 单独导出
      if (tagOptions.saveTtml) {
        ttmlText = buildDownloadLyric(input, lyric.format, "ttml") ?? undefined;
      }
    }
  }
  return {
    url: source.url,
    declaredFormat: source.format,
    declaredSize: source.size,
    resolvedQuality: source.quality,
    resolvedQualityLevel: actual,
    lyricText,
    ttmlText,
  };
};

/**
 * 注册下载解析及状态监听，取消时停止继续尝试插件
 * @param onState - 更新界面任务状态
 * @returns 注销监听并取消未完成解析
 */
export const initDownloadResolver = (onState: (task: DownloadTask) => void): (() => void) => {
  let active: { taskId: string; controller: AbortController } | undefined;
  const offState = window.api.download.onState((task) => {
    if (task.taskId === active?.taskId && task.status !== "downloading") active.controller.abort();
    onState(task);
  });
  const offResolve = window.api.download.onResolve((payload) => {
    active?.controller.abort();
    const controller = new AbortController();
    active = { taskId: payload.taskId, controller };
    resolvePayload(payload, controller.signal)
      .then((res) => {
        if (!controller.signal.aborted)
          return window.api.download.submitResolution(payload.taskId, res);
        return undefined;
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        toast.error(i18n.global.t("download.resolveFailed", { title: payload.track.title }));
        void window.api.download.failResolution(payload.taskId);
      })
      .finally(() => {
        if (active?.controller === controller) active = undefined;
      });
  });
  return () => {
    active?.controller.abort();
    active = undefined;
    offState();
    offResolve();
  };
};
