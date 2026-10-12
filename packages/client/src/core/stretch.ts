/**
 * Playing speech faster (or slower) without changing its pitch: time-stretching by waveform-similarity
 * overlap-add (WSOLA), in plain code.
 *
 * Simply reading the samples out faster would raise the voice like a sped-up tape. Instead the signal
 * is cut into short windows (25 ms, Hann-shaped, overlapping by half) that are laid down in the output
 * at the normal spacing while being *taken* from the input at a spacing `speed` times wider: at 1.5×
 * every second window of input is, in effect, skipped. Dropping a window mid-wave would click, so each
 * window is not taken from exactly where the arithmetic says but from the spot within a few
 * milliseconds of it where the waveform best continues the window laid down before it (the highest
 * normalised cross-correlation). The pitch period is kept whole, the voice keeps its pitch, and the
 * words come sooner.
 *
 * The search for the best spot is done on a copy decimated to about 12 kHz and then refined at the
 * full rate, which makes an hour of 48 kHz speech take seconds rather than a minute.
 */
import { type Samples } from './pcm.js';

/** The window length and the search either side of the nominal position, in seconds. */
const WINDOW_SEC = 0.025;
const SEARCH_SEC = 0.0075;
/** The coarse search runs on a copy decimated to about this rate. */
const COARSE_RATE = 12000;
/** Speeds this close to 1 are left alone. */
const UNITY = 0.005;

/** Lowest and highest speed offered: slower than half or faster than three times is no longer speech. */
export const SPEED_MIN = 0.5;
export const SPEED_MAX = 3;

export function stretchedLength(samples: number, speed: number): number {
  return Math.max(0, Math.round(samples / speed));
}

/** `speed` > 1 makes the result shorter. Pitch and timbre are kept. */
export function stretchFloat(input: Float32Array, sampleRate: number, speed: number): Samples {
  if (Math.abs(speed - 1) < UNITY || input.length === 0) return Float32Array.from(input);
  const n = Math.max(4, Math.round(sampleRate * WINDOW_SEC) & ~1);
  const half = n / 2;
  const search = Math.max(1, Math.round(sampleRate * SEARCH_SEC));
  const decimate = Math.max(1, Math.floor(sampleRate / COARSE_RATE));
  const outLength = stretchedLength(input.length, speed);
  const out = new Float32Array(outLength + n);
  const window = new Float64Array(n);
  for (let i = 0; i < n; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  const coarse = decimate > 1 ? decimated(input, decimate) : input;

  // the first window is laid down as it is; every later one is placed so that it continues the last
  let prev = 0;
  const frames = Math.ceil(outLength / half);
  for (let k = 0; k < frames; k++) {
    const nominal = Math.round(k * half * speed);
    let chosen = nominal;
    if (k > 0) {
      // where the previous window would naturally continue: one output hop later in the input
      const target = prev + half;
      const lo = Math.max(0, nominal - search);
      const hi = Math.min(input.length - n, nominal + search);
      if (hi > lo) {
        const best = bestOffset(coarse, decimate, target, lo, hi, half);
        chosen = refine(
          input,
          target,
          best,
          Math.max(lo, best - decimate),
          Math.min(hi, best + decimate),
          half,
        );
      }
    }
    const at = k * half;
    for (let i = 0; i < n; i++) {
      const x = input[chosen + i] ?? 0;
      out[at + i] = (out[at + i] ?? 0) + x * (window[i] ?? 0);
    }
    prev = chosen;
  }
  // the first half window is under one window only: scale it back up so the start is not faded
  for (let i = 0; i < half && i < outLength; i++) {
    const w = window[i] ?? 1;
    if (w > 1e-3) out[i] = (out[i] ?? 0) / Math.max(w, 0.25);
  }
  return out.slice(0, outLength);
}

/** Int16 in, Int16 out; the way phrases are stored. */
export function stretchPcm(pcm: Int16Array, sampleRate: number, speed: number): Int16Array {
  if (Math.abs(speed - 1) < UNITY) return pcm;
  const floats = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) floats[i] = (pcm[i] ?? 0) / 32768;
  const stretched = stretchFloat(floats, sampleRate, speed);
  const out = new Int16Array(stretched.length);
  for (let i = 0; i < out.length; i++) {
    const v = Math.max(-1, Math.min(1, stretched[i] ?? 0));
    out[i] = Math.round(v < 0 ? v * 32768 : v * 32767);
  }
  return out;
}

/** A box-averaged copy at one sample per `factor`, enough to find where a waveform matches. */
function decimated(input: Float32Array, factor: number): Float32Array {
  const out = new Float32Array(Math.ceil(input.length / factor));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let j = 0; j < factor; j++) sum += input[i * factor + j] ?? 0;
    out[i] = sum / factor;
  }
  return out;
}

/**
 * The candidate start in `[lo, hi]` (full-rate sample positions, tried at `decimate` steps on the
 * coarse copy) whose first `overlap` samples best match the input at `target`.
 */
function bestOffset(
  coarse: Float32Array,
  decimate: number,
  target: number,
  lo: number,
  hi: number,
  overlap: number,
): number {
  const t0 = Math.round(target / decimate);
  const len = Math.max(1, Math.round(overlap / decimate));
  let tt = 0;
  for (let i = 0; i < len; i++) tt += (coarse[t0 + i] ?? 0) ** 2;
  let best = -Infinity;
  let bestPos = Math.round((lo + hi) / 2);
  for (let pos = lo; pos <= hi; pos += decimate) {
    const c0 = Math.round(pos / decimate);
    let xy = 0;
    let xx = 0;
    for (let i = 0; i < len; i++) {
      const x = coarse[c0 + i] ?? 0;
      xy += x * (coarse[t0 + i] ?? 0);
      xx += x * x;
    }
    const score = xy / (Math.sqrt(xx * tt) + 1e-9);
    if (score > best) {
      best = score;
      bestPos = pos;
    }
  }
  return bestPos;
}

/** The same match at the full rate, over the few positions around the coarse winner. */
function refine(
  input: Float32Array,
  target: number,
  around: number,
  lo: number,
  hi: number,
  overlap: number,
): number {
  let tt = 0;
  for (let i = 0; i < overlap; i++) tt += (input[target + i] ?? 0) ** 2;
  let best = -Infinity;
  let bestPos = around;
  for (let pos = lo; pos <= hi; pos++) {
    let xy = 0;
    let xx = 0;
    for (let i = 0; i < overlap; i++) {
      const x = input[pos + i] ?? 0;
      xy += x * (input[target + i] ?? 0);
      xx += x * x;
    }
    const score = xy / (Math.sqrt(xx * tt) + 1e-9);
    if (score > best) {
      best = score;
      bestPos = pos;
    }
  }
  return bestPos;
}
