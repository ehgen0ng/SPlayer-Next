import { describe, expect, it } from "vitest";
import type { AudioQuality } from "@shared/types/player";
import { compareAudioQuality, getQualityLabel, getQualityLevel } from "./quality";

const lossless: AudioQuality = {
  codec: "flac",
  sampleRate: 44100,
  bitsPerSample: 16,
  channels: 2,
  bitRate: 947000,
};

describe("按源文件位深判定 Hi-Res", () => {
  it.each([44100, 48000, 88200, 96000, 192000])(
    "24-bit / %i Hz 无损文件显示 Hi-Res，不受 96 kHz 门槛限制",
    (sampleRate) => {
      const quality = { ...lossless, sampleRate, bitsPerSample: 24 };
      expect(getQualityLevel(quality)).toBe("hi-res");
      expect(getQualityLabel(quality)).toBe("Hi-Res");
    },
  );

  it("16-bit / 44.1 kHz 高码率六声道仍是普通无损", () => {
    expect(getQualityLevel({ ...lossless, channels: 6, bitRate: 2334000 })).toBe("lossless");
  });

  it("高采样率不能将 16-bit 文件提升为 Hi-Res", () => {
    expect(getQualityLevel({ ...lossless, sampleRate: 192000 })).toBe("lossless");
  });

  it("有损编码的输出位深不作为 Hi-Res 依据", () => {
    expect(getQualityLevel({ ...lossless, codec: "aac", bitsPerSample: 32, bitRate: 320000 })).toBe(
      "hq",
    );
  });

  it("无损文件位深未知时保持普通无损", () => {
    expect(getQualityLevel({ ...lossless, bitsPerSample: 0 })).toBe("lossless");
  });

  it("24-bit / 48 kHz 的候选优先于码率更高的 16-bit 六声道文件", () => {
    expect(
      compareAudioQuality(
        { ...lossless, sampleRate: 48000, bitsPerSample: 24, bitRate: 1546000 },
        { ...lossless, channels: 6, bitRate: 2334000 },
      ),
    ).toBeGreaterThan(0);
  });
});
