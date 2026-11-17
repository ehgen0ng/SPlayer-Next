import type { AndroidPlaybackSnapshot } from "@shared/types/android";
import type { FftData, PlaybackQueueItem } from "@shared/types/player";
import type { PluginsConfig } from "@shared/types/plugin";
import { useMediaStore } from "@/stores/media";
import { useStatusStore } from "@/stores/status";
import { useSettingsStore } from "@/stores/settings";
import { usePluginsStore } from "@/stores/plugins";
import { useHistoryStore } from "@/stores/history";
import * as queue from "@/stores/queue";
import * as playback from "@/services/playback";
import * as lyricLoader from "@/services/lyric/loader";
import { loadCoverForTrack } from "@/services/coverLoader";
import { extractColorFromUrl } from "@/utils/color";
import { toast } from "@/composables/useToast";
import { invokeAndroid, onAndroid } from "./android";

/**
 * 同步原生快照并补偿传输延迟，周期进度平滑校正、切歌和跳转立即定位
 * @param snapshot - 原生播放状态
 */
const applySnapshot = (snapshot: AndroidPlaybackSnapshot): void => {
  const status = useStatusStore();
  const media = useMediaStore();
  const next = snapshot.track;
  const previous = media.track;
  const changed =
    previous?.id !== next?.id ||
    previous?.source !== next?.source ||
    previous?.plugin?.pluginId !== next?.plugin?.pluginId;
  status.playIndex = snapshot.currentIndex;
  status.state = snapshot.state;
  status.duration = snapshot.duration;
  status.volume = snapshot.volume;
  status.speed = snapshot.speed;
  status.repeatMode = snapshot.repeat;
  status.shuffleMode = snapshot.shuffle;
  status.heartMode = snapshot.mode === "heart";
  status.fmMode = snapshot.mode === "fm";
  status.fmOptions = snapshot.fmOptions;
  status.trackLoading = snapshot.state === "loading";
  status.currentSource = next ? `android://${next.source}/${next.id}` : null;
  playback.setDuration(snapshot.duration);
  playback.setSpeed(snapshot.speed);
  playback.setPlaying(snapshot.state === "playing");
  const elapsed = snapshot.state === "playing" ? Math.max(0, Date.now() - snapshot.timestamp) : 0;
  const position = Math.min(snapshot.position + elapsed * snapshot.speed, snapshot.duration);
  status.position = playback.setCurrentTime(position, {
    force: changed || snapshot.positionDiscontinuity || snapshot.state !== "playing",
  });
  media.setPlaybackContext(snapshot.context);
  if (changed) {
    media.track = next;
    media.detail = null;
    lyricLoader.beginLoad();
    if (next) {
      void lyricLoader.loadForTrack(null);
      void loadCoverForTrack(next);
      extractColorFromUrl(next.cover ?? null);
    }
  }
  if (
    snapshot.audioQuality &&
    JSON.stringify(media.detail?.quality) !== JSON.stringify(snapshot.audioQuality)
  ) {
    media.detail = { externalLyrics: [], ...media.detail, quality: snapshot.audioQuality };
  }
  media.updateLyricIndex(status.position + status.lyricOffsetMs);
};

/**
 * 安装原生状态订阅，复用已有插件、配置和歌词服务
 * @returns 释放界面监听的方法
 */
export const initAndroidPlayback = async (): Promise<() => void> => {
  const settings = useSettingsStore();
  const status = useStatusStore();
  await settings.syncSystem();
  await usePluginsStore().load();
  const dispose = [
    onAndroid<Pick<PluginsConfig, "musicSourceSuccesses" | "priority">>(
      "android:pluginOrderChanged",
      (config) => {
        settings.system.plugins.musicSourceSuccesses = config.musicSourceSuccesses;
        settings.system.plugins.priority = config.priority;
      },
    ),
    onAndroid("android:historyChanged", () => {
      void useHistoryStore().load();
    }),
    onAndroid<AndroidPlaybackSnapshot>("android:playback", applySnapshot),
    onAndroid<PlaybackQueueItem[]>("android:queue", (entries) => {
      queue.queueEntries.value = entries;
    }),
    onAndroid<string>("android:error", (message) => toast.error(message)),
    onAndroid<{ type: string; data: FftData }>("player:event", (event) => {
      if (event.type === "fftData") playback.setFftFrame(event.data.ldata, event.data.rdata);
    }),
    window.api.nowPlaying.onLyricOffsetChange(({ offsetMs }) => {
      useStatusStore().lyricOffsetMs = offsetMs;
    }),
  ];
  queue.queueEntries.value = await invokeAndroid<PlaybackQueueItem[]>("android:queue");
  applySnapshot(await invokeAndroid<AndroidPlaybackSnapshot>("android:snapshot"));
  const current = await window.api.nowPlaying.requestSnapshot();
  useStatusStore().lyricOffsetMs = current.lyricOffsetMs;
  dispose.push(
    watch(
      () => [
        settings.player.songLevel,
        settings.player.preferPluginSource,
        settings.player.allowTrialPlay,
        settings.player.preloadNextTrack,
        settings.player.verifySourceArtist,
        settings.player.verifySourceDuration,
        status.searchPlatform,
      ],
      () => {
        void invokeAndroid("android:preferences", {
          quality: settings.player.songLevel,
          preferPluginSource: settings.player.preferPluginSource,
          allowTrialPlay: settings.player.allowTrialPlay,
          preloadNextTrack: settings.player.preloadNextTrack,
          verifySourceArtist: settings.player.verifySourceArtist,
          verifySourceDuration: settings.player.verifySourceDuration,
          searchPlatform: status.searchPlatform,
        }).catch(console.error);
      },
      { immediate: true },
    ),
  );
  return () => dispose.forEach((stop) => stop());
};
