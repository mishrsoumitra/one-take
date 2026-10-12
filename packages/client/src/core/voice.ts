/**
 * The voice detector: tells a human voice from the rest of what a microphone hears, by arithmetic
 * alone. There is no model, nothing trained and no weights; every number in this file is a rule
 * that can be read and argued with.
 *
 * It listens to 16 kHz audio in frames of 512 samples (32 ms), looking at each frame together with
 * the one before it through a 64 ms window, and gives each frame a score from 0 (no voice) to 1 (a
 * voice). Three things go into the score:
 *
 * 1. **Standing out from the room.** The window's power in eight bands between 100 Hz and 5 kHz is
 *    compared with an estimate of the room's noise in each band, the floor. A fan, an air
 *    conditioner, a hum, hiss, and the slow creep of automatic gain control all live in the floor, so
 *    they score nothing however loud they are; only sound that is new on top of it counts.
 * 2. **Being voiced.** A voice is made by the vocal folds opening and closing at a steady rate, 50 to
 *    400 times a second, and that shows up as a repeat in the waveform: the window matches itself
 *    shifted by one pitch period. Noise, typing, breath, a chair or a door have no such repeat. The
 *    repeat is measured after the spectrum has been flattened, bin by bin, in the range where the
 *    voice's harmonics live (80 Hz to 1.5 kHz): what stands over the room's noise is divided by its
 *    own local envelope, which leaves a voice's harmonics standing as a comb and turns the smooth
 *    rumble of a fan, which repeats a little at short lags, into white noise. Only a true peak counts,
 *    and a peak counts fully only when the pitch it was found at carries on from the frame next to it:
 *    a voice holds its pitch from one frame to the next, a chance repeat in noise does not.
 * 3. **Changing.** Nobody speaks in a sound that holds one level for a second and a half. When the
 *    speech-band energy around a frame spans only a few decibels the sound is steady, which rules
 *    out a tone or a hum that happened to switch on, and lets the floor absorb it.
 *
 * The maths of one frame (the spectrum, the bands, the repeat) is the `FrameAnalyser`, and two things
 * are built on it:
 *
 * - `VoiceStream`, the **live** detector, which hears each frame once and must say now: its floor is a
 *   running estimate that falls quickly when the room goes quieter and rises only while nothing
 *   voice-like is heard, its pitch rule looks back one frame, and its score has a short release so one
 *   weak frame inside a word does not flicker. It feeds the live phrase detector in `vad.ts`, which
 *   only has to decide whether something that could be a voice is going on, and leaves the cutting to
 *   the second listen.
 * - `hindsight.ts`, the **second listen**, which scores a finished clip knowing what came before and
 *   after each frame, and is what decides where the cuts go.
 */
import { fft } from './fft.js';
import { LIVE_KEEP, SPEECH_FRAME, SPEECH_RATE, type SpeechStream, type VoiceScorer } from './speech.js';

/** The window is two frames long. */
export const WINDOW = 2 * SPEECH_FRAME;
const N = WINDOW;
const BIN_HZ = SPEECH_RATE / N;
/** Bins in the power spectrum of a window, 0 Hz to half the sample rate. */
export const BINS = N / 2 + 1;

/** The bands compared with the floor, in Hz. */
const BANDS: readonly (readonly [number, number])[] = [
  [100, 300],
  [300, 500],
  [500, 800],
  [800, 1200],
  [1200, 1800],
  [1800, 2500],
  [2500, 3500],
  [3500, 5000],
];
export const BAND_COUNT = BANDS.length;
const BAND_BINS = BANDS.map(([lo, hi]) => [Math.round(lo / BIN_HZ), Math.round(hi / BIN_HZ)] as const);

/** The bins the repeat is measured on: where a voice's harmonics are. */
const HARMONIC_FROM = Math.round(80 / BIN_HZ);
const HARMONIC_TO = Math.round(1500 / BIN_HZ);
/** Bins either side of a bin that make up its local envelope: wider than a harmonic's peak, narrower than two harmonics. */
const ENVELOPE_BINS = 8;

/**
 * The pitch range searched for a repeat, as lags in samples. 50 Hz reaches the bottom of a deep
 * voice and the creak many speakers drop into at the end of a sentence.
 */
const PITCH_MAX_HZ = 400;
const PITCH_MIN_HZ = 50;
const LAG_MIN = Math.round(SPEECH_RATE / PITCH_MAX_HZ);
const LAG_MAX = Math.round(SPEECH_RATE / PITCH_MIN_HZ);
/** A pitch within this of the one in the frame next to it (or of its octave) carries on. */
const PITCH_HOLD = 0.15;

/** Mean band SNR (dB over the floor, each band clipped at `SNR_CLIP`) that counts for nothing / fully. */
export const SNR_ZERO = 3;
export const SNR_FULL = 10;
const SNR_CLIP = 20;
/** Repeat strength (normalised correlation at the pitch period) that counts for nothing / fully. */
export const HARMONIC_ZERO = 0.3;
export const HARMONIC_FULL = 0.6;
/** Frames of energy history for the steadiness check (1.5 s), and the dB range that is fully / not steady. */
export const STEADY_FRAMES = 47;
const STEADY_FULL_DB = 3;
const STEADY_ZERO_DB = 6;
/**
 * How fast the live floor follows the power: down always; up only once nothing voiced has been heard
 * for `QUIET_FRAMES` (half a second, longer than any consonant or breath inside a sentence), and
 * faster for a steady sound.
 */
const FLOOR_DOWN = 0.3;
const FLOOR_UP = 0.05;
const FLOOR_STEADY = 0.15;
const QUIET_FRAMES = 15;
/** Frames of power history for the backstop (2 s): the live floor is never left under the quietest of them. */
const MIN_FRAMES = 62;
/** A floor is never below this per-bin power (about -80 dBFS of noise): digital silence is not an empty room. */
export const FLOOR_MIN = 1e-6;
/** The score's release per frame: one weak frame inside a word does not drop the score to zero. */
export const RELEASE = 0.6;
const EPS = 1e-12;

const HANN = new Float64Array(N);
for (let i = 0; i < N; i++) HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

/** What the detector measured on the latest frame, for the meter and the tests. */
export interface VoiceFeatures {
  /** Mean over the bands of how far the frame stands over the floor, in dB. */
  snrDb: number;
  /** Strength of the repeat at the pitch period, 0 to 1, after the pitch-hold rule. */
  harmonicity: number;
  /** The pitch the repeat was found at, in Hz; 0 when there is none. */
  pitchHz: number;
  /** How steady the last 1.5 s have been, 0 (changing) to 1 (one level throughout). */
  steadiness: number;
  /** The pitch carried on from the previous frame. */
  holds: boolean;
  /** The frame's own score before the release. */
  raw: number;
}

export function ramp(value: number, zero: number, full: number): number {
  return Math.max(0, Math.min(1, (value - zero) / (full - zero)));
}

/** How steady a sound is from the dB range its speech-band energy spanned: 0 (changing) to 1 (one level). */
export function steadinessOf(rangeDb: number): number {
  return ramp(STEADY_ZERO_DB - rangeDb, 0, STEADY_ZERO_DB - STEADY_FULL_DB);
}

/** Whether a pitch found at `lag` carries on a pitch found at `other` (within 15 %, or an octave apart). */
export function pitchCarries(lag: number, other: number): boolean {
  if (lag <= 0 || other <= 0) return false;
  const ratio = lag / other;
  return [1, 2, 0.5].some((r) => Math.abs(ratio / r - 1) < PITCH_HOLD);
}

/** The score of a frame from the three things measured on it. */
export function voiceScore(snrDb: number, harmonicity: number, steadiness: number): number {
  return ramp(snrDb, SNR_ZERO, SNR_FULL) * ramp(harmonicity, HARMONIC_ZERO, HARMONIC_FULL) * (1 - steadiness);
}

/** Moves `floor` towards `power`: all the way down at `down` per frame, up at `up`. */
function follow(power: Float64Array, floor: Float64Array, down: number, up: number): void {
  for (let i = 0; i < floor.length; i++) {
    const target = power[i] ?? 0;
    const now = floor[i] ?? 0;
    floor[i] = Math.max(FLOOR_MIN, now + (target - now) * (target < now ? down : up));
  }
}

/**
 * The maths of one frame: the power spectrum of the window (this frame and the one before it), the
 * power in each band, and the strength of the repeat at the pitch period. It keeps the window
 * between frames and nothing else; what the floor is, and what to make of the numbers, is up to the
 * caller.
 */
export class FrameAnalyser {
  /** The power spectrum of the latest window. */
  readonly spectrum = new Float64Array(BINS);
  /** The mean power per bin of each band in the latest window. */
  readonly power = new Float64Array(BAND_COUNT);
  /** The sum of the band powers of the latest window, in dB. */
  energyDb = -Infinity;
  /** The RMS level of the latest frame alone, in dBFS. */
  levelDb = -Infinity;
  /** The lag the latest repeat was found at, in samples; 0 when there was none. */
  lag = 0;
  private readonly window = new Float64Array(N);
  private readonly re = new Float64Array(N);
  private readonly im = new Float64Array(N);
  private readonly re2 = new Float64Array(N);
  private readonly im2 = new Float64Array(N);
  private readonly excess = new Float64Array(BINS);
  private readonly whitened = new Float64Array(N);
  private readonly prefix = new Float64Array(N + 1);
  private readonly corr = new Float64Array(LAG_MAX + 2);

  /** Takes the next frame: the spectrum, the band powers, the energy and the level are of it afterwards. */
  analyse(frame: Float32Array): void {
    if (frame.length !== SPEECH_FRAME)
      throw new Error(`a frame is ${SPEECH_FRAME} samples, not ${frame.length}`);
    const { window, re, im, spectrum, power } = this;
    window.copyWithin(0, SPEECH_FRAME);
    let sum2 = 0;
    for (let i = 0; i < SPEECH_FRAME; i++) {
      const v = frame[i] ?? 0;
      window[SPEECH_FRAME + i] = v;
      sum2 += v * v;
    }
    this.levelDb = 10 * Math.log10(sum2 / SPEECH_FRAME + 1e-12);
    for (let i = 0; i < N; i++) {
      re[i] = (window[i] ?? 0) * (HANN[i] ?? 0);
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < BINS; k++) spectrum[k] = (re[k] ?? 0) ** 2 + (im[k] ?? 0) ** 2;
    let total = 0;
    for (let b = 0; b < BAND_COUNT; b++) {
      const [from, to] = BAND_BINS[b] ?? [0, 1];
      let sum = 0;
      for (let k = from; k < to; k++) sum += spectrum[k] ?? 0;
      const p = sum / (to - from);
      power[b] = p;
      total += p;
    }
    this.energyDb = 10 * Math.log10(total + EPS);
  }

  /** How far, on average over the bands, the latest window stands over `floor` (one power per band), in dB. */
  snrDb(floor: ArrayLike<number>, at = 0): number {
    let sum = 0;
    for (let b = 0; b < BAND_COUNT; b++) {
      const snr = 10 * Math.log10(((this.power[b] ?? 0) + EPS) / ((floor[at + b] ?? 0) + EPS));
      sum += Math.max(0, Math.min(SNR_CLIP, snr));
    }
    return sum / BAND_COUNT;
  }

  /**
   * The strongest repeat at a lag in the pitch range, 0 to 1, with the lag left in {@link lag}. The
   * spectrum is first flattened: each bin in the harmonic range keeps only what stands over
   * `binFloor`, and that is divided by its own local envelope (the mean of the bins around it). A
   * voice's harmonics are narrow lines over the valleys between them, so they survive as a comb; a
   * fan's rumble or hiss is a smooth continuum, so it comes out white, and white noise repeats at no
   * lag in particular. The flattened spectrum is turned back into a waveform and matched against
   * itself at every lag, each match normalised by the energy of the two stretches compared. Only a
   * lag that is a peak against its neighbours counts.
   */
  repeat(binFloor: ArrayLike<number>, at = 0): number {
    const { re, im, re2, im2, spectrum, excess, whitened, prefix, corr } = this;
    re2.fill(0);
    im2.fill(0);
    let total = 0;
    for (let k = HARMONIC_FROM - ENVELOPE_BINS; k < HARMONIC_TO + ENVELOPE_BINS; k++) {
      excess[k] = Math.max(0, (spectrum[k] ?? 0) - (binFloor[at + k] ?? FLOOR_MIN));
    }
    for (let k = HARMONIC_FROM; k < HARMONIC_TO; k++) {
      const e = excess[k] ?? 0;
      if (e <= 0) continue;
      let envelope = 0;
      for (let j = k - ENVELOPE_BINS; j <= k + ENVELOPE_BINS; j++) envelope += excess[j] ?? 0;
      envelope /= 2 * ENVELOPE_BINS + 1;
      // the flattened power is e / envelope; the gain takes the bin's own power to that
      const gain = Math.sqrt(e / (envelope * (spectrum[k] ?? EPS)));
      re2[k] = (re[k] ?? 0) * gain;
      im2[k] = -(im[k] ?? 0) * gain;
      re2[N - k] = re2[k] ?? 0;
      im2[N - k] = -(im2[k] ?? 0);
      total += e;
    }
    if (total <= EPS) {
      this.lag = 0;
      return 0;
    }
    // the conjugate's transform is the inverse transform (times N), so this is the waveform again
    fft(re2, im2);
    prefix[0] = 0;
    for (let n = 0; n < N; n++) {
      const y = re2[n] ?? 0;
      whitened[n] = y;
      prefix[n + 1] = (prefix[n] ?? 0) + y * y;
    }
    const energy = prefix[N] ?? 0;
    for (let lag = LAG_MIN - 1; lag <= LAG_MAX + 1; lag++) {
      let sum = 0;
      for (let n = 0; n + lag < N; n++) sum += (whitened[n] ?? 0) * (whitened[n + lag] ?? 0);
      const head = prefix[N - lag] ?? 0;
      const tail = energy - (prefix[lag] ?? 0);
      corr[lag] = sum / (Math.sqrt(head * tail) + EPS);
    }
    let best = 0;
    let bestLag = 0;
    for (let lag = LAG_MIN; lag <= LAG_MAX; lag++) {
      const r = corr[lag] ?? 0;
      if (r > best && r > (corr[lag - 1] ?? 0) && r >= (corr[lag + 1] ?? 0)) {
        best = r;
        bestLag = lag;
      }
    }
    this.lag = bestLag;
    return Math.min(1, best);
  }
}

/** The pitch, in Hz, of a repeat found at `lag` samples. */
export function pitchOf(lag: number): number {
  return lag > 0 ? SPEECH_RATE / lag : 0;
}

/**
 * One live stream through the detector; it remembers the room (the floor and the history) between
 * frames and hears each frame once.
 */
export class VoiceStream implements SpeechStream {
  readonly features: VoiceFeatures = {
    snrDb: 0,
    harmonicity: 0,
    pitchHz: 0,
    steadiness: 0,
    holds: false,
    raw: 0,
  };
  private readonly analyser = new FrameAnalyser();
  private frames = 0;
  /** Frames in a row with nothing voiced in them. */
  private quiet = 0;
  private smoothed = 0;
  private lastLag = 0;
  private readonly binFloor = new Float64Array(BINS);
  private readonly floor = new Float64Array(BAND_COUNT);
  private readonly history = new Float64Array(BAND_COUNT * MIN_FRAMES);
  private readonly energy = new Float64Array(STEADY_FRAMES);

  score(frame: Float32Array): number {
    const a = this.analyser;
    a.analyse(frame);
    if (this.frames === 0) {
      for (let k = 0; k < BINS; k++) this.binFloor[k] = Math.max(FLOOR_MIN, a.spectrum[k] ?? 0);
      for (let b = 0; b < BAND_COUNT; b++) this.floor[b] = Math.max(FLOOR_MIN, a.power[b] ?? 0);
    }
    const snrDb = a.snrDb(this.floor);
    const strength = a.repeat(this.binFloor);
    const lag = a.lag;
    const holds = pitchCarries(lag, this.lastLag);
    this.lastLag = lag;
    const harmonicity = lag === 0 ? 0 : strength * (holds ? 1 : 0.5);
    const steadiness = this.measureSteadiness();
    const raw = voiceScore(snrDb, harmonicity, steadiness);
    this.smoothed = Math.max(raw, this.smoothed * RELEASE);
    // a frame that could be a soft voice holds the floor down: the live detector must never let the
    // room's estimate climb into a quiet sentence, the second listen will judge it
    this.followFloor(raw >= LIVE_KEEP, steadiness);
    this.frames++;
    const f = this.features;
    f.snrDb = snrDb;
    f.harmonicity = harmonicity;
    f.pitchHz = pitchOf(lag);
    f.steadiness = steadiness;
    f.holds = holds;
    f.raw = raw;
    return this.smoothed;
  }

  /** How little the speech-band energy has moved over the last 1.5 s. */
  private measureSteadiness(): number {
    const { energy } = this;
    energy[this.frames % STEADY_FRAMES] = this.analyser.energyDb;
    if (this.frames + 1 < STEADY_FRAMES) return 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (const e of energy) {
      if (e < lo) lo = e;
      if (e > hi) hi = e;
    }
    return steadinessOf(hi - lo);
  }

  /**
   * Moves the floors after a frame: down at once when the room is quieter, up only once nothing voiced
   * has been heard for a while (faster when the sound is steady). The band floors are also never left
   * under the quietest the band has been in the last two seconds.
   */
  private followFloor(voiced: boolean, steadiness: number): void {
    const { floor, history } = this;
    const { power, spectrum } = this.analyser;
    this.quiet = voiced ? 0 : this.quiet + 1;
    const up = Math.max(this.quiet >= QUIET_FRAMES ? FLOOR_UP : 0, FLOOR_STEADY * steadiness);
    follow(spectrum, this.binFloor, FLOOR_DOWN, up);
    follow(power, floor, FLOOR_DOWN, up);
    const slot = (this.frames % MIN_FRAMES) * BAND_COUNT;
    for (let b = 0; b < BAND_COUNT; b++) history[slot + b] = power[b] ?? 0;
    if (this.frames + 1 < MIN_FRAMES) return;
    for (let b = 0; b < BAND_COUNT; b++) {
      let min = Infinity;
      for (let k = b; k < history.length; k += BAND_COUNT) if ((history[k] ?? 0) < min) min = history[k] ?? 0;
      if ((floor[b] ?? 0) < min) floor[b] = min;
    }
  }
}

/** Scores audio for a human voice, one live stream at a time. Always available; nothing to load. */
export class VoiceDetector implements VoiceScorer {
  stream(): VoiceStream {
    return new VoiceStream();
  }
}
