import type {
  PlaybackQueueOptions,
  PlaybackQueueSnapshot,
  PlaybackStatusSnapshot,
} from "@shared/types/music";
import type { RepeatMode, ShuffleMode, Track } from "@shared/types/player";
import type { AndroidPlaybackSnapshot } from "@shared/types/android";
import * as nowPlaying from "@main/services/nowPlaying";
import { playerLog } from "@main/utils/logger";
import { invokeNative, nativeEvents } from "./bridge";
import { createPlayStatsRecorder } from "@shared/utils/playStats";
import { insertPlayEvent } from "@main/database/playStats";
import { recordNativeHistory } from "./history";
import { historyKey } from "@shared/utils/history";

let snapshot: AndroidPlaybackSnapshot | null = null;
const stats = createPlayStatsRecorder(insertPlayEvent);
let recordedTrack: string | null = null;

/**
 * 发送无需等待的控制命令，并记录原生处理失败
 * @param channel - 原生控制方法
 * @param args - 方法参数
 */
const command = (channel: string, ...args: unknown[]): void => {
  void invokeNative(channel, ...args).catch((error) => playerLog.warn(channel, error));
};

/**
 * 更新原生状态视图，仅在状态或倍速改变时通知共用服务
 * @param value - 原生播放器快照
 */
export const applyPlaybackSnapshot = (value: AndroidPlaybackSnapshot): void => {
  const previous = snapshot;
  snapshot = value;
  stats.update(value.track, value.state === "playing");
  const key = value.track ? historyKey(value.track) : null;
  if (key !== (previous?.track ? historyKey(previous.track) : null)) recordedTrack = null;
  if (value.track && value.state === "playing" && recordedTrack !== key) {
    recordNativeHistory(value.track);
    recordedTrack = key;
  }
  if (previous?.track?.id !== value.track?.id || previous?.track?.source !== value.track?.source) {
    nowPlaying.update(value.track, [], null);
  }
  if (previous?.state !== value.state) nowPlaying.onPlayStateChange(value.state);
  if (previous?.speed !== value.speed) nowPlaying.onSpeedChange(value.speed);
  nowPlaying.onPosition(value.position, value.state === "playing");
};

/**
 * 读取已从原生服务初始化的状态
 * @returns 原生播放器最近一次快照
 */
export const getPlaybackSnapshot = (): AndroidPlaybackSnapshot => {
  if (!snapshot) throw new Error("原生播放器尚未就绪");
  return snapshot;
};

nativeEvents.on("android:playback", applyPlaybackSnapshot);
nativeEvents.on("android:roundEnded", () => stats.ended(true));
nativeEvents.on("android:serviceStopped", () => stats.finalize());

export const playerControl = {
  /**
   * 分页读取原生权威队列
   * @param options - 分页范围
   * @returns 当前队列切片
   */
  getQueue: (options: PlaybackQueueOptions = {}): Promise<PlaybackQueueSnapshot> =>
    invokeNative("android:getQueue", options),
  /**
   * 向插件提供既有状态格式
   * @returns 毫秒单位的播放状态
   */
  getStatus: (): PlaybackStatusSnapshot => {
    const value = getPlaybackSnapshot();
    return {
      state: value.state,
      positionMs: value.position,
      durationMs: value.duration,
      volume: value.volume,
      isFinished: value.isFinished,
      currentIndex: value.currentIndex,
      repeat: value.repeat,
      shuffle: value.shuffle,
    };
  },
  /** 恢复播放 */
  play: (): void => command("player:play"),
  /** 暂停播放 */
  pause: (): void => command("player:pause"),
  /** 停止播放 */
  stop: (): void => command("player:stop"),
  /** 播放下一曲 */
  next: (): void => command("android:next"),
  /** 播放上一曲 */
  prev: (): void => command("android:prev"),
  /**
   * 修改随机播放模式
   * @param mode - 随机开关
   */
  setShuffle: (mode: ShuffleMode): void => command("android:setShuffle", mode),
  /**
   * 修改循环播放模式
   * @param mode - 循环方式
   */
  setRepeat: (mode: RepeatMode): void => command("android:setRepeat", mode),
  /**
   * 播放指定曲目
   * @param track - 已校验的曲目信息
   */
  playTrack: (track: Track): void => command("android:playTrack", track),
  /**
   * 将插件提供的曲目加入权威队列
   * @param tracks - 已校验的曲目列表
   * @param position - 插入位置
   */
  addToQueue: (tracks: Track[], position: "next" | "end"): void =>
    command("android:addToQueue", tracks, position),
  /**
   * 跳转到指定位置
   * @param positionMs - 目标位置，单位为毫秒
   * @returns 原生跳转结果
   */
  seek: (positionMs: number): Promise<void> => invokeNative("player:seek", positionMs),
  /**
   * 设置应用播放音量
   * @param volume - 零至一的音量
   */
  setVolume: (volume: number): void => command("player:setVolume", volume),
  /**
   * 读取原生进度
   * @returns 播放位置，单位为毫秒
   */
  getPosition: (): number => getPlaybackSnapshot().position,
};
