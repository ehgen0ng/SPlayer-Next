const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { probeAudioSource } = require("../audio-engine.node");

for (const [sampleRate, bits, channels] of [
  [96000, 24, 2],
  [44100, 16, 6],
]) {
  test(`独立探测 ${sampleRate} Hz / ${bits} bit / ${channels} 声道`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "splayer-probe-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const stride = (bits / 8) * channels;
    const dataSize = sampleRate * stride;
    const wav = Buffer.alloc(44 + dataSize);
    wav.write("RIFF");
    wav.writeUInt32LE(36 + dataSize, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(channels, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(dataSize, 28);
    wav.writeUInt16LE(stride, 32);
    wav.writeUInt16LE(bits, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(dataSize, 40);
    const file = path.join(dir, "source.wav");
    fs.writeFileSync(file, wav);
    const info = await probeAudioSource(file);
    assert.equal(info.originalSampleRate, sampleRate);
    assert.equal(info.bitsPerSample, bits);
    assert.equal(info.channels, channels);
    assert.equal(info.duration, 1);
    assert.ok(info.bitRate > 0);
  });
}
