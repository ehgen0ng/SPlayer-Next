import localforage from "localforage";
import type { Track } from "@shared/types/player";
import { historyKey as keyOf, recordHistory, type HistoryEntry } from "@shared/utils/history";
import { isAndroid } from "@/platform";
import { invokeAndroid } from "@/platform/android";
export type { HistoryEntry } from "@shared/utils/history";

const db = localforage.createInstance({ name: "splayer", storeName: "history" });
const HISTORY_KEY = "entries";

export const useHistoryStore = defineStore("history", () => {
  /** 倒序：最近播放在前 */
  const entries = shallowRef<HistoryEntry[]>([]);
  /** 首次读盘，并发调用复用同一个 */
  let loadPromise: Promise<void> | null = null;

  /** 持久化 */
  const persist = (): void => {
    void db.setItem(HISTORY_KEY, toRaw(entries.value)).catch(() => {});
  };

  /** 安卓读取后台权威记录，桌面沿用首次加载的本地存储 */
  const load = (): Promise<void> => {
    if (isAndroid)
      return invokeAndroid<HistoryEntry[]>("history:list").then((value) => {
        entries.value = value;
      });
    if (!loadPromise) {
      loadPromise = db
        .getItem<HistoryEntry[]>(HISTORY_KEY)
        .then((cached) => {
          if (Array.isArray(cached)) entries.value = cached;
        })
        .catch(() => {});
    }
    return loadPromise;
  };

  /**
   * 记录一次播放：同源同 id 去重后置顶
   * @param track 当前播放曲目
   */
  const record = async (track: Track): Promise<void> => {
    if (isAndroid) return;
    if (!track?.id) return;
    await load();
    entries.value = recordHistory(entries.value, track);
    persist();
  };

  /**
   * 移除单条历史
   * @param track 要删除的曲目
   */
  const remove = (track: Track): void => {
    if (isAndroid) {
      void invokeAndroid("history:remove", toRaw(track)).then(load);
      return;
    }
    const key = keyOf(track);
    const next = entries.value.filter((entry) => keyOf(entry.track) !== key);
    if (next.length === entries.value.length) return;
    entries.value = next;
    persist();
  };

  /** 清空全部历史 */
  const clear = (): void => {
    if (isAndroid) {
      void invokeAndroid("history:clear").then(load);
      return;
    }
    entries.value = [];
    persist();
  };

  /** 按时间倒序的扁平曲目列表 */
  const tracks = computed<Track[]>(() => entries.value.map((entry) => entry.track));

  return {
    entries,
    tracks,
    load,
    record,
    remove,
    clear,
  };
});
