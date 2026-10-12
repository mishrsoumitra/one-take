/**
 * Finding filler words ("um", "uh", "er", "hmm") in a recorded phrase, by arithmetic alone: no model,
 * nothing trained, every number here is a rule that can be read and argued with.
 *
 * A filler is not recognised as a word; it is recognised by its shape, which is much the same in
 * every speaker and every language that has them:
 *
 * 1. **It stands apart.** A filler is a hesitation: there is a real pause, a quarter of a second or
 *    so, on at least one side of it, usually both. The same vowel inside a word is glued to its
 *    neighbours; the brief silence before a "p" or a "t" is far shorter than a hesitation.
 * 2. **One long, steady sound.** "Uh" is a neutral vowel held for a quarter of a second or more
 *    without the mouth moving: the spectrum of each 32 ms frame (its Fourier transform, read in
 *    twenty bands spaced like the ear hears them) hardly changes over 48 ms, where a real word's
 *    spectrum moves with every consonant and every vowel change.
 * 3. **The vowel is the central one** of "but" and "the": its first two formants, the resonances of
 *    the vocal tract that the spectrum's envelope peaks at, sit near 600 and 1200 Hz. That is the
 *    "pattern of a common filler" in the transform: the vowels of "see", "say" and "saw" peak
 *    elsewhere. An "um" or "hmm" ends in a nasal murmur whose energy is nearly all under 500 Hz;
 *    that tail is part of the same voiced run and is cut with it.
 * 4. **The pitch glides, it does not sing.** A filler holds one note or drifts down smoothly; a run
 *    of syllables carries the sentence's melody, up and down. The pitch is the lag at which the low
 *    band of the frame best repeats itself (the autocorrelation, computed through the spectrum).
 *
 * Each voiced run of the right length gets a score from 0 to 1 that is the product of those things;
 * the sensitivity picks the score a run needs to count. What is cut is the run plus most of the
 * pause on either side, so what is left sounds like one ordinary pause.
 */
import { fft } from './fft.js';
import { Downsampler } from './speech.js';

export const FILLER_RATE = 16000;
/** New samples per frame (16 ms) and the window each frame is analysed in (32 ms). */
const HOP = 256;
const WIN = 512;
/** The window is zero-padded to this for the transform, so the autocorrelation does not wrap. */
const NFFT = 1024;
const BIN_HZ = FILLER_RATE / NFFT;
const FRAME_SEC = HOP / FILLER_RATE;

/** Lags searched for the pitch: 70 to 400 Hz. */
const LAG_MIN = Math.round(FILLER_RATE / 400);
const LAG_MAX = Math.round(FILLER_RATE / 70);
/** Bins kept for the pitch search: where a voice's harmonics are. */
const PITCH_FROM = Math.round(60 / BIN_HZ);
const PITCH_TO = Math.round(1500 / BIN_HZ);
/** The spectrum is read between these for the flux, the centroid and the low share. */
const SPEC_FROM_HZ = 100;
const SPEC_TO_HZ = 5000;
const LOW_TO_HZ = 500;
/** Bands for the flux, spaced like the ear hears them (mel). */
const BAND_COUNT = 20;
/** Where the first and second formant are looked for, and how wide the envelope is smoothed. */
const F1_RANGE_HZ: readonly [number, number] = [250, 1000];
const F2_RANGE_HZ: readonly [number, number] = [800, 2600];
const F2_ABOVE_F1_HZ = 250;
const ENVELOPE_HZ = 150;

/**
 * A frame is speech when it is this far over the quietest frames of the phrase and within this much of
 * the loud ones (the 90th percentile): breath and room noise between words are neither.
 */
const SPEECH_OVER_FLOOR_DB = 12;
const SPEECH_UNDER_LOUD_DB = 25;
/** The floor is never more than this far under the loud frames, so digital silence does not set it. */
const FLOOR_UNDER_LOUD_DB = 35;
/** The repeat strength a frame needs to count as voiced, and to carry the pitch that is measured. */
const VOICED_MIN = 0.45;
const PITCH_VOICING = 0.6;
/** Spectral change is also measured over this many frames (48 ms), slower than a single hop. */
const FLUX_SPAN = 3;
/** Unvoiced frames of speech allowed between a run and the pause beside it: the onset and the release. */
const EDGE_FRAMES = 3;
/** Runs this short are a syllable in passing; this long are a word or a sung note. */
const RUN_MIN_SEC = 0.12;
const RUN_FULL_SEC = 0.22;
const RUN_MAX_SEC = 1.5;
/** Median spectral change over 48 ms that is still "not moving", and where it is clearly a word. */
const FLUX_STEADY = 0.05;
const FLUX_MOVING = 0.13;
/** Pitch range (semitones between the 10th and 90th percentile) that is a glide / clearly a melody. */
const PITCH_GLIDE_ST = 5;
const PITCH_MELODY_ST = 12;
/** Pitch wobble (semitones around a straight line) that is smooth / clearly syllables. */
const WOBBLE_SMOOTH_ST = 0.5;
const WOBBLE_BUMPY_ST = 1.5;
/** A run this much quieter than the phrase's loud frames is said under the breath, as hesitations are. */
const SOFT_FROM_DB = 1;
const SOFT_FULL_DB = 6;
/** What a run that is as loud as the rest keeps of its score: loudness is a hint, not a verdict. */
const LOUD_KEEPS = 0.6;
/** The central vowel's formants, and how far off they may be before the vowel is another one. */
const F1_CENTRAL_HZ: readonly [number, number] = [430, 820];
const F2_CENTRAL_HZ: readonly [number, number] = [950, 1750];
const FORMANT_FADE_HZ = 220;
/** A pause this long on a side is a full stand-apart; nothing under the short figure counts. */
const PAUSE_NONE_SEC = 0.08;
const PAUSE_FULL_SEC = 0.25;
/** The cut keeps this much of the pause on either side, so one ordinary pause remains. */
const KEEP_PAUSE_SEC = 0.06;
const CUT_MARGIN_SEC = 0.02;

export type FillerSensitivity = 'low' | 'medium' | 'high';

/** The score a run needs to be cut, per sensitivity. */
export const FILLER_THRESHOLD: Record<FillerSensitivity, number> = { low: 0.55, medium: 0.35, high: 0.2 };

/** One run of voice that was judged, with what was measured about it. */
export interface FillerCandidate {
  /** Where the run of voice is, in seconds into the phrase. */
  from: number;
  to: number;
  /** What would be cut: the run plus most of the pauses around it. */
  cutFrom: number;
  cutTo: number;
  /** 0 (a word) to 1 (a filler for certain). */
  score: number;
  /** The factors the score is the product of, each 0 to 1. */
  parts: { apart: number; steady: number; central: number; glide: number; length: number; soft: number };
  /** The measurements behind the factors, for the tests and the bench. */
  features: {
    durationSec: number;
    /** The median spectral change over 48 ms inside the run. */
    flux3Med: number;
    pitchRangeSt: number;
    pitchWobbleSt: number;
    pitchHz: number;
    f1Hz: number;
    f2Hz: number;
    centroidHz: number;
    /** The run's level against the phrase's loud frames, in dB (negative: quieter). */
    levelDb: number;
    lowShareEnd: number;
    pauseBefore: number;
    pauseAfter: number;
  };
}

/** Everything measured on one frame. */
export interface FrameFeatures {
  energyDb: Float64Array;
  voicing: Float64Array;
  pitchHz: Float64Array;
  /** Spectral change against the previous frame, and against the frame `FLUX_SPAN` hops earlier. */
  flux: Float64Array;
  flux3: Float64Array;
  centroidHz: Float64Array;
  lowShare: Float64Array;
  f1Hz: Float64Array;
  f2Hz: Float64Array;
  /** The band spectrum (square roots of the band powers) of every frame, `BAND_COUNT` per frame. */
  bands: Float64Array;
}

const HANN = new Float64Array(WIN);
for (let i = 0; i < WIN; i++) HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN);

function mel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}
function hzOfMel(m: number): number {
  return 700 * (10 ** (m / 2595) - 1);
}
/** Bin ranges of the flux bands. */
const BAND_BINS: [number, number][] = [];
{
  const lo = mel(SPEC_FROM_HZ);
  const hi = mel(SPEC_TO_HZ);
  for (let b = 0; b < BAND_COUNT; b++) {
    const from = Math.round(hzOfMel(lo + ((hi - lo) * b) / BAND_COUNT) / BIN_HZ);
    const to = Math.max(from + 1, Math.round(hzOfMel(lo + ((hi - lo) * (b + 1)) / BAND_COUNT) / BIN_HZ));
    BAND_BINS.push([from, to]);
  }
}
const SPEC_FROM = Math.round(SPEC_FROM_HZ / BIN_HZ);
const SPEC_TO = Math.round(SPEC_TO_HZ / BIN_HZ);
const LOW_TO = Math.round(LOW_TO_HZ / BIN_HZ);
const ENVELOPE_BINS = Math.round(ENVELOPE_HZ / BIN_HZ / 2);

/**
 * The window's own autocorrelation at every lag, so a frame's autocorrelation can be divided by it:
 * without that, the taper of the window makes every long lag look like a weaker repeat than it is.
 */
const WINDOW_ACF = (() => {
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  for (let i = 0; i < WIN; i++) re[i] = HANN[i] ?? 0;
  fft(re, im);
  for (let k = 0; k < NFFT; k++) {
    re[k] = (re[k] ?? 0) ** 2 + (im[k] ?? 0) ** 2;
    im[k] = 0;
  }
  fft(re, im);
  const acf = new Float64Array(LAG_MAX + 2);
  for (let n = 0; n < acf.length; n++) acf[n] = (re[n] ?? 0) / Math.max(1e-12, re[0] ?? 0);
  return acf;
})();

function ramp(value: number, zero: number, full: number): number {
  return Math.max(0, Math.min(1, (value - zero) / (full - zero)));
}

/** 1 inside [lo, hi], falling to 0 `fade` outside it. */
function inside(value: number, [lo, hi]: readonly [number, number], fade: number): number {
  return Math.min(ramp(value, lo - fade, lo), ramp(hi + fade - value, 0, fade));
}

function percentile(values: ArrayLike<number>, p: number): number {
  const sorted = Array.from(values).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[at] ?? 0;
}

/**
 * The pitch's range in semitones between its 10th and 90th percentile, and its wobble around the
 * straight line through it (the root mean square residual, in semitones), after every value has been
 * folded by octaves onto the median: a tracker that lands an octave low on a few frames must not turn
 * a held note into a melody.
 */
function pitchShape(pitches: readonly number[]): { rangeSt: number; wobbleSt: number } {
  if (pitches.length < 3) return { rangeSt: 0, wobbleSt: 0 };
  const median = percentile(pitches, 0.5);
  const st = pitches.map((p) => {
    let v = p;
    while (v > median * 1.5) v /= 2;
    while (v < median / 1.5) v *= 2;
    return 12 * Math.log2(v);
  });
  const n = st.length;
  const xs = (n - 1) / 2;
  let sxx = 0;
  let sxy = 0;
  let ys = 0;
  for (const y of st) ys += y / n;
  st.forEach((y, i) => {
    sxx += (i - xs) ** 2;
    sxy += (i - xs) * (y - ys);
  });
  const slope = sxx > 0 ? sxy / sxx : 0;
  let res = 0;
  st.forEach((y, i) => {
    res += (y - (ys + slope * (i - xs))) ** 2;
  });
  return {
    rangeSt: percentile(st, 0.9) - percentile(st, 0.1),
    wobbleSt: Math.sqrt(res / n),
  };
}

/** The peak of the smoothed envelope between two frequencies, in Hz; 0 when there is none. */
function envelopePeak(envelope: Float64Array, fromHz: number, toHz: number): number {
  const from = Math.max(1, Math.round(fromHz / BIN_HZ));
  const to = Math.min(envelope.length - 2, Math.round(toHz / BIN_HZ));
  let best = 0;
  let bestK = 0;
  for (let k = from; k <= to; k++) {
    const v = envelope[k] ?? 0;
    if (v > best && v >= (envelope[k - 1] ?? 0) && v >= (envelope[k + 1] ?? 0)) {
      best = v;
      bestK = k;
    }
  }
  return bestK * BIN_HZ;
}

/** Measures every frame of 16 kHz mono audio. */
export function measureFrames(samples: Float32Array): FrameFeatures {
  const frames = Math.max(0, Math.floor((samples.length - WIN) / HOP) + 1);
  const out: FrameFeatures = {
    energyDb: new Float64Array(frames),
    voicing: new Float64Array(frames),
    pitchHz: new Float64Array(frames),
    flux: new Float64Array(frames),
    flux3: new Float64Array(frames),
    centroidHz: new Float64Array(frames),
    lowShare: new Float64Array(frames),
    f1Hz: new Float64Array(frames),
    f2Hz: new Float64Array(frames),
    bands: new Float64Array(frames * BAND_COUNT),
  };
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  const power = new Float64Array(NFFT / 2 + 1);
  const envelope = new Float64Array(NFFT / 2 + 1);
  const bands = new Float64Array(BAND_COUNT);
  const prevBands = new Float64Array(BAND_COUNT);
  for (let f = 0; f < frames; f++) {
    const at = f * HOP;
    let energy = 0;
    for (let i = 0; i < NFFT; i++) {
      const x = i < WIN ? (samples[at + i] ?? 0) : 0;
      if (i < WIN) energy += x * x;
      re[i] = x * (HANN[i] ?? 0);
      im[i] = 0;
    }
    out.energyDb[f] = 10 * Math.log10(energy / WIN + 1e-12);
    fft(re, im);
    for (let k = 0; k < power.length; k++) power[k] = (re[k] ?? 0) ** 2 + (im[k] ?? 0) ** 2;

    // the spectrum: bands for the flux, the centroid, the share under 500 Hz
    let total = 0;
    let weighted = 0;
    let low = 0;
    for (let k = SPEC_FROM; k < SPEC_TO; k++) {
      const p = power[k] ?? 0;
      total += p;
      weighted += p * k * BIN_HZ;
      if (k < LOW_TO) low += p;
    }
    out.centroidHz[f] = total > 0 ? weighted / total : 0;
    out.lowShare[f] = total > 0 ? low / total : 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let b = 0; b < BAND_COUNT; b++) {
      const [from, to] = BAND_BINS[b] ?? [0, 1];
      let sum = 0;
      for (let k = from; k < to; k++) sum += power[k] ?? 0;
      const a = Math.sqrt(sum / (to - from));
      bands[b] = a;
      const prev = prevBands[b] ?? 0;
      dot += a * prev;
      na += a * a;
      nb += prev * prev;
    }
    out.flux[f] = f === 0 || na <= 0 || nb <= 0 ? 1 : 1 - dot / Math.sqrt(na * nb);
    out.bands.set(bands, f * BAND_COUNT);
    prevBands.set(bands);
    if (f >= FLUX_SPAN) {
      let dot3 = 0;
      let n3 = 0;
      const base = (f - FLUX_SPAN) * BAND_COUNT;
      for (let b = 0; b < BAND_COUNT; b++) {
        const o = out.bands[base + b] ?? 0;
        dot3 += (bands[b] ?? 0) * o;
        n3 += o * o;
      }
      out.flux3[f] = na <= 0 || n3 <= 0 ? 1 : 1 - dot3 / Math.sqrt(na * n3);
    } else {
      out.flux3[f] = 1;
    }

    // the envelope: the spectrum smoothed over about 150 Hz, whose peaks are the formants
    const envTo = Math.min(power.length, Math.round(3000 / BIN_HZ));
    for (let k = 0; k < envTo; k++) {
      let sum = 0;
      let count = 0;
      for (let j = Math.max(0, k - ENVELOPE_BINS); j <= Math.min(power.length - 1, k + ENVELOPE_BINS); j++) {
        sum += power[j] ?? 0;
        count++;
      }
      envelope[k] = sum / Math.max(1, count);
    }
    const f1 = envelopePeak(envelope, F1_RANGE_HZ[0], F1_RANGE_HZ[1]);
    out.f1Hz[f] = f1;
    out.f2Hz[f] =
      f1 > 0 ? envelopePeak(envelope, Math.max(F2_RANGE_HZ[0], f1 + F2_ABOVE_F1_HZ), F2_RANGE_HZ[1]) : 0;

    // the repeat: autocorrelation of the low band, through the inverse transform of its power
    for (let k = 0; k < NFFT; k++) {
      re[k] = 0;
      im[k] = 0;
    }
    for (let k = PITCH_FROM; k < PITCH_TO; k++) {
      re[k] = power[k] ?? 0;
      re[NFFT - k] = power[k] ?? 0;
    }
    fft(re, im);
    const r0 = re[0] ?? 0;
    let best = 0;
    let bestLag = 0;
    if (r0 > 1e-9) {
      for (let lag = LAG_MIN; lag <= LAG_MAX; lag++) {
        const r = (re[lag] ?? 0) / r0 / Math.max(1e-3, WINDOW_ACF[lag] ?? 1);
        const before = (re[lag - 1] ?? 0) / r0 / Math.max(1e-3, WINDOW_ACF[lag - 1] ?? 1);
        const after = (re[lag + 1] ?? 0) / r0 / Math.max(1e-3, WINDOW_ACF[lag + 1] ?? 1);
        if (r > best && r > before && r >= after) {
          best = r;
          bestLag = lag;
        }
      }
    }
    out.voicing[f] = Math.min(1, best);
    out.pitchHz[f] = bestLag > 0 ? FILLER_RATE / bestLag : 0;
  }
  return out;
}

/**
 * The filler candidates of a phrase given as 16 kHz samples: every voiced run of the right length,
 * scored. `findFillers` is the version that takes a stored phrase at any rate and applies the
 * sensitivity.
 */
export function scoreFillers(samples: Float32Array): FillerCandidate[] {
  const m = measureFrames(samples);
  const n = m.energyDb.length;
  if (n === 0) return [];
  const totalSec = samples.length / FILLER_RATE;
  const loud = percentile(m.energyDb, 0.9);
  const floor = Math.max(percentile(m.energyDb, 0.15), loud - FLOOR_UNDER_LOUD_DB);
  const speechMin = Math.max(floor + SPEECH_OVER_FLOOR_DB, loud - SPEECH_UNDER_LOUD_DB);
  const speech = new Uint8Array(n);
  const voiced = new Uint8Array(n);
  for (let f = 0; f < n; f++) {
    speech[f] = (m.energyDb[f] ?? -200) > speechMin ? 1 : 0;
    voiced[f] = speech[f] === 1 && (m.voicing[f] ?? 0) >= VOICED_MIN ? 1 : 0;
  }
  // runs of voiced frames, bridging a single dropped frame
  const runs: [number, number][] = [];
  let start = -1;
  for (let f = 0; f <= n; f++) {
    const on =
      f < n && (voiced[f] === 1 || (start >= 0 && f + 1 < n && voiced[f + 1] === 1 && speech[f] === 1));
    if (on && start < 0) start = f;
    if (!on && start >= 0) {
      runs.push([start, f]);
      start = -1;
    }
  }
  const out: FillerCandidate[] = [];
  for (const [a, b] of runs) {
    const durationSec = (b - a) * FRAME_SEC;
    if (durationSec < RUN_MIN_SEC || durationSec > RUN_MAX_SEC) continue;
    // the inside of the run: the first and last frame carry the transitions in and out
    const i0 = Math.min(a + 1, b - 1);
    const i1 = Math.max(i0 + 1, b - 1);
    const pitches: number[] = [];
    const centroids: number[] = [];
    const flux3s: number[] = [];
    const vowelFrames: number[] = [];
    let energySum = 0;
    // the pitch is read off the well-voiced middle of the run: the edges carry the onset and the release
    const trim = Math.floor((i1 - i0) * 0.15);
    for (let f = i0; f < i1; f++) {
      if (f >= i0 + trim && f < i1 - trim && (m.voicing[f] ?? 0) >= PITCH_VOICING && (m.pitchHz[f] ?? 0) > 0)
        pitches.push(m.pitchHz[f] ?? 0);
      centroids.push(m.centroidHz[f] ?? 0);
      if (f >= i0 + 1) flux3s.push(m.flux3[f] ?? 1);
      if ((m.f1Hz[f] ?? 0) > 0 && (m.f2Hz[f] ?? 0) > 0) vowelFrames.push(f);
      energySum += m.energyDb[f] ?? 0;
    }
    const flux3Med = percentile(flux3s, 0.5);
    const { rangeSt: pitchRangeSt, wobbleSt: pitchWobbleSt } = pitchShape(pitches);
    const centroidHz = percentile(centroids, 0.5);
    // the formants are read off the least nasal frames (the vowel of "um" is short before its long "m")
    vowelFrames.sort((x, y) => (m.lowShare[x] ?? 0) - (m.lowShare[y] ?? 0));
    const vowel = vowelFrames.slice(0, Math.max(1, Math.round(vowelFrames.length * 0.4)));
    const f1Hz = percentile(
      vowel.map((f) => m.f1Hz[f] ?? 0),
      0.5,
    );
    const f2Hz = percentile(
      vowel.map((f) => m.f2Hz[f] ?? 0),
      0.5,
    );
    const levelDb = energySum / (i1 - i0) - loud;
    const tailFrom = Math.max(a, b - Math.max(2, Math.round((b - a) * 0.4)));
    let lowSum = 0;
    for (let f = tailFrom; f < b; f++) lowSum += m.lowShare[f] ?? 0;
    const lowShareEnd = lowSum / Math.max(1, b - tailFrom);
    // the pauses: frames without speech on either side, past the few unvoiced frames of the onset and
    // the release, up to the next speech or the phrase's edge
    let left = a - 1;
    for (let k = 0; k < EDGE_FRAMES && left >= 0 && speech[left] === 1; k++) left--;
    let before = 0;
    while (left - before >= 0 && speech[left - before] === 0) before++;
    let right = b;
    for (let k = 0; k < EDGE_FRAMES && right < n && speech[right] === 1; k++) right++;
    let after = 0;
    while (right + after < n && speech[right + after] === 0) after++;
    const atStart = left - before < 0;
    const atEnd = right + after >= n;
    const pauseBefore = atStart ? Infinity : before * FRAME_SEC;
    const pauseAfter = atEnd ? Infinity : after * FRAME_SEC;

    const sideBefore = ramp(pauseBefore, PAUSE_NONE_SEC, PAUSE_FULL_SEC);
    const sideAfter = ramp(pauseAfter, PAUSE_NONE_SEC, PAUSE_FULL_SEC);
    const apart = 0.4 * Math.max(sideBefore, sideAfter) + 0.6 * Math.min(sideBefore, sideAfter);
    const steady = ramp(FLUX_MOVING - flux3Med, 0, FLUX_MOVING - FLUX_STEADY);
    const central =
      f1Hz > 0 && f2Hz > 0
        ? Math.min(inside(f1Hz, F1_CENTRAL_HZ, FORMANT_FADE_HZ), inside(f2Hz, F2_CENTRAL_HZ, FORMANT_FADE_HZ))
        : 0.5;
    const glide = Math.min(
      ramp(PITCH_MELODY_ST - pitchRangeSt, 0, PITCH_MELODY_ST - PITCH_GLIDE_ST),
      ramp(WOBBLE_BUMPY_ST - pitchWobbleSt, 0, WOBBLE_BUMPY_ST - WOBBLE_SMOOTH_ST),
    );
    const length = ramp(durationSec, RUN_MIN_SEC, RUN_FULL_SEC) * ramp(RUN_MAX_SEC - durationSec, 0, 0.5);
    const soft = LOUD_KEEPS + (1 - LOUD_KEEPS) * ramp(-levelDb, SOFT_FROM_DB, SOFT_FULL_DB);
    const score = apart * steady * central * glide * length * soft;

    const from = a * FRAME_SEC;
    const to = Math.min(totalSec, b * FRAME_SEC + (WIN - HOP) / FILLER_RATE);
    const prevSpeechEnd = atStart ? 0 : (left - before + 1) * FRAME_SEC;
    const nextSpeechStart = atEnd ? totalSec : (right + after) * FRAME_SEC;
    const cutFrom = atStart ? 0 : Math.max(prevSpeechEnd + KEEP_PAUSE_SEC, from - CUT_MARGIN_SEC);
    const cutTo = atEnd ? totalSec : Math.min(nextSpeechStart - KEEP_PAUSE_SEC, to + CUT_MARGIN_SEC);
    out.push({
      from,
      to,
      cutFrom: Math.max(0, Math.min(cutFrom, from)),
      cutTo: Math.min(totalSec, Math.max(cutTo, to)),
      score,
      parts: { apart, steady, central, glide, length, soft },
      features: {
        durationSec,
        flux3Med,
        pitchRangeSt,
        pitchWobbleSt,
        pitchHz: percentile(pitches, 0.5),
        f1Hz,
        f2Hz,
        centroidHz,
        levelDb,
        lowShareEnd,
        pauseBefore,
        pauseAfter,
      },
    });
  }
  return out;
}

/** Converts a stored phrase to 16 kHz floats for the analysis. */
export function toAnalysisRate(pcm: Int16Array, sampleRate: number): Float32Array {
  const floats = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) floats[i] = (pcm[i] ?? 0) / 32768;
  if (sampleRate === FILLER_RATE) return floats;
  return new Downsampler(sampleRate, FILLER_RATE).process(floats);
}

/** The fillers of a phrase at `sensitivity`, as candidates whose score clears the bar, in time order. */
export function findFillers(
  pcm: Int16Array,
  sampleRate: number,
  sensitivity: FillerSensitivity,
): FillerCandidate[] {
  const threshold = FILLER_THRESHOLD[sensitivity];
  return scoreFillers(toAnalysisRate(pcm, sampleRate)).filter((c) => c.score >= threshold);
}

export { FRAME_SEC as FILLER_FRAME_SEC };
