import { describe, expect, it } from 'vitest';

import { formatEta, StageEta, WindowedRate } from '../src/index.js';

/**
 * Plays an export through an estimator: `warmupSec` of nothing, then steady work at `speed` times
 * real time on `videoSec` of video, reporting every `stepSec`. Returns every estimate made.
 */
function simulate(
  eta: StageEta,
  input: { videoSec: number; speed: number; warmupSec: number; stepSec?: number },
): { t: number; f: number; seconds: number | null; basis: string | null }[] {
  const out: { t: number; f: number; seconds: number | null; basis: string | null }[] = [];
  const step = input.stepSec ?? 0.25;
  const workSec = input.videoSec / input.speed;
  const total = input.warmupSec + workSec;
  for (let t = 0; t <= total + 1e-9; t += step) {
    const f = t <= input.warmupSec ? 0 : Math.min(1, (t - input.warmupSec) / workSec);
    const e = eta.update(t, f);
    out.push({ t, f, seconds: e.seconds, basis: e.basis });
  }
  return out;
}

describe('StageEta', () => {
  it('never opens with hours when a one-hour lecture takes two seconds to warm up', () => {
    // The old estimate here was (3600 - 1) / (1 / 2.25) ≈ 2 h 15 min at the first report.
    const eta = new StageEta(180);
    const run = simulate(eta, { videoSec: 3600, speed: 20, warmupSec: 2 });
    const truth = (t: number) => Math.max(0, 2 + 180 - t);
    for (const r of run) {
      if (r.seconds === null) continue;
      expect(r.seconds, `at ${r.t}s`).toBeLessThanOrEqual(2 * 180);
      expect(r.seconds, `at ${r.t}s`).toBeLessThanOrEqual(truth(r.t) * 1.6 + 10);
    }
    const first = run.find((r) => r.seconds !== null);
    expect(first?.basis).toBe('model');
    expect(first?.seconds).toBeCloseTo(180, 0);
    const last = run[run.length - 1];
    expect(last?.seconds).toBeLessThanOrEqual(2);
  });

  it('converges to the measured rate even when the model was far off', () => {
    // The plan said 20 s; the machine is five times slower than that.
    const eta = new StageEta(20);
    const run = simulate(eta, { videoSec: 600, speed: 6, warmupSec: 1 });
    const truth = (t: number) => Math.max(0, 1 + 100 - t);
    const settled = run.filter((r) => r.basis === 'measured');
    expect(settled.length).toBeGreaterThan(0);
    for (const r of settled) {
      expect(r.seconds, `at ${r.t}s`).toBeGreaterThan(truth(r.t) * 0.7 - 2);
      expect(r.seconds, `at ${r.t}s`).toBeLessThan(truth(r.t) * 1.3 + 2);
    }
    // The hand-over from model to measurement happens by a tenth of the work, not at the end.
    const firstMeasured = settled[0];
    expect(firstMeasured?.f).toBeLessThan(0.15);
  });

  it('uses the model alone until a little work has been measured', () => {
    const eta = new StageEta(60);
    expect(eta.update(0, 0)).toEqual({ seconds: 60, basis: 'model' });
    expect(eta.update(1, 0)).toEqual({ seconds: 60, basis: 'model' });
    const e = eta.update(1.5, 0.01);
    expect(e.basis).toBe('model');
    expect(e.seconds).toBeCloseTo(59.4, 1);
  });

  it('says nothing without a model until there is a measurement, then measures', () => {
    const eta = new StageEta(null);
    expect(eta.update(0, 0)).toEqual({ seconds: null, basis: null });
    expect(eta.update(1, 0.01)).toEqual({ seconds: null, basis: null });
    const e = eta.update(4, 0.1);
    expect(e.basis).toBe('measured');
    // 0.09 of the work in 3 s → 0.9 left takes 30 s
    expect(e.seconds).toBeCloseTo(30, 0);
  });

  it('counts down between updates and never goes below zero', () => {
    const eta = new StageEta(30);
    eta.update(0, 0);
    expect(eta.current(10).seconds).toBe(20);
    expect(eta.current(100).seconds).toBe(0);
  });

  it('follows a slowdown slowly and a speed-up quickly', () => {
    const eta = new StageEta(null, { minElapsedSec: 0 });
    // steady: 1 % per second
    for (let t = 0; t <= 20; t++) eta.update(t, t / 100);
    const steady = eta.current(20).seconds ?? 0;
    expect(steady).toBeGreaterThan(70);
    expect(steady).toBeLessThan(90);
    // suddenly five times slower
    const slow = eta.update(21, 0.202).seconds ?? 0;
    expect(slow).toBeGreaterThan(steady - 2);
    expect(slow).toBeLessThan(steady + 0.15 * 400);
    // now five times faster than the original
    let fast = 0;
    for (let t = 22; t <= 30; t++) fast = eta.update(t, 0.202 + (t - 21) * 0.05).seconds ?? 0;
    expect(fast).toBeLessThan(steady);
  });

  it('is unmoved by a stall in the sampled window until the window has moved on', () => {
    const eta = new StageEta(null, { windowSec: 4, minElapsedSec: 0 });
    for (let t = 0; t <= 10; t++) eta.update(t, t / 50);
    const before = eta.update(10.5, 0.21).seconds ?? 0;
    // nothing for two seconds: the figure keeps counting down, no jump
    const during = eta.current(12.5).seconds ?? 0;
    expect(during).toBeCloseTo(before - 2, 5);
  });
});

describe('WindowedRate', () => {
  it('measures over the window only', () => {
    const r = new WindowedRate(2);
    r.add(0, 0);
    expect(r.rate()).toBeNull();
    r.add(1, 100);
    expect(r.rate()).toBe(100);
    r.add(2, 200);
    r.add(3, 200);
    r.add(4, 200);
    // the window now holds t=2..4: nothing moved
    expect(r.rate()).toBe(0);
    r.reset();
    expect(r.rate()).toBeNull();
  });
});

describe('formatEta', () => {
  it('rounds more coarsely the further away', () => {
    expect(formatEta(3)).toBe('a few seconds');
    expect(formatEta(23)).toBe('25 s');
    expect(formatEta(59)).toBe('1 min');
    expect(formatEta(95)).toBe('1 min 40 s');
    expect(formatEta(240)).toBe('4 min');
    expect(formatEta(599)).toBe('10 min');
    expect(formatEta(1500)).toBe('25 min');
    expect(formatEta(3600)).toBe('1 h');
    expect(formatEta(7500)).toBe('2 h 5 min');
    expect(formatEta(7190)).toBe('2 h');
  });
});
