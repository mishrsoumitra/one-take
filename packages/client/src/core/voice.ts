/**
 * The voice detector: tells a human voice from the rest of what a microphone hears, by arithmetic
 * alone. There is no model, nothing trained and no weights; every number in this file is a rule
 * that can be read and argued with.
 *
 * It listens to 16 kHz audio in frames of 512 samples (32 ms), looking at each frame together with
 * the one before it through a 64 ms window, and gives each frame a score from 0 (no voice) to 1 (a
 * voice), the shape of answer the live detector in `vad.ts` and the pause remover in `silence.ts`
 * work from. Three things go into the score:
 *
 * 1. **Standing out from the room.** The window's power in eight bands between 100 Hz and 5 kHz is
 *    compared with a running estimate of the room's noise in each band, the floor. A fan, an air
 *    conditioner, a hum, hiss, and the slow creep of automatic gain control all live in the floor, so
 *    they score nothing however loud they are; only sound that is new on top of it counts. The floor
 *    falls quickly when the room goes quieter, rises only while nothing voice-like is heard (so it
 *    never climbs into a sentence being spoken), and as a backstop is never left far under the
 *    quietest the room has been in the last two seconds, so a sound that stays on long enough becomes
 *    the room's new noise.
 * 2. **Being voiced.** A voice is made by the vocal folds opening and closing at a steady rate, 70 to
 *    400 times a second, and that shows up as a repeat in the waveform: the window matches itself
 *    shifted by one pitch period. Noise, typing, breath, a chair or a door have no such repeat. The
 *    repeat is measured after the spectrum has been flattened, bin by bin, in the range where the
 *    voice's harmonics live (80 Hz to 1.5 kHz): what stands over the room's noise is divided by its
 *    own local envelope, which leaves a voice's harmonics standing as a comb and turns the smooth
 *    rumble of a fan, which repeats a little at short lags, into white noise. Only a true peak counts, and
 *    a peak counts fully only when the pitch it was found at carries on from the frame before: a voice
 *    holds its pitch from one frame to the next, a chance repeat in noise does not.
 * 3. **Changing.** Nobody speaks in a sound that holds one level for a second and a half. When the
 *    speech-band energy of the last 1.5 s spans only a few decibels the sound is steady, which rules
 *    out a tone or a hum that happened to switch on, and lets the floor absorb it.
 *
 * The score is the product of the three, with a short release so one weak frame inside a word does
 * not flicker. Whispering (nothing voiced) is not heard as a voice, and a fricative like "s" on its own
 * is not either; that is why the live detector keeps a pre-roll, a hangover and a tail around what it
 * hears.
 */
import { fft } from './fft.js';
import { SPEECH_FRAME, SPEECH_KEEP, SPEECH_RATE, type SpeechStream, type VoiceScorer } from './speech.js';

/** The window is two frames long. */
const N = 2 * SPEECH_FRAME;
const BIN_HZ = SPEECH_RATE / N;

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
const BAND_BINS = BANDS.map(([lo, hi]) => [Math.round(lo / BIN_HZ), Math.round(hi / BIN_HZ)] as const);

/** The bins the repeat is measured on: where a voice's harmonics are. */
const HARMONIC_FROM = Math.round(80 / BIN_HZ);
const HARMONIC_TO = Math.round(1500 / BIN_HZ);
/** Bins either side of a bin that make up its local envelope: wider than a harmonic's peak, narrower than two harmonics. */
const ENVELOPE_BINS = 8;

/** The pitch range searched for a repeat, as lags in samples. */
const PITCH_MAX_HZ = 400;
const PITCH_MIN_HZ = 70;
const LAG_MIN = Math.round(SPEECH_RATE / PITCH_MAX_HZ);
const LAG_MAX = Math.round(SPEECH_RATE / PITCH_MIN_HZ);
/** A pitch within this of the previous frame's (or of its octave) carries on. */
const PITCH_HOLD = 0.15;

/** Mean band SNR (dB over the floor, each band clipped at `SNR_CLIP`) that counts for nothing / fully. */
const SNR_ZERO = 3;
const SNR_FULL = 10;
const SNR_CLIP = 20;
/** Repeat strength (normalised correlation at the pitch period) that counts for nothing / fully. */
const HARMONIC_ZERO = 0.3;
const HARMONIC_FULL = 0.6;
/** Frames of energy history for the steadiness check (1.5 s), and the dB range that is fully / not steady. */
const STEADY_FRAMES = 47;
const STEADY_FULL_DB = 3;
const STEADY_ZERO_DB = 6;
/**
 * How fast the floor follows the power: down always; up only once nothing voiced has been heard for
 * `QUIET_FRAMES` (half a second, longer than any consonant or breath inside a sentence), and faster
 * for a steady sound.
 */
const FLOOR_DOWN = 0.3;
const FLOOR_UP = 0.05;
const FLOOR_STEADY = 0.15;
const QUIET_FRAMES = 15;
/** Frames of power history for the backstop (2 s): the floor is never left under the quietest of them. */
const MIN_FRAMES = 62;
/** The floor is never below this per-bin power (about -80 dBFS of noise): digital silence is not an empty room. */
const FLOOR_MIN = 1e-6;
/** The score's release per frame: one weak frame inside a word does not drop the score to zero. */
const RELEASE = 0.6;
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

function ramp(value: number, zero: number, full: number): number {
  return Math.max(0, Math.min(1, (value - zero) / (full - zero)));
}

/** Moves `floor` towards `power`: all the way down at `down` per frame, up at `up`. */
function follow(power: Float64Array, floor: Float64Array, down: number, up: number): void {
  for (let i = 0; i < floor.length; i++) {
    const target = power[i] ?? 0;
    const now = floor[i] ?? 0;
    floor[i] = Math.max(FLOOR_MIN, now + (target - now) * (target < now ? down : up));
  }
}

/** One stream through the detector; it remembers the room (the floor and the history) between frames. */
export class VoiceStream implements SpeechStream {
  readonly features: VoiceFeatures = {
    snrDb: 0,
    harmonicity: 0,
    pitchHz: 0,
    steadiness: 0,
    holds: false,
    raw: 0,
  };
  private frames = 0;
  /** Frames in a row with nothing voiced in them. */
  private quiet = 0;
  private smoothed = 0;
  private lastLag = 0;
  private readonly window = new Float64Array(N);
  private readonly re = new Float64Array(N);
  private readonly im = new Float64Array(N);
  private readonly re2 = new Float64Array(N);
  private readonly im2 = new Float64Array(N);
  private readonly spectrum = new Float64Array(N / 2 + 1);
  private readonly binFloor = new Float64Array(N / 2 + 1);
  private readonly excess = new Float64Array(N / 2 + 1);
  private readonly whitened = new Float64Array(N);
  private readonly prefix = new Float64Array(N + 1);
  private readonly corr = new Float64Array(LAG_MAX + 2);
  private readonly power = new Float64Array(BANDS.length);
  private readonly floor = new Float64Array(BANDS.length);
  private readonly history = new Float64Array(BANDS.length * MIN_FRAMES);
  private readonly energy = new Float64Array(STEADY_FRAMES);

  score(frame: Float32Array): number {
    if (frame.length !== SPEECH_FRAME)
      throw new Error(`a frame is ${SPEECH_FRAME} samples, not ${frame.length}`);
    this.analyse(frame);
    const snrDb = this.measureBands();
    const { harmonicity, pitchHz, holds } = this.measureRepeat();
    const steadiness = this.measureSteadiness();
    const raw =
      ramp(snrDb, SNR_ZERO, SNR_FULL) * ramp(harmonicity, HARMONIC_ZERO, HARMONIC_FULL) * (1 - steadiness);
    this.smoothed = Math.max(raw, this.smoothed * RELEASE);
    this.followFloor(raw >= SPEECH_KEEP, steadiness);
    this.frames++;
    const f = this.features;
    f.snrDb = snrDb;
    f.harmonicity = harmonicity;
    f.pitchHz = pitchHz;
    f.steadiness = steadiness;
    f.holds = holds;
    f.raw = raw;
    return this.smoothed;
  }

  /** The power spectrum of the window: the previous frame and this one, under a Hann window. */
  private analyse(frame: Float32Array): void {
    const { window, re, im, spectrum } = this;
    window.copyWithin(0, SPEECH_FRAME);
    for (let i = 0; i < SPEECH_FRAME; i++) window[SPEECH_FRAME + i] = frame[i] ?? 0;
    for (let i = 0; i < N; i++) {
      re[i] = (window[i] ?? 0) * (HANN[i] ?? 0);
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < spectrum.length; k++) spectrum[k] = (re[k] ?? 0) ** 2 + (im[k] ?? 0) ** 2;
    if (this.frames === 0) {
      for (let k = 0; k < spectrum.length; k++) this.binFloor[k] = Math.max(FLOOR_MIN, spectrum[k] ?? 0);
    }
  }

  /** The power of each band and how far, on average, it stands over the floor. */
  private measureBands(): number {
    const { spectrum, power, floor } = this;
    let snrSum = 0;
    for (let b = 0; b < BANDS.length; b++) {
      const [from, to] = BAND_BINS[b] ?? [0, 1];
      let sum = 0;
      for (let k = from; k < to; k++) sum += spectrum[k] ?? 0;
      const p = sum / (to - from);
      power[b] = p;
      if (this.frames === 0) floor[b] = Math.max(FLOOR_MIN, p);
      const snr = 10 * Math.log10((p + EPS) / ((floor[b] ?? 0) + EPS));
      snrSum += Math.max(0, Math.min(SNR_CLIP, snr));
    }
    return snrSum / BANDS.length;
  }

  /**
   * The strongest repeat at a lag in the pitch range. The spectrum is first flattened: each bin in
   * the harmonic range keeps only what stands over the room's floor, and that is divided by its own
   * local envelope (the mean of the bins around it). A voice's harmonics are narrow lines over the
   * valleys between them, so they survive as a comb; a fan's rumble or hiss is a smooth continuum, so
   * it comes out white, and white noise repeats at no lag in particular. The flattened spectrum is
   * turned back into a waveform and matched against itself at every lag, each match normalised by the
   * energy of the two stretches compared. Only a lag that is a peak against its neighbours counts,
   * and a peak whose pitch does not carry on from the previous frame counts half.
   */
  private measureRepeat(): { harmonicity: number; pitchHz: number; holds: boolean } {
    const { re, im, re2, im2, spectrum, binFloor, excess, whitened, prefix, corr } = this;
    re2.fill(0);
    im2.fill(0);
    let total = 0;
    for (let k = HARMONIC_FROM - ENVELOPE_BINS; k < HARMONIC_TO + ENVELOPE_BINS; k++) {
      excess[k] = Math.max(0, (spectrum[k] ?? 0) - (binFloor[k] ?? FLOOR_MIN));
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
      this.lastLag = 0;
      return { harmonicity: 0, pitchHz: 0, holds: false };
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
    const last = this.lastLag;
    this.lastLag = bestLag;
    if (bestLag === 0) return { harmonicity: 0, pitchHz: 0, holds: false };
    const ratio = last > 0 ? bestLag / last : 0;
    const holds = [1, 2, 0.5].some((r) => Math.abs(ratio / r - 1) < PITCH_HOLD);
    return { harmonicity: Math.min(1, best) * (holds ? 1 : 0.5), pitchHz: SPEECH_RATE / bestLag, holds };
  }

  /** How little the speech-band energy has moved over the last 1.5 s. */
  private measureSteadiness(): number {
    const { energy, power } = this;
    let total = 0;
    for (let b = 0; b < BANDS.length; b++) total += power[b] ?? 0;
    energy[this.frames % STEADY_FRAMES] = 10 * Math.log10(total + EPS);
    if (this.frames + 1 < STEADY_FRAMES) return 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (const e of energy) {
      if (e < lo) lo = e;
      if (e > hi) hi = e;
    }
    return ramp(STEADY_ZERO_DB - (hi - lo), 0, STEADY_ZERO_DB - STEADY_FULL_DB);
  }

  /**
   * Moves the floors after a frame: down at once when the room is quieter, up only once nothing voiced
   * has been heard for a while (faster when the sound is steady). The band floors are also never left
   * under the quietest the band has been in the last two seconds.
   */
  private followFloor(voiced: boolean, steadiness: number): void {
    const { power, floor, history } = this;
    this.quiet = voiced ? 0 : this.quiet + 1;
    const up = Math.max(this.quiet >= QUIET_FRAMES ? FLOOR_UP : 0, FLOOR_STEADY * steadiness);
    follow(this.spectrum, this.binFloor, FLOOR_DOWN, up);
    follow(power, floor, FLOOR_DOWN, up);
    const slot = (this.frames % MIN_FRAMES) * BANDS.length;
    for (let b = 0; b < BANDS.length; b++) history[slot + b] = power[b] ?? 0;
    if (this.frames + 1 < MIN_FRAMES) return;
    for (let b = 0; b < BANDS.length; b++) {
      let min = Infinity;
      for (let k = b; k < history.length; k += BANDS.length)
        if ((history[k] ?? 0) < min) min = history[k] ?? 0;
      if ((floor[b] ?? 0) < min) floor[b] = min;
    }
  }
}

/** Scores audio for a human voice, one stream at a time. Always available; nothing to load. */
export class VoiceDetector implements VoiceScorer {
  stream(): VoiceStream {
    return new VoiceStream();
  }
}
