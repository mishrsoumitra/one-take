/**
 * The noise filter: takes the room's steady noise (a fan, an air conditioner, a hum, hiss, the
 * computer's own fan) out from under a voice before it is recorded, by arithmetic alone. There is
 * no model, nothing trained and no weights; every number in this file is a rule that can be read and
 * argued with.
 *
 * The sound is cut into frames of about 21 ms that overlap by half, and each frame is turned into
 * its spectrum: how much sound there is at each pitch, from 0 Hz up to half the sample rate, in bins
 * about 47 Hz wide. Three things happen to every bin of every frame:
 *
 * 1. **Learning the room.** Each bin keeps an estimate of the noise in it, the floor. The floor
 *    follows the bin's power whenever the bin is judged to hold no voice: when its power, smoothed a
 *    little, stands less than 7 dB over the quietest the bin has been in the last second or two. A
 *    fan, a hum or hiss hold their level, so they are the quietest the bin has been and become the
 *    floor within a second or two of switching on; a voice keeps changing and never does. While a
 *    bin is judged to hold a voice its floor is frozen, so a sentence never lifts it.
 * 2. **Judging what stands over it.** For each bin, how far the frame's power stands over the floor
 *    is the measured ratio. What is believed to be voice on top of the floor, the believed ratio, is
 *    taken mostly from what the filter kept of the previous frame and only a little from the measured
 *    ratio of this one. That memory is what stops the result from twinkling: a bin that stood out for
 *    one frame by chance is not believed, while a voice that keeps a harmonic going for a few frames
 *    is believed in full.
 * 3. **Scaling the bin.** Each bin is scaled by a gain between a floor and 1 that follows from the
 *    two ratios: the Ephraim-Malah log-spectral amplitude estimator, which is the gain with the least
 *    expected error in the log of the amplitude, the scale that matches how loudness is heard. A bin
 *    believed to be all noise is scaled down to the gain floor (24 dB); a bin believed to be all voice
 *    is left alone. Nothing is ever scaled under the gain floor, so the noise that is left sounds like
 *    a quieter version of the room rather than a flutter of tones.
 *
 * The frames are put back together through windows that add up to one, so a clean voice comes out
 * as it went in, one frame (21 ms) later. The filter runs on the audio thread in the capture
 * worklet; nothing in this file touches the browser, and the tests run it in Node.
 */
import { fft } from './fft.js';

export interface NoiseFilterOptions {
  /** How far, in dB, a bin may be pushed down; what is left of the room is this much quieter at most. */
  floorDb?: number;
}

/** The default gain floor, in dB. */
export const FLOOR_DB = 24;

/** Power is smoothed over frames this much before the quietest level is looked for. */
const SMOOTH_POWER = 0.8;
/** How much of its old value the floor keeps per frame while the bin holds no voice. */
const SMOOTH_FLOOR = 0.95;
/** How much of its old value the voice judgement keeps per frame. */
const SMOOTH_PRESENCE = 0.2;
/** A bin standing this far (as a power ratio: about 7 dB) over its quietest level holds a voice. */
const PRESENCE_RATIO = 5;
/** The quietest level is looked for over windows of this long; a sound is the room after one or two. */
const QUIETEST_SEC = 1;
/** The first stretch of a stream is taken to be the room: its average sets every floor. */
const INIT_SEC = 0.5;
/** How much of the believed ratio comes from the previous frame (the decision-directed rule). */
const BELIEF_MEMORY = 0.98;
/** The believed ratio is never under this (-25 dB): keeps the gain in all-noise bins steady. */
const BELIEF_MIN = 10 ** (-25 / 10);
/** A floor is never under this per-bin power: digital silence is not an empty room. */
const POWER_MIN = 1e-12;
const EPS = 1e-12;

/**
 * The exponential integral E1(x), the integral from x to infinity of e^-t / t: what the estimator's
 * gain is made of. Polynomial and rational fits from Abramowitz & Stegun (5.1.53 and 5.1.56), good
 * to five figures over the whole range.
 */
export function expint(x: number): number {
  if (x <= 0) return Infinity;
  if (x <= 1) {
    return (
      -Math.log(x) -
      0.57721566 +
      x * (0.99999193 + x * (-0.24991055 + x * (0.05519968 + x * (-0.00976004 + x * 0.00107857))))
    );
  }
  const num = x * x + 2.334733 * x + 0.250621;
  const den = x * x + 3.330657 * x + 1.681534;
  return (Math.exp(-x) / x) * (num / den);
}

/** The frame, in samples, for the sample rates in use: 21 ms at 48 kHz, 23 ms at 44.1 kHz, 32 ms at 16 kHz. */
export function frameSizeFor(sampleRate: number): number {
  return sampleRate > 24000 ? 1024 : 512;
}

/**
 * One stream of audio through the filter; it remembers the room between frames. `process` takes
 * samples in blocks of any length and returns exactly as many, each one delayed by {@link latency}
 * samples, so the first block out begins with that much silence.
 */
export class NoiseFilter {
  /** Samples per frame. */
  readonly frame: number;
  /** Samples between frames: half a frame. */
  readonly hop: number;
  /** How far behind its input the output runs, in samples: one frame. */
  readonly latency: number;
  private readonly gainMin: number;
  private readonly bins: number;
  private readonly quietestFrames: number;
  private readonly initFrames: number;
  private frames = 0;
  /** The square root of a Hann window: used on the way in and on the way out, so the two add up to one. */
  private readonly window: Float64Array;
  /** The last frame's worth of input. */
  private readonly input: Float64Array;
  /** The output being assembled: frames overlap here before their first half is handed out. */
  private readonly output: Float64Array;
  /** The half frame of output ready to be handed out, one sample per sample taken in. */
  private readonly ready: Float64Array;
  private readonly pending: Float64Array;
  private pendingCount = 0;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly power: Float64Array;
  private readonly smoothed: Float64Array;
  private readonly quietest: Float64Array;
  private readonly quietestNext: Float64Array;
  private readonly presence: Float64Array;
  private readonly floor: Float64Array;
  private readonly gain: Float64Array;
  private readonly measured: Float64Array;

  constructor(
    readonly sampleRate: number,
    options: NoiseFilterOptions = {},
  ) {
    const n = frameSizeFor(sampleRate);
    this.frame = n;
    this.hop = n / 2;
    this.latency = n;
    this.gainMin = 10 ** (-(options.floorDb ?? FLOOR_DB) / 20);
    this.bins = n / 2 + 1;
    this.quietestFrames = Math.max(1, Math.round((QUIETEST_SEC * sampleRate) / this.hop));
    this.initFrames = Math.max(1, Math.round((INIT_SEC * sampleRate) / this.hop));
    this.window = new Float64Array(n);
    for (let i = 0; i < n; i++) this.window[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
    this.input = new Float64Array(n);
    this.output = new Float64Array(n);
    this.ready = new Float64Array(this.hop);
    this.pending = new Float64Array(this.hop);
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.power = new Float64Array(this.bins);
    this.smoothed = new Float64Array(this.bins);
    this.quietest = new Float64Array(this.bins);
    this.quietestNext = new Float64Array(this.bins);
    this.presence = new Float64Array(this.bins);
    this.floor = new Float64Array(this.bins);
    this.gain = new Float64Array(this.bins).fill(1);
    this.measured = new Float64Array(this.bins);
  }

  /** Filters a block of samples; the result is as long as the block and {@link latency} samples behind it. */
  process(block: Float32Array): Float32Array {
    const out = new Float32Array(block.length);
    const { hop, pending, ready } = this;
    let at = 0;
    while (at < block.length) {
      const n = Math.min(hop - this.pendingCount, block.length - at);
      for (let i = 0; i < n; i++) {
        const j = this.pendingCount + i;
        pending[j] = block[at + i] ?? 0;
        out[at + i] = ready[j] ?? 0;
      }
      this.pendingCount += n;
      at += n;
      if (this.pendingCount === hop) {
        this.step();
        this.pendingCount = 0;
      }
    }
    return out;
  }

  /** The floor of each bin as the filter sees it now, in dB of power; for the tests and the meter. */
  floorDb(bin: number): number {
    return 10 * Math.log10((this.floor[bin] ?? POWER_MIN) + EPS);
  }

  /** A half frame is in: analyse the frame it completes, scale its bins and hand out half a frame. */
  private step(): void {
    const { frame: n, hop, window, input, output, ready, re, im, power } = this;
    input.copyWithin(0, hop);
    input.set(this.pending, hop);
    for (let i = 0; i < n; i++) {
      re[i] = (input[i] ?? 0) * (window[i] ?? 0);
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < this.bins; k++) power[k] = (re[k] ?? 0) ** 2 + (im[k] ?? 0) ** 2;
    this.learnRoom();
    this.judge();
    // scale the bins and go back to a waveform: the conjugate's transform is the inverse (times n)
    for (let k = 0; k < this.bins; k++) {
      const g = this.gain[k] ?? 1;
      re[k] = (re[k] ?? 0) * g;
      im[k] = -(im[k] ?? 0) * g;
    }
    for (let k = 1; k < hop; k++) {
      re[n - k] = re[k] ?? 0;
      im[n - k] = -(im[k] ?? 0);
    }
    fft(re, im);
    for (let i = 0; i < n; i++) output[i] = (output[i] ?? 0) + ((re[i] ?? 0) / n) * (window[i] ?? 0);
    ready.set(output.subarray(0, hop));
    output.copyWithin(0, hop);
    output.fill(0, hop);
    this.frames++;
  }

  /**
   * Moves each bin's floor. For the first half second the floor is simply the average so far: the
   * stream has just started and nobody is speaking yet. After that the bin's power, smoothed over its
   * neighbours and over frames, is compared with the quietest it has been over the last window or
   * two; a bin that stands well over that is judged to hold a voice, and its floor stays put.
   * Everywhere else the floor follows the power.
   */
  private learnRoom(): void {
    const { bins, power, smoothed, quietest, quietestNext, presence, floor } = this;
    const first = this.frames === 0;
    const starting = this.frames < this.initFrames;
    const newWindow = !first && this.frames % this.quietestFrames === 0;
    for (let k = 0; k < bins; k++) {
      const p = power[k] ?? 0;
      // the bin with a little of its neighbours: the room's noise is smooth across bins, a single
      // frame's power is not
      const around = (0.5 * (power[k - 1] ?? p) + p + 0.5 * (power[k + 1] ?? p)) / 2;
      if (first) {
        smoothed[k] = around;
        quietest[k] = around;
        quietestNext[k] = around;
        floor[k] = Math.max(POWER_MIN, around);
        continue;
      }
      const s = SMOOTH_POWER * (smoothed[k] ?? 0) + (1 - SMOOTH_POWER) * around;
      smoothed[k] = s;
      if (newWindow) {
        quietest[k] = Math.min(quietestNext[k] ?? s, s);
        quietestNext[k] = s;
      } else {
        quietest[k] = Math.min(quietest[k] ?? s, s);
        quietestNext[k] = Math.min(quietestNext[k] ?? s, s);
      }
      if (starting) {
        floor[k] = Math.max(POWER_MIN, (floor[k] ?? 0) + (around - (floor[k] ?? 0)) / (this.frames + 1));
        continue;
      }
      const voiced = s > PRESENCE_RATIO * (quietest[k] ?? 0) ? 1 : 0;
      const q = SMOOTH_PRESENCE * (presence[k] ?? 0) + (1 - SMOOTH_PRESENCE) * voiced;
      presence[k] = q;
      // a bin judged all voice keeps its floor; one judged all noise lets it follow the power
      const keep = SMOOTH_FLOOR + (1 - SMOOTH_FLOOR) * q;
      floor[k] = Math.max(POWER_MIN, keep * (floor[k] ?? 0) + (1 - keep) * around);
    }
  }

  /** The gain of each bin from the measured and the believed ratios of voice to floor. */
  private judge(): void {
    const { bins, power, floor, gain, measured, gainMin } = this;
    for (let k = 0; k < bins; k++) {
      const ratio = (power[k] ?? 0) / ((floor[k] ?? POWER_MIN) + EPS);
      const previous = (gain[k] ?? 1) ** 2 * (measured[k] ?? 0);
      const believed = Math.max(
        BELIEF_MIN,
        BELIEF_MEMORY * previous + (1 - BELIEF_MEMORY) * Math.max(0, ratio - 1),
      );
      const share = believed / (1 + believed);
      const v = Math.max(1e-8, share * ratio);
      const g = share * Math.exp(0.5 * expint(v));
      gain[k] = Math.min(1, Math.max(gainMin, g));
      measured[k] = ratio;
    }
  }
}
