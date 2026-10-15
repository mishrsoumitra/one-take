import { describe, expect, it } from 'vitest';

import { BlockClock } from '../src/core/block-clock.js';

const BLOCK = 10;

/** Delivers blocks on `schedule` (wall ms per block, in order) and returns the clock. */
function delivered(schedule: readonly number[]): BlockClock {
  const clock = new BlockClock(BLOCK);
  schedule.forEach((at, i) => clock.tick(i + 1, at));
  return clock;
}

describe('BlockClock', () => {
  it('knows nothing before the first block', () => {
    expect(new BlockClock(BLOCK).at(123)).toBeNull();
  });

  it('reads wall time against the origin when blocks come on time', () => {
    const clock = delivered(Array.from({ length: 200 }, (_, i) => (i + 1) * BLOCK + 3));
    // every block arrived 3 ms after it ended, so block 0 began at wall time 3
    expect(clock.at(2000)).toBeCloseTo(1997, 6);
    expect(clock.at(2027)).toBeCloseTo(2024, 6);
    expect(clock.latestMs).toBe(2000);
  });

  it('keeps frames apart through a hold-up in block delivery', () => {
    // blocks on time until 1000 ms, then nothing until 1200 ms, when 20 blocks arrive together
    const schedule = Array.from({ length: 100 }, (_, i) => (i + 1) * BLOCK);
    for (let i = 0; i < 20; i++) schedule.push(1200);
    const clock = delivered(schedule);
    // two frames 50 ms apart during the hold-up get stamps 50 ms apart, not the same one
    const before = new BlockClock(BLOCK);
    schedule.slice(0, 100).forEach((at, i) => before.tick(i + 1, at));
    const a = before.at(1027);
    const b = before.at(1077);
    expect(a).toBeCloseTo(1027, 6);
    expect(b).toBeCloseTo(1077, 6);
    // and once the held blocks land, time has not jumped backwards or forwards
    expect(clock.at(1210)).toBeCloseTo(1210, 6);
    expect(clock.latestMs).toBe(1200);
  });

  it('follows a slow drift between the two clocks', () => {
    // the audio thread runs half a percent slow: blocks come every 10.05 ms of wall time
    const schedule = Array.from({ length: 2000 }, (_, i) => (i + 1) * 10.05);
    const clock = delivered(schedule);
    const now = 2000 * 10.05 + 4;
    const truth = 2000 * BLOCK + 4 / 1.005;
    // within a window or two the origin has caught up; the stamp is ahead of the truth by at most ten ms
    const read = clock.at(now) ?? 0;
    expect(read - truth).toBeGreaterThan(-1);
    expect(read - truth).toBeLessThan(15);
  });

  it('is not fooled by late blocks, only by early ones (which cannot happen)', () => {
    const schedule = Array.from({ length: 300 }, (_, i) => (i + 1) * BLOCK + (i % 7) * 4);
    const clock = delivered(schedule);
    // the least-late blocks (every seventh, 0 ms late) set the origin
    expect(clock.at(3000)).toBeCloseTo(3000, 6);
  });

  it('never runs more than a window ahead of the audio', () => {
    const clock = delivered(Array.from({ length: 100 }, (_, i) => (i + 1) * BLOCK));
    expect(clock.at(5000)).toBe(1000 + 1000);
  });
});
