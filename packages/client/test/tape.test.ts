import { describe, expect, it } from 'vitest';

import { bestLag, loudestWindow, rawRange, takeRaw, Tape } from '../src/core/tape.js';

const RATE = 48000;
const BLOCK = 480;

/** A voice-like signal: a few harmonics with a slow wobble, so correlation has something to lock onto. */
function voice(samples: number, seed = 1): Float32Array {
  const out = new Float32Array(samples);
  let s = seed;
  const random = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const f0 = 110 + random() * 60;
  for (let i = 0; i < samples; i++) {
    const t = i / RATE;
    const wobble = 1 + 0.03 * Math.sin(2 * Math.PI * 4.5 * t);
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f0 * h * wobble * t + h) / h;
    out[i] = 0.2 * v * (0.6 + 0.4 * Math.sin(2 * Math.PI * 2.3 * t));
  }
  return out;
}

function tapeOf(samples: Float32Array): Tape {
  const tape = new Tape(BLOCK);
  for (let at = 0; at + BLOCK <= samples.length; at += BLOCK) tape.push(samples.slice(at, at + BLOCK));
  return tape;
}

describe('Tape', () => {
  it('reads any stretch back, zeros outside what it holds, and prunes from the front', () => {
    const source = voice(BLOCK * 20);
    const tape = tapeOf(source);
    expect(tape.seen).toBe(20);
    const stretch = tape.read(1000, 3000);
    for (let i = 0; i < 2000; i++) expect(stretch[i]).toBe(source[1000 + i]);
    const before = tape.read(-100, 100);
    expect(before.subarray(0, 100).every((v) => v === 0)).toBe(true);
    expect(before[100]).toBe(source[0]);
    tape.prune(18 + 16 + 1); // keep from block 35: with 16 blocks of slack, blocks 0..18 go
    expect(tape.held).toBe(1);
    expect(tape.read(0, BLOCK).every((v) => v === 0)).toBe(true);
    expect(tape.read(19 * BLOCK, 20 * BLOCK)[5]).toBe(source[19 * BLOCK + 5]);
    tape.prune(0);
    expect(tape.held).toBe(1);
  });

  it('maps filtered blocks to the tape by the filter delay', () => {
    expect(rawRange({ from: 10, to: 12 }, BLOCK, 1952)).toEqual({ from: 10 * BLOCK - 1952, to: 12 * BLOCK - 1952 });
  });
});

describe('bestLag', () => {
  it('finds where a delayed copy sits, to the sample, even through a changed level and added noise', () => {
    const source = voice(RATE * 3);
    const delay = 1952;
    // the "filtered" phrase: the source from `delay` on, quieter, with a little noise
    const n = RATE * 2;
    const filtered = new Float32Array(n);
    for (let i = 0; i < n; i++) filtered[i] = 0.5 * (source[i + delay] ?? 0) + 0.01 * Math.sin(i * 12.9898);
    const maxShift = 2400;
    const nominalFrom = delay;
    const around = source.slice(nominalFrom - maxShift, nominalFrom + n + maxShift);
    expect(bestLag(filtered, around, RATE, maxShift)).toEqual({ lag: 0, peak: expect.closeTo(1, 1) });
    // the nominal delay was 10 ms off: the lag says by how much
    const off = source.slice(nominalFrom - 480 - maxShift, nominalFrom - 480 + n + maxShift);
    const lag = bestLag(filtered, off, RATE, maxShift);
    expect(lag.lag).toBe(480);
    expect(lag.peak).toBeGreaterThan(0.9);
  });

  it('says nothing matched over silence', () => {
    const silence = new Float32Array(RATE);
    expect(bestLag(silence, new Float32Array(RATE + 4800), RATE, 2400).peak).toBe(0);
  });

  it('picks the loudest stretch to correlate', () => {
    const quietThenLoud = new Float32Array(RATE);
    for (let i = RATE / 2; i < RATE; i++) quietThenLoud[i] = 0.5;
    expect(loudestWindow(quietThenLoud, RATE / 4)).toBeGreaterThanOrEqual(RATE / 2 - RATE / 32);
  });
});

describe('takeRaw', () => {
  it('cuts the raw stretch for a phrase, nudged to where it matches', () => {
    const source = voice(RATE * 4, 7);
    const tape = tapeOf(source);
    const delay = 1024;
    // the phrase: filtered blocks 100..300 are the source delayed by 1024 samples, at half level
    const blocks = { from: 100, to: 300 };
    const filtered = new Float32Array((blocks.to - blocks.from) * BLOCK);
    for (let i = 0; i < filtered.length; i++) filtered[i] = 0.5 * (source[blocks.from * BLOCK + i - delay] ?? 0);
    const exact = takeRaw(tape, filtered, blocks, delay, 2400, RATE);
    expect(exact.lag.lag).toBe(0);
    expect(exact.samples.length).toBe(filtered.length);
    expect(exact.samples[1000]).toBe(source[blocks.from * BLOCK + 1000 - delay]);
    // with the wrong nominal delay (the filter changed), the correlation still lands on the right samples
    const nudged = takeRaw(tape, filtered, blocks, delay - 928, 2400, RATE);
    expect(nudged.lag.lag).toBe(-928);
    expect(nudged.samples[1000]).toBe(source[blocks.from * BLOCK + 1000 - delay]);
  });
});
