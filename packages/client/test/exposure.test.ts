import { describe, expect, it } from 'vitest';

import {
  applyLut,
  buildLut,
  followCorrection,
  isIdentity,
  measureTone,
  NO_CORRECTION,
  planCorrection,
} from '../src/core/exposure.js';

/** A frame of `n` pixels, each from `pixel(i)`. */
function frame(n: number, pixel: (i: number) => [number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const [r, g, b] = pixel(i);
    data.set([r, g, b, 255], i * 4);
  }
  return data;
}

const luma = (data: Uint8ClampedArray) => {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4)
    sum += 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0);
  return sum / (data.length / 4) / 255;
};

describe('measureTone', () => {
  it('reads the mean, the dark and bright percentiles and the channel means', () => {
    const data = frame(1000, (i) => [i % 256, i % 256, i % 256]);
    const m = measureTone(data, 1);
    expect(m.mean).toBeCloseTo(0.5, 1);
    expect(m.low).toBeLessThan(0.05);
    expect(m.high).toBeGreaterThan(0.95);
    expect(m.r).toBeCloseTo(m.g, 5);
  });

  it('copes with an empty frame', () => {
    expect(measureTone(new Uint8ClampedArray(0)).mean).toBe(0.5);
  });
});

describe('planCorrection', () => {
  it('lifts a dark, flat frame and leaves a good one alone', () => {
    const dark = frame(4000, (i) => [20 + (i % 60), 20 + (i % 60), 20 + (i % 60)]);
    const c = planCorrection(measureTone(dark, 1));
    const lifted = dark.slice();
    applyLut(lifted, buildLut(c));
    expect(luma(lifted)).toBeGreaterThan(luma(dark) * 2);
    expect(c.gamma).toBeLessThanOrEqual(1);
    const good = frame(4000, (i) => {
      const v = 8 + ((i * 7919) % 240);
      return [v, v, v];
    });
    const same = planCorrection(measureTone(good, 1));
    expect(isIdentity(same) || (Math.abs(same.gamma - 1) < 0.2 && same.white - same.black > 0.85)).toBe(true);
  });

  it('takes a blue cast out, within limits', () => {
    const blue = frame(2000, (i) => [90 + (i % 20), 100 + (i % 20), 120 + (i % 20)]);
    const c = planCorrection(measureTone(blue, 1));
    expect(c.gainR).toBeGreaterThan(1);
    expect(c.gainB).toBeLessThan(1);
    const fixed = blue.slice();
    applyLut(fixed, buildLut(c));
    const m = measureTone(fixed, 1);
    expect(Math.abs(m.r - m.g)).toBeLessThan(0.03);
    expect(Math.abs(m.b - m.g)).toBeLessThan(0.03);
    // a strong cast is only partly corrected: the gains stop at their limits
    const strong = frame(2000, () => [40, 100, 250]);
    const limited = planCorrection(measureTone(strong, 1));
    expect(limited.gainR).toBe(1.35);
    expect(limited.gainB).toBe(0.75);
  });

  it('never stretches more than two to one', () => {
    const flat = frame(2000, (i) => [120 + (i % 10), 120 + (i % 10), 120 + (i % 10)]);
    const c = planCorrection(measureTone(flat, 1));
    expect(c.white - c.black).toBeGreaterThanOrEqual(0.47 - 1e-6);
  });

  it('can be asked for exposure or colour alone', () => {
    const blueDark = frame(2000, () => [20, 30, 60]);
    const m = measureTone(blueDark, 1);
    const onlyColour = planCorrection(m, { exposure: false });
    expect(onlyColour.gamma).toBe(1);
    expect(onlyColour.gainR).not.toBe(1);
    const onlyExposure = planCorrection(m, { colour: false });
    expect(onlyExposure.gainR).toBe(1);
    expect(onlyExposure.gamma).not.toBe(1);
  });
});

describe('the lookup table', () => {
  it('is monotonic and spans the range', () => {
    const lut = buildLut({ gainR: 1.2, gainB: 0.8, black: 0.1, white: 0.9, gamma: 0.8 });
    for (const table of [lut.r, lut.g, lut.b]) {
      for (let v = 1; v < 256; v++) expect(table[v] ?? 0).toBeGreaterThanOrEqual(table[v - 1] ?? 0);
      expect(table[0]).toBe(0);
    }
    expect(lut.g[255]).toBe(255);
    expect(lut.b[255]).toBeLessThan(255);
  });

  it('leaves pixels alone with no correction', () => {
    const data = frame(100, (i) => [i, 255 - i, i * 2]);
    const before = data.slice();
    applyLut(data, buildLut(NO_CORRECTION));
    expect(data).toEqual(before);
    expect(isIdentity(NO_CORRECTION)).toBe(true);
  });
});

describe('followCorrection', () => {
  it('moves part of the way each frame and settles', () => {
    const target = { gainR: 1.2, gainB: 0.9, black: 0.1, white: 0.95, gamma: 0.8 };
    let c = followCorrection(null, NO_CORRECTION);
    for (let i = 0; i < 100; i++) c = followCorrection(c, target);
    expect(c.gamma).toBeCloseTo(0.8, 2);
    expect(c.gainR).toBeCloseTo(1.2, 2);
    const one = followCorrection(NO_CORRECTION, target, 0.5);
    expect(one.black).toBeCloseTo(0.05);
  });
});
