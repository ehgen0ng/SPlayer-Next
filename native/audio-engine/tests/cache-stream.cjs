/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node.js 原生集成测试 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const engine = require("../audio-engine.node");

/**
 * 创建十二秒 WAV，但只将前六秒写入缓存
 * @param {import('node:test').TestContext} t - 测试清理上下文
 * @returns 音源、完整内容及临时路径
 */
function growingWav(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "splayer-growing-native-"));
  const partial = path.join(dir, "song.part");
  const final = path.join(dir, "song.bin");
  const size = 48000 * 4 * 12;
  const data = Buffer.alloc(44 + size);
  data.write("RIFF");
  data.writeUInt32LE(size + 36, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(2, 22);
  data.writeUInt32LE(48000, 24);
  data.writeUInt32LE(192000, 28);
  data.writeUInt16LE(4, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(size, 40);
  const available = 44 + size / 2;
  fs.writeFileSync(partial, data.subarray(0, available));
  const source = engine.registerCacheStream(
    randomUUID(),
    partial,
    final,
    "http://127.0.0.1:1/unused",
    data.length,
  );
  engine.updateCacheStream(source, available, false, false);
  t.after(() => {
    engine.updateCacheStream(source, available, false, true);
    engine.releaseCacheStream(source);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { partial, final, data, available, source };
}

test("半文件可解码并准备 PCM，完成后同一入口仍可读取", { timeout: 10000 }, async (t) => {
  const cached = growingWav(t);
  const player = new engine.AudioPlayer();
  t.after(() => player.stop());
  // 若实现错误地等到全部下载，超时会使测试失败且唤醒底层读取
  const timer = setTimeout(
    () => engine.updateCacheStream(cached.source, cached.available, false, true),
    4000,
  );
  t.after(() => clearTimeout(timer));
  const info = await engine.probeAudioSource(cached.source);
  assert.equal(info.duration, 12);
  assert.equal(fs.statSync(cached.partial).size, cached.available);
  assert.equal(await player.prepareNext("growing", cached.source), true);
  assert.equal(fs.statSync(cached.partial).size, cached.available);
  player.cancelPrepared("growing");
  fs.appendFileSync(cached.partial, cached.data.subarray(cached.available));
  fs.renameSync(cached.partial, cached.final);
  engine.updateCacheStream(cached.source, cached.data.length, true, false);
  const completed = await engine.probeAudioSource(cached.source);
  assert.equal(completed.duration, 12);
  player.stop();
});

test("预载等待读取时可以取消，后续预载仍能正常工作", { timeout: 10000 }, async (t) => {
  const cached = growingWav(t);
  const player = new engine.AudioPlayer();
  t.after(() => player.stop());
  engine.updateCacheStream(cached.source, 4, false, false);
  const waiting = player.prepareNext("cancel", cached.source).then(
    () => true,
    () => false,
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  player.cancelPrepared("cancel");
  await waiting;
  engine.updateCacheStream(cached.source, cached.available, false, false);
  assert.equal(await player.prepareNext("retry", cached.source), true);
  player.cancelPrepared("retry");
});

test("重复预载与取消只保留当前解码资源", { timeout: 15000 }, async (t) => {
  const cached = growingWav(t);
  const player = new engine.AudioPlayer();
  t.after(() => player.stop());
  let warmRss = 0;
  for (let i = 0; i < 25; i++) {
    const source = engine.registerCacheStream(
      randomUUID(),
      cached.partial,
      cached.final,
      "http://127.0.0.1:1/unused",
      cached.data.length,
    );
    engine.updateCacheStream(source, cached.available, false, false);
    assert.equal(await player.prepareNext(`memory-${i}`, source), true);
    player.cancelPrepared(`memory-${i}`);
    engine.releaseCacheStream(source);
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (i === 4) warmRss = process.memoryUsage().rss;
  }
  const finalRss = process.memoryUsage().rss;
  t.diagnostic(
    `原生预载 RSS：预热后 ${(warmRss / 1048576).toFixed(1)} MiB，继续 20 轮后 ${(finalRss / 1048576).toFixed(1)} MiB`,
  );
});
