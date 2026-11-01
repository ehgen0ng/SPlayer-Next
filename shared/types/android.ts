import type {
  AudioQuality,
  PlaybackContext,
  PlayerStatus,
  RepeatMode,
  ShuffleMode,
  Track,
} from "./player";
import type { PersonalFmOptions } from "./platform/netease";

/** 原生播放器的权威状态，Node 和界面仅保存最近一次视图 */
export interface AndroidPlaybackSnapshot extends PlayerStatus {
  track: Track | null;
  context?: PlaybackContext;
  currentIndex: number;
  repeat: RepeatMode;
  shuffle: ShuffleMode;
  timestamp: number;
  mode: "queue" | "heart" | "fm";
  fmOptions: PersonalFmOptions;
  audioQuality?: AudioQuality;
}

/** 应用内部 JNI 通道消息，不对外提供网络监听 */
export type AndroidMessage =
  | { type: "invoke"; id: string; channel: string; args: unknown[] }
  | { type: "result"; id: string; value?: unknown; error?: string }
  | { type: "event"; channel: string; data: unknown; visibleOnly?: boolean }
  | { type: "ready" }
  | { type: "fatal"; error: string }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string };
