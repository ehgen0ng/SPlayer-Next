import type { AudioSourceProbe, IpcResponse, Track } from "@shared/types/player";
import type { AudioSourcePreferences } from "@shared/types/audioSource";
import { getQualityLevel, type QualityLevel } from "@/utils/quality";
import { resolvePlaybackOnline, type OnlineSourceHost } from "@/services/onlineSource";
import { fetchLoginStatus } from "@/apis/login/netease";
import { NeteaseApiError } from "@/apis/netease";
import { isExplicitNeteaseAuthFailure } from "@/apis/neteaseAuth";
import { clearNeteaseCookies, getNeteaseCookies } from "@main/apis/netease";
import { pluginRegistry } from "@main/plugins/registry";
import { resolveUrl } from "@main/plugins/router";
import { store } from "@main/store";
import {
  addMusicSourceSuccess,
  orderPlugins,
  orderPluginsBySuccess,
} from "@shared/utils/pluginOrder";
import { invokeNative, nativeEvents } from "./bridge";
import { broadcast } from "@main/utils/broadcast";

/** 当前播放与下一首各保留一个请求，取消时只终止对应的选源 */
const selections = new Map<string, AbortController>();
nativeEvents.on("android:cancelSource", (id: string) => {
  selections.get(id)?.abort();
  selections.delete(id);
});
nativeEvents.on("android:serviceStopped", () => {
  for (const abort of selections.values()) abort.abort();
  selections.clear();
});

/**
 * 在原生加载线程请求音源时复用前台的官方接口、插件优先级与试听规则
 * @param track - 队列中的轻量曲目
 * @param quality - 请求音质
 * @param preferences - 原生持久化的前台选源偏好
 * @param requestId - 原生加载请求标识，用于取消迟到结果
 * @returns 可播放地址及实际提供方
 */
export const resolvePlaybackSource = async (
  track: Track,
  quality: QualityLevel,
  preferences: AudioSourcePreferences,
  requestId: string,
) => {
  if (!["plugin", "netease", "qqmusic", "kugou"].includes(track.source)) {
    throw new Error("安卓车机只支持在线音源");
  }
  if (selections.size >= 2) {
    const oldest = selections.keys().next().value!;
    selections.get(oldest)!.abort();
    selections.delete(oldest);
  }
  const abort = new AbortController();
  selections.set(requestId, abort);
  const host: OnlineSourceHost = {
    getSettings: () => preferences,
    getPlugins: () => {
      const list = pluginRegistry.listInfo();
      return { list, orderedList: orderPlugins(list, store.get("plugins.priority.musicUrl")) };
    },
    resolvePlugin: resolveUrl,
    getNeteaseSession: () => ({
      authenticated: Boolean(getNeteaseCookies().MUSIC_U),
      validate: async () => {
        try {
          if (await fetchLoginStatus()) return true;
        } catch (error) {
          if (!(error instanceof NeteaseApiError) || !isExplicitNeteaseAuthFailure(error)) {
            return Boolean(getNeteaseCookies().MUSIC_U);
          }
        }
        clearNeteaseCookies();
        broadcast("apis:sessionExpired", { platform: "netease" });
        return false;
      },
    }),
  };
  try {
    await Promise.allSettled(
      pluginRegistry
        .listInfo()
        .map((info) => pluginRegistry.getRuntime(info.manifest.id)?.initialLoad),
    );
    if (abort.signal.aborted) throw new Error("音源解析已取消");
    const result = await resolvePlaybackOnline(
      host,
      track,
      quality,
      (url) => invokeNative<IpcResponse<AudioSourceProbe>>("player:probeSource", url),
      { signal: abort.signal },
    );
    if (abort.signal.aborted) throw new Error("音源解析已取消");
    if (!result.ok) throw new Error(result.errorCode);
    return {
      ...result,
      cacheQuality: result.verifiedQuality ? getQualityLevel(result.verifiedQuality) : quality,
    };
  } finally {
    if (selections.get(requestId) === abort) selections.delete(requestId);
  }
};

nativeEvents.on("android:sourceLoaded", (id: string) => {
  const plugins = pluginRegistry.listInfo();
  const config = store.get("plugins");
  const counts = addMusicSourceSuccess(plugins, config.musicSourceSuccesses, id);
  if (!counts) return;
  store.set("plugins.musicSourceSuccesses", counts);
  if (config.autoSortMusicSources) {
    store.set(
      "plugins.priority.musicUrl",
      orderPluginsBySuccess(plugins, config.priority.musicUrl, counts),
    );
  }
  broadcast("android:pluginOrderChanged", {
    musicSourceSuccesses: counts,
    priority: config.priority,
  });
});
