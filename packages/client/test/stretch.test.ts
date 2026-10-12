/**
 * The time-stretch: the result has the length the speed says, the pitch of a voice does not move,
 * nothing clips, and a speed of 1 changes nothing.
 */
import { describe, expect, it } from 'vitest';

import { stretchedLength, stretchFloat, stretchPcm } from '../src/core/stretch.js';

import { RATE, readWav, rms, toFloat, VOICE_URL } from './signals.js';

/** A voice-like tone: a 150 Hz pulse train through a couple of resonances, 2 s at 48 kHz. */
function vowel(rate: number, seconds: number, f0 = 150): Float32Array {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  const period = rate / f0;
  // harmonics up to 3 kHz with a 1/k roll-off, a vowel's rough shape
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 1; k * f0 < 3000; k++) v += Math.sin((2 * Math.PI * k * i) / period) / k;
    out[i] = 0.3 * v;
  }
  return out;
}

/** The lag of the strongest autocorrelation peak in the pitch range, as a frequency. */
function pitchOf(x: Float32Array, rate: number): number {
  const from = Math.round(rate / 400);
  const to = Math.round(rate / 70);
  let best = -Infinity;
  let bestLag = from;
  const n = Math.min(x.length, rate);
  for (let lag = from; lag <= to; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += (x[i] ?? 0) * (x[i + lag] ?? 0);
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  return rate / bestLag;
}

describe('stretchFloat', () => {
  it('leaves a speed of 1 alone', () => {
    const x = vowel(48000, 0.5);
    expect(stretchFloat(x, 48000, 1)).toEqual(Float32Array.from(x));
    expect(stretchedLength(1000, 1)).toBe(1000);
  });

  it.each([1.25, 1.5, 2, 0.75])('gives the length the speed says at %s×', (speed) => {
    const x = vowel(48000, 2);
    const y = stretchFloat(x, 48000, speed);
    expect(y.length).toBe(stretchedLength(x.length, speed));
    expect(Math.abs(y.length - x.length / speed)).toBeLessThanOrEqual(1);
  });

  it.each([1.25, 1.5, 2])('keeps the pitch of a voice-like tone at %s×', (speed) => {
    const x = vowel(48000, 2);
    const y = stretchFloat(x, 48000, speed);
    expect(pitchOf(y, 48000)).toBeCloseTo(150, 0);
    // and the level: no gaps, no doubling
    expect(rms(y) / rms(x)).toBeGreaterThan(0.85);
    expect(rms(y) / rms(x)).toBeLessThan(1.15);
    let peak = 0;
    for (const v of y) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThan(1);
  });

  it('works at the detector rate and on real speech', () => {
    const voice = toFloat(readWav(VOICE_URL));
    const faster = stretchFloat(voice, RATE, 1.5);
    expect(Math.abs(faster.length - voice.length / 1.5)).toBeLessThanOrEqual(1);
    expect(rms(faster) / rms(voice)).toBeGreaterThan(0.8);
    expect(rms(faster) / rms(voice)).toBeLessThan(1.25);
    const slower = stretchFloat(voice, RATE, 0.8);
    expect(Math.abs(slower.length - voice.length / 0.8)).toBeLessThanOrEqual(1);
  });

  it('handles the edges: empty input and input shorter than a window', () => {
    expect(stretchFloat(new Float32Array(0), 48000, 1.5)).toHaveLength(0);
    const tiny = stretchFloat(vowel(48000, 0.01), 48000, 1.5);
    expect(tiny.length).toBe(stretchedLength(480, 1.5));
  });
});

describe('stretchPcm', () => {
  it('returns the same samples at speed 1 and Int16 at other speeds', () => {
    const pcm = readWav(VOICE_URL);
    expect(stretchPcm(pcm, RATE, 1)).toBe(pcm);
    const out = stretchPcm(pcm, RATE, 1.5);
    expect(out).toBeInstanceOf(Int16Array);
    expect(Math.abs(out.length - pcm.length / 1.5)).toBeLessThanOrEqual(1);
  });
});
