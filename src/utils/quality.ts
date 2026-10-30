import type { AudioQuality } from "@shared/types/player";

/** 音质等级 */
export type QualityLevel = "hi-res" | "lossless" | "hq" | "sq" | "lq";

/** 从低到高的音质顺序，播放与下载共用 */
export const QUALITY_ORDER: readonly QualityLevel[] = ["lq", "sq", "hq", "lossless", "hi-res"];

/** 无损编解码器 */
const LOSSLESS_CODECS = new Set(["flac", "alac", "ape", "wav", "aiff", "wavpack", "tta"]);

/**
 * 判断编解码器是否为无损格式
 * @param codec - 编解码器名称
 * @returns 是否为无损格式
 */
export const isLosslessCodec = (codec: string): boolean => LOSSLESS_CODECS.has(codec.toLowerCase());

/** 等级短码文案 */
export const QUALITY_LABELS: Record<QualityLevel, string> = {
  "hi-res": "Hi-Res",
  lossless: "Lossless",
  hq: "HQ",
  sq: "SQ",
  lq: "LQ",
};

/** 等级完整文案 */
const QUALITY_FULL_LABELS: Record<QualityLevel, string> = {
  "hi-res": "Hi-Res",
  lossless: "Lossless",
  hq: "High Quality",
  sq: "Standard Quality",
  lq: "Low Quality",
};

/**
 * 判断音质等级；信息不全时回落到 LQ
 * @param quality - AudioQuality；undefined / 无 codec 时按最低档处理
 * @returns 音质等级
 */
export const getQualityLevel = (quality: AudioQuality | undefined): QualityLevel => {
  if (!quality || !quality.codec || quality.codec === "unknown") return "lq";
  const isLossless = isLosslessCodec(quality.codec);
  if (isLossless) {
    if (quality.sampleRate >= 96000 && quality.bitsPerSample >= 24) return "hi-res";
    return "lossless";
  }
  const kbps = quality.bitRate / 1000;
  if (kbps >= 320) return "hq";
  if (kbps >= 192) return "sq";
  return "lq";
};

/**
 * 先比较真实音质档位，再比较总码率；未知码率排在末尾
 * @param left - 待比较候选
 * @param right - 已保留候选
 * @returns 正数表示左侧更优，零表示保留原顺序
 */
export const compareAudioQuality = (left: AudioQuality, right: AudioQuality): number =>
  QUALITY_ORDER.indexOf(getQualityLevel(left)) - QUALITY_ORDER.indexOf(getQualityLevel(right)) ||
  Math.max(0, left.bitRate || 0) - Math.max(0, right.bitRate || 0);

/**
 * 取音质等级短码文案
 * @param quality - 音质信息；缺少信息时使用默认 LQ
 * @returns 短码文案（LQ / SQ / HQ / Lossless / Hi-Res）
 */
export const getQualityLabel = (quality: AudioQuality | undefined): string =>
  QUALITY_LABELS[getQualityLevel(quality)];

/**
 * 取音质等级完整文案
 * @param quality - 音质信息；缺少信息时使用默认 Low Quality
 * @returns 完整文案（Low Quality / Standard Quality / High Quality / Lossless / Hi-Res）
 */
export const getQualityFullLabel = (quality: AudioQuality | undefined): string =>
  QUALITY_FULL_LABELS[getQualityLevel(quality)];

/** 是否为无损级别（hi-res 或 lossless） */
export const isLosslessQuality = (quality: AudioQuality | undefined): boolean => {
  const level = getQualityLevel(quality);
  return level === "hi-res" || level === "lossless";
};
