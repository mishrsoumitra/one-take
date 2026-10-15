/**
 * Log mel filterbank features the way Kaldi computes them, for the speaker model.
 *
 * The voice model (`speaker.ts`) was trained on Kaldi's 80-band log mel filterbank, so the features
 * handed to it have to be made the same way, number for number: 25 ms frames every 10 ms, the
 * frame's mean removed, pre-emphasis, the Povey window, a 512-point power spectrum, 80 triangular
 * mel bands between 20 Hz and 400 Hz under half the sample rate, the log of each band's energy, with
 * the energy never under the float epsilon. Frames reach past the ends of the clip by reflecting it,
 * so a clip of n samples gives about n / 160 frames.
 *
 * The values match kaldi-native-fbank (what sherpa-onnx feeds these models) to a few thousandths;
 * `test/fbank.test.ts` holds frames computed by it.
 *
 * Nothing in this file touches the browser; the tests run it in Node.
 */
import { fft } from './fft.js';

/** The model's sample rate. */
export const FBANK_RATE = 16000;
/** Mel bands per frame. */
export const FBANK_BANDS = 80;
/** 25 ms of audio per frame. */
export const FBANK_FRAME = 400;
/** A new frame every 10 ms. */
export const FBANK_SHIFT = 160;
/** The frame is padded to this for the transform. */
const FFT_SIZE = 512;
const PREEMPHASIS = 0.97;
const LOW_HZ = 20;
/** The highest band ends this far under half the sample rate. */
const HIGH_HZ_UNDER_NYQUIST = 400;
/** The energy of a band is never under this before the log: float32's epsilon, as in Kaldi. */
const ENERGY_FLOOR = 1.1920929e-7;
/**
 * The model was trained on 16-bit integer samples; floats in [-1, 1] are scaled back up to that
 * range, as sherpa-onnx does for a model whose metadata says `normalize_samples = 0`.
 */
export const SAMPLE_SCALE = 32768;

function melScale(hz: number): number {
  return 1127 * Math.log(1 + hz / 700);
}

/** One mel band: the first spectrum bin it covers and its weight on each bin from there. */
interface Band {
  first: number;
  weights: Float64Array;
}

let bandsCache: Band[] | null = null;
let windowCache: Float64Array | null = null;

/** Kaldi's mel banks: triangles equally spaced on the mel scale, over the bins under the Nyquist bin. */
function melBands(): Band[] {
  if (bandsCache) return bandsCache;
  const bins = FFT_SIZE / 2;
  const binWidth = FBANK_RATE / FFT_SIZE;
  const low = melScale(LOW_HZ);
  const high = melScale(FBANK_RATE / 2 - HIGH_HZ_UNDER_NYQUIST);
  const delta = (high - low) / (FBANK_BANDS + 1);
  const bands: Band[] = [];
  for (let b = 0; b < FBANK_BANDS; b++) {
    const left = low + b * delta;
    const centre = left + delta;
    const right = left + 2 * delta;
    const weights: number[] = [];
    let first = -1;
    for (let i = 0; i < bins; i++) {
      const mel = melScale(binWidth * i);
      if (mel > left && mel < right) {
        if (first < 0) first = i;
        weights.push(mel <= centre ? (mel - left) / (centre - left) : (right - mel) / (right - centre));
      } else if (first >= 0) break;
    }
    bands.push({ first: Math.max(0, first), weights: Float64Array.from(weights) });
  }
  bandsCache = bands;
  return bands;
}

/** The Povey window: a Hann window raised to 0.85. */
function poveyWindow(): Float64Array {
  if (windowCache) return windowCache;
  const w = new Float64Array(FBANK_FRAME);
  const a = (2 * Math.PI) / (FBANK_FRAME - 1);
  for (let i = 0; i < FBANK_FRAME; i++) w[i] = Math.pow(0.5 - 0.5 * Math.cos(a * i), 0.85);
  windowCache = w;
  return w;
}

/** How many frames a clip of `samples` samples gives (Kaldi, edges not snipped, clip finished). */
export function fbankFrames(samples: number): number {
  return Math.floor((samples + FBANK_SHIFT / 2) / FBANK_SHIFT);
}

/** The sample index of a clip that a frame's sample `s` maps to, reflecting past either end. */
function reflect(s: number, n: number): number {
  let k = s;
  while (k < 0 || k >= n) k = k < 0 ? -k - 1 : 2 * n - 1 - k;
  return k;
}

/** Features as the model takes them: `frames` rows of {@link FBANK_BANDS}, row after row. */
export interface Fbank {
  frames: number;
  data: Float32Array;
}

/**
 * The log mel filterbank of a clip of 16 kHz floats in [-1, 1]. Every frame comes out, the first
 * and last ones reaching past the clip by reflection, as Kaldi does once a clip is finished.
 */
export function fbank(samples: Float32Array): Fbank {
  const n = samples.length;
  const frames = fbankFrames(n);
  const data = new Float32Array(frames * FBANK_BANDS);
  const bands = melBands();
  const window = poveyWindow();
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const power = new Float64Array(FFT_SIZE / 2);
  for (let f = 0; f < frames; f++) {
    // Kaldi centres frame f on sample f * shift + shift / 2
    const start = f * FBANK_SHIFT + FBANK_SHIFT / 2 - FBANK_FRAME / 2;
    let sum = 0;
    for (let i = 0; i < FBANK_FRAME; i++) {
      const v = (samples[reflect(start + i, n)] ?? 0) * SAMPLE_SCALE;
      re[i] = v;
      sum += v;
    }
    // the frame's mean goes, then pre-emphasis, then the window
    const mean = sum / FBANK_FRAME;
    for (let i = 0; i < FBANK_FRAME; i++) re[i] = (re[i] ?? 0) - mean;
    for (let i = FBANK_FRAME - 1; i > 0; i--) re[i] = (re[i] ?? 0) - PREEMPHASIS * (re[i - 1] ?? 0);
    re[0] = (re[0] ?? 0) - PREEMPHASIS * (re[0] ?? 0);
    for (let i = 0; i < FBANK_FRAME; i++) re[i] = (re[i] ?? 0) * (window[i] ?? 0);
    re.fill(0, FBANK_FRAME);
    im.fill(0);
    fft(re, im);
    for (let i = 0; i < FFT_SIZE / 2; i++) power[i] = (re[i] ?? 0) ** 2 + (im[i] ?? 0) ** 2;
    const row = f * FBANK_BANDS;
    for (let b = 0; b < FBANK_BANDS; b++) {
      const band = bands[b];
      if (!band) continue;
      let energy = 0;
      for (let k = 0; k < band.weights.length; k++)
        energy += (band.weights[k] ?? 0) * (power[band.first + k] ?? 0);
      data[row + b] = Math.log(Math.max(energy, ENERGY_FLOOR));
    }
  }
  return { frames, data };
}

/**
 * Takes each band's mean over the clip out of every frame, in place. The model was trained with
 * this (cepstral mean normalisation): it makes the features deaf to the microphone's colour and
 * the level, so the same voice through two microphones comes out the same.
 */
export function subtractMean(features: Fbank): Fbank {
  const { frames, data } = features;
  if (frames === 0) return features;
  const mean = new Float64Array(FBANK_BANDS);
  for (let f = 0; f < frames; f++)
    for (let b = 0; b < FBANK_BANDS; b++) mean[b] = (mean[b] ?? 0) + (data[f * FBANK_BANDS + b] ?? 0);
  for (let b = 0; b < FBANK_BANDS; b++) mean[b] = (mean[b] ?? 0) / frames;
  for (let f = 0; f < frames; f++)
    for (let b = 0; b < FBANK_BANDS; b++)
      data[f * FBANK_BANDS + b] = (data[f * FBANK_BANDS + b] ?? 0) - (mean[b] ?? 0);
  return features;
}
