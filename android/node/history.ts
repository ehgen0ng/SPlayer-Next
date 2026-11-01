import fs from "node:fs";
import path from "node:path";
import { writeFileSync } from "atomically";
import type { Track } from "@shared/types/player";
import { historyKey, recordHistory, type HistoryEntry } from "@shared/utils/history";
import { databaseDir } from "@main/utils/paths";
import { broadcast } from "@main/utils/broadcast";
import { ipcMain } from "./runtime/ipc";

const file = path.join(databaseDir, "recent-history.json");
let entries: HistoryEntry[] = [];

/**
 * 原子保存有界历史并通知可见界面刷新
 * @param next - 更新后的历史记录
 */
const save = (next: HistoryEntry[]): void => {
  writeFileSync(file, JSON.stringify(next));
  entries = next;
  broadcast("android:historyChanged", null, true);
};

/**
 * 记录后台已经开始播放的曲目
 * @param track - 当前轻量曲目
 */
export const recordNativeHistory = (track: Track): void => save(recordHistory(entries, track));

/** 加载原生历史并注册已有历史界面需要的读写操作 */
export const initNativeHistory = (): void => {
  if (fs.existsSync(file)) entries = JSON.parse(fs.readFileSync(file, "utf8"));
  ipcMain.handle("history:list", () => entries);
  ipcMain.handle("history:remove", (_event, track: Track) =>
    save(entries.filter((entry) => historyKey(entry.track) !== historyKey(track))),
  );
  ipcMain.handle("history:clear", () => save([]));
};
