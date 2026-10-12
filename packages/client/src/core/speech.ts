/**
 * Voice scoring: how likely it is that a stretch of audio is someone speaking, as a number from 0 to
 * 1 every 32 ms. The number comes from a neural voice model (Silero VAD, see `silero.ts`); this file
 * is the plumbing around it that is the same whatever runs the model.
 *
 * The model wants 16 kHz mono in frames of 512 samples. The microphone gives 48 kHz (or 44.1 kHz)
 * in 10 ms blocks, so blocks are low-passed, resampled and gathered into frames here. A stored clip
 * is scored the same way, frame by frame from its first sample to its last.
 *
 * Nothing in this file touches the browser; the tests run it in Node with the same model.
 */

export const SPEECH_RATE = 16000;
/** Samples per frame at {@link SPEECH_RATE}: 32 ms. */
export const SPEECH_FRAME = 512;
export const SPEECH_FRAME_SEC = SPEECH_FRAME / SPEECH_RATE;
/** A phrase may start once the score reaches this. */
export const SPEECH_START = 0.5;
/** A phrase keeps going while the score stays above this; the gap down to {@link SPEECH_START} is hysteresis. */
export const SPEECH_KEEP = 0.35;

/** One stream of audio through the model; the model remembers the stream between frames. */
export interface SpeechStream {
  /** Scores one frame of {@link SPEECH_FRAME} samples at {@link SPEECH_RATE}. */
  score(frame: Float32Array): Promise<number>;
}

export interface SpeechModel {
  /** A fresh stream with no memory of earlier audio. */
  stream(): SpeechStream;
}

/** The filter's corner as a fraction of the output rate; 0.45 keeps 7.2 kHz at 16 kHz. */
const CUTOFF = 0.45;

/**
 * Converts audio to a lower sample rate, block by block, with a 4th-order Butterworth low-pass in
 * front so that what is above the new rate's half does not fold back into the voice band. Linear
 * interpolation after the filter is plenty for a detector that listens for voices rather than for
 * fidelity.
 */
export class Downsampler {
  private readonly ratio: number;
  private readonly stages: Biquad[];
  /** Where the next output sample falls, in input samples, counted from the last sample of the previous block. */
  private pos = 1;
  private last = 0;

  constructor(
    readonly from: number,
    readonly to: number,
  ) {
    this.ratio = from / to;
    // two biquads make a 4th-order Butterworth; these are its two Q values
    this.stages =
      from > to ? [new Biquad((CUTOFF * to) / from, 0.5412), new Biquad((CUTOFF * to) / from, 1.3066)] : [];
  }

  /** Output samples for `input`; the count varies by one from block to block as the phase carries over. */
  process(input: Float32Array): Float32Array {
    if (this.from === this.to) return input;
    const filtered = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      let v = input[i] ?? 0;
      for (const stage of this.stages) v = stage.step(v);
      filtered[i] = v;
    }
    const n = filtered.length;
    const out: number[] = [];
    // virtual index 0 is the previous block's last sample, index k (1..n) is filtered[k - 1]
    while (this.pos < n) {
      const j = Math.floor(this.pos);
      const t = this.pos - j;
      const a = j === 0 ? this.last : (filtered[j - 1] ?? 0);
      const b = filtered[j] ?? a;
      out.push(a + (b - a) * t);
      this.pos += this.ratio;
    }
    this.pos -= n;
    this.last = filtered[n - 1] ?? this.last;
    return Float32Array.from(out);
  }
}

/** One second-order low-pass section (RBJ cookbook), direct form 1. */
class Biquad {
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  /** `cutoff` is a fraction of the sample rate. */
  constructor(cutoff: number, q: number) {
    const w0 = 2 * Math.PI * cutoff;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (1 - cos) / 2 / a0;
    this.b1 = (1 - cos) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  step(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/**
 * Scores the microphone as it is heard. `push` takes every block; `prob` is the score of the latest
 * frame, so it lags the block just pushed by a frame or so (the detector's pre-roll covers that).
 * `prob` turns null if the model fails, and the detector then falls back to listening for level.
 */
export class SpeechScorer {
  /** The latest score, 0 until the first frame is in, null once the model has failed. */
  prob: number | null = 0;
  /** Frames scored so far in this stream. */
  frames = 0;
  private stream: SpeechStream;
  private down: Downsampler | null = null;
  private frame = new Float32Array(SPEECH_FRAME);
  private filled = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly model: SpeechModel) {
    this.stream = model.stream();
  }

  get failed(): boolean {
    return this.prob === null;
  }

  push(block: Float32Array, sampleRate: number): void {
    if (this.prob === null) return;
    if (this.down?.from !== sampleRate) this.down = new Downsampler(sampleRate, SPEECH_RATE);
    for (const sample of this.down.process(block)) {
      this.frame[this.filled++] = sample;
      if (this.filled === SPEECH_FRAME) {
        this.enqueue(this.frame);
        this.frame = new Float32Array(SPEECH_FRAME);
        this.filled = 0;
      }
    }
  }

  /** Forget the stream so far (a new microphone session). */
  reset(): void {
    this.stream = this.model.stream();
    this.down = null;
    this.filled = 0;
    this.prob = 0;
    this.frames = 0;
  }

  /** Resolves once every frame pushed so far has been scored. */
  settle(): Promise<void> {
    return this.tail.then(() => undefined);
  }

  private enqueue(frame: Float32Array): void {
    const scored = this.stream.score(frame).then(
      (p) => {
        if (this.prob !== null) {
          this.prob = p;
          this.frames++;
        }
      },
      (error: unknown) => {
        console.warn('Voice model failed; listening for level only', error);
        this.prob = null;
      },
    );
    this.tail = scored;
  }
}

/** Keeps the page responsive while a long clip is scored: this many frames between yields. */
const YIELD_EVERY = 64;

/**
 * Scores a stored clip from start to end: one number per frame of {@link SPEECH_FRAME_SEC} seconds.
 * The last, partial frame is padded with silence so the clip's end is covered too. Works in chunks
 * so an hour-long clip never has to exist as floats all at once, and yields to the event loop now
 * and then so progress can be shown.
 */
export async function scoreClip(
  model: SpeechModel,
  pcm: Int16Array,
  sampleRate: number,
  onProgress?: (secondsDone: number) => void,
): Promise<Float32Array> {
  const stream = model.stream();
  const down = new Downsampler(sampleRate, SPEECH_RATE);
  const probs: number[] = [];
  const frame = new Float32Array(SPEECH_FRAME);
  let filled = 0;
  const chunk = Math.max(1, Math.round(sampleRate));
  for (let at = 0; at < pcm.length; at += chunk) {
    const floats = new Float32Array(Math.min(chunk, pcm.length - at));
    for (let i = 0; i < floats.length; i++) floats[i] = (pcm[at + i] ?? 0) / 32768;
    for (const sample of down.process(floats)) {
      frame[filled++] = sample;
      if (filled === SPEECH_FRAME) {
        probs.push(await stream.score(frame));
        filled = 0;
        if (probs.length % YIELD_EVERY === 0) await new Promise<void>((r) => setTimeout(r, 0));
      }
    }
    onProgress?.((at + floats.length) / sampleRate);
  }
  if (filled > 0) {
    frame.fill(0, filled);
    probs.push(await stream.score(frame));
  }
  return Float32Array.from(probs);
}
