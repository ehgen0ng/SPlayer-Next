import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlayStatsRecorder } from "../../../shared/utils/playStats";
import type { PlayEventInput } from "../../../shared/types/stats";
import type { Track } from "../../../shared/types/player";

test("播放统计扣除暂停和缓冲，后台长间隔无需进度计时器", () => {
  let time = 1000;
  const events: PlayEventInput[] = [];
  const stats = createPlayStatsRecorder(
    (event) => events.push(event),
    () => time,
  );
  const track = { id: "a", source: "netease" } as Track;
  stats.update(track, true);
  time += 3000;
  stats.update(track, false);
  time += 60_000;
  stats.update(track, true);
  time += 10_000;
  stats.update({ ...track, id: "b" }, false);
  assert.deepEqual(events, [{ track, startedAt: 1000, listenedMs: 13_000 }]);
});

test("单曲循环独立结算，短试听不入库，暂停后结束不补算时长", () => {
  let time = 0;
  const events: PlayEventInput[] = [];
  const stats = createPlayStatsRecorder(
    (event) => events.push(event),
    () => time,
  );
  const track = { id: "a", source: "qqmusic" } as Track;
  stats.update(track, true);
  time = 4000;
  stats.ended(true);
  time = 10_000;
  stats.ended(true);
  time = 17_000;
  stats.update(track, false);
  time = 30_000;
  stats.finalize();
  assert.deepEqual(
    events.map(({ listenedMs }) => listenedMs),
    [6000, 7000],
  );
});
