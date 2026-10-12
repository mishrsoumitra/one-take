/**
 * The second listen: scoring a finished clip with hindsight.
 *
 * The live detector (`voice.ts`, `vad.ts`) hears each frame once and has to answer at once, so it is
 * kept lenient and never makes a cut. Once a phrase is finished, or when the editor is asked to
 * remove pauses, the clip comes through here, where every frame can be judged knowing what came
 * before and after it. The same three things are measured as live (standing out from the room,
 * being voiced, changing; see `voice.ts`), by the same arithmetic, with no model and nothing trained;
 * what hindsight adds is the context:
 *
 * - **The floor is the quietest the room has been within two seconds either side** of a frame, not a
 *   running guess that can only look back. The live floor must rise during a long quiet stretch to
 *   absorb a fan that switched on, and a quiet voice looks like a long quiet stretch to it, so the
 *   live floor can climb into a soft sentence until the sentence stands over nothing. Here the floor
 *   under a soft sentence is the gap before or after it, so the sentence stands over the room however
 *   softly it was said.
 * - **A pitch counts as carried when it continues from the frame before or into the frame after**, so
 *   the first voiced frame of every word, which live can only be halved (nothing before it to carry
 *   from), counts in full.
 * - **Steadiness is measured around a frame**, not behind it, and a weak frame is lifted by the frames on
 *   either side of it, not only by the one before.
 *
 * The result is one score per 32 ms frame, the same shape the live detector produces, which
 * `silence.ts` turns into the stretches to keep. The clip is gone through twice (the floor has to be
 * known before a frame can be compared with it), in chunks, yielding to the event loop now and then
 * so progress can be shown; an hour of audio takes well under a minute.
 */
import { Downsampler, SPEECH_FRAME, SPEECH_RATE } from './speech.js';
import {
  BAND_COUNT,
  BINS,
  FLOOR_MIN,
  FrameAnalyser,
  pitchCarries,
  RELEASE,
  STEADY_FRAMES,
  steadinessOf,
  voiceScore,
} from './voice.js';

/** How far either side of a frame the quietest the room has been is looked for, in frames (2 s). */
const REACH = 62;
/** Frames the band power is averaged over before the quietest is looked for, so one chance dip does not set the floor. */
const SMOOTH = 5;
/**
 * The quietest moment of a noise sits under its average level, which is what the live floor settles
 * on; the floor found here is lifted by this much (1.5 dB) to agree with it.
 */
const FLOOR_LIFT = 1.4;
/** The bin floors are kept per stretch of this many frames (1 s); a frame's is the lowest over the stretches within reach. */
const STRETCH = 31;
/** Stretches either side of a frame's own that its bin floor is taken over. */
const STRETCH_REACH = 2;
/** Keeps the page responsive while a long clip is scored: this many frames between yields. */
const YIELD_EVERY = 64;

const yieldNow = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Runs `pcm` through the downsampler frame by frame, calling `fn` with each 16 kHz frame; the last,
 * partial frame is padded with silence. Works in chunks so an hour-long clip never has to exist as
 * floats all at once, and yields to the event loop now and then.
 */
async function eachFrame(
  pcm: Int16Array | Float32Array,
  sampleRate: number,
  fn: (frame: Float32Array) => void,
  onProgress?: (secondsDone: number) => void,
): Promise<void> {
  const down = new Downsampler(sampleRate, SPEECH_RATE);
  const frame = new Float32Array(SPEECH_FRAME);
  let filled = 0;
  let frames = 0;
  const chunk = Math.max(1, Math.round(sampleRate));
  const scale = pcm instanceof Int16Array ? 1 / 32768 : 1;
  for (let at = 0; at < pcm.length; at += chunk) {
    const floats = new Float32Array(Math.min(chunk, pcm.length - at));
    for (let i = 0; i < floats.length; i++) floats[i] = (pcm[at + i] ?? 0) * scale;
    for (const sample of down.process(floats)) {
      frame[filled++] = sample;
      if (filled === SPEECH_FRAME) {
        fn(frame);
        filled = 0;
        if (++frames % YIELD_EVERY === 0) await yieldNow();
      }
    }
    onProgress?.((at + floats.length) / sampleRate);
  }
  if (filled > 0) {
    frame.fill(0, filled);
    fn(frame);
  }
}

/** The lowest value of `values` within `reach` either side of each index. */
function slidingMin(values: Float64Array, reach: number): Float64Array {
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let min = Infinity;
    const to = Math.min(values.length - 1, i + reach);
    for (let j = Math.max(0, i - reach); j <= to; j++) if ((values[j] ?? 0) < min) min = values[j] ?? 0;
    out[i] = min;
  }
  return out;
}

/** `values` averaged over `width` frames centred on each index. */
function smooth(values: Float64Array, width: number): Float64Array {
  const out = new Float64Array(values.length);
  const half = Math.floor(width / 2);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let n = 0;
    const to = Math.min(values.length - 1, i + half);
    for (let j = Math.max(0, i - half); j <= to; j++) {
      sum += values[j] ?? 0;
      n++;
    }
    out[i] = n > 0 ? sum / n : 0;
  }
  return out;
}

/**
 * Scores a finished clip from start to end with hindsight: one number per frame of 32 ms
 * (`SPEECH_FRAME_SEC`), 0 (no voice) to 1 (a voice), on the same scale as the live
 * detector's scores and read by `speechRanges` with the same rules. The clip is 16-bit PCM (a stored
 * clip) or floats in -1..1 (a phrase straight from the microphone), at any sample rate.
 */
export async function listenAgain(
  pcm: Int16Array | Float32Array,
  sampleRate: number,
  onProgress?: (secondsDone: number) => void,
): Promise<Float32Array> {
  const seconds = pcm.length / sampleRate;
  const capacity = Math.ceil((seconds * SPEECH_RATE) / SPEECH_FRAME) + 2;
  const analyser = new FrameAnalyser();

  // First pass: the power of every band in every frame, and the quietest each bin has been per stretch.
  const power = new Float64Array(capacity * BAND_COUNT);
  const energy = new Float64Array(capacity);
  const stretches = Math.ceil(capacity / STRETCH) + 1;
  const binMin = new Float64Array(stretches * BINS).fill(Infinity);
  let n = 0;
  await eachFrame(
    pcm,
    sampleRate,
    (frame) => {
      if (n >= capacity) return;
      analyser.analyse(frame);
      power.set(analyser.power, n * BAND_COUNT);
      energy[n] = analyser.energyDb;
      const { spectrum } = analyser;
      const base = Math.floor(n / STRETCH) * BINS;
      for (let k = 0; k < BINS; k++) {
        // a bin with a little of its neighbours: the room's noise is smooth across bins, one frame's power is not
        const around =
          (0.5 * (spectrum[k - 1] ?? spectrum[k] ?? 0) +
            (spectrum[k] ?? 0) +
            0.5 * (spectrum[k + 1] ?? spectrum[k] ?? 0)) /
          2;
        if (around < (binMin[base + k] ?? Infinity)) binMin[base + k] = around;
      }
      n++;
    },
    (sec) => onProgress?.(sec / 2),
  );
  const frames = n;

  // The floors: per band and frame, the quietest the smoothed power has been within reach; per bin
  // and stretch, the quietest over the stretches within reach.
  const bandFloor = new Float64Array(frames * BAND_COUNT);
  for (let b = 0; b < BAND_COUNT; b++) {
    const column = new Float64Array(frames);
    for (let f = 0; f < frames; f++) column[f] = power[f * BAND_COUNT + b] ?? 0;
    const quietest = slidingMin(smooth(column, SMOOTH), REACH);
    for (let f = 0; f < frames; f++)
      bandFloor[f * BAND_COUNT + b] = Math.max(FLOOR_MIN, (quietest[f] ?? 0) * FLOOR_LIFT);
  }
  const used = Math.ceil(frames / STRETCH);
  const binFloor = new Float64Array(used * BINS);
  for (let s = 0; s < used; s++) {
    for (let k = 0; k < BINS; k++) {
      let min = Infinity;
      for (let t = Math.max(0, s - STRETCH_REACH); t <= Math.min(used - 1, s + STRETCH_REACH); t++) {
        const v = binMin[t * BINS + k] ?? Infinity;
        if (v < min) min = v;
      }
      binFloor[s * BINS + k] = Math.max(FLOOR_MIN, (min === Infinity ? 0 : min) * FLOOR_LIFT);
    }
  }
  // Steadiness around each frame: how little the energy moved over 1.5 s centred on it.
  const half = Math.floor(STEADY_FRAMES / 2);
  const steadiness = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let lo = Infinity;
    let hi = -Infinity;
    const to = Math.min(frames - 1, f + half);
    for (let j = Math.max(0, f - half); j <= to; j++) {
      const e = energy[j] ?? 0;
      if (e < lo) lo = e;
      if (e > hi) hi = e;
    }
    steadiness[f] = steadinessOf(hi - lo);
  }
  await yieldNow();

  // Second pass: each frame against its floors.
  const snr = new Float64Array(frames);
  const strength = new Float64Array(frames);
  const lag = new Int32Array(frames);
  const second = new FrameAnalyser();
  let m = 0;
  await eachFrame(
    pcm,
    sampleRate,
    (frame) => {
      if (m >= frames) return;
      second.analyse(frame);
      snr[m] = second.snrDb(bandFloor, m * BAND_COUNT);
      strength[m] = second.repeat(binFloor, Math.floor(m / STRETCH) * BINS);
      lag[m] = second.lag;
      m++;
    },
    (sec) => onProgress?.(seconds / 2 + sec / 2),
  );

  // The scores: a pitch carried from either neighbour counts in full, and each frame is lifted by the
  // release of the frames on both sides of it.
  const raw = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    const l = lag[f] ?? 0;
    const holds = pitchCarries(l, lag[f - 1] ?? 0) || pitchCarries(l, lag[f + 1] ?? 0);
    const harmonicity = l === 0 ? 0 : (strength[f] ?? 0) * (holds ? 1 : 0.5);
    raw[f] = voiceScore(snr[f] ?? 0, harmonicity, steadiness[f] ?? 0);
  }
  const probs = new Float32Array(frames);
  let forward = 0;
  for (let f = 0; f < frames; f++) {
    forward = Math.max(raw[f] ?? 0, forward * RELEASE);
    probs[f] = forward;
  }
  let backward = 0;
  for (let f = frames - 1; f >= 0; f--) {
    backward = Math.max(raw[f] ?? 0, backward * RELEASE);
    if (backward > (probs[f] ?? 0)) probs[f] = backward;
  }
  return probs;
}
