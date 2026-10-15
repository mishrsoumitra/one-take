/**
 * The tape: the microphone as it is, before any filter, kept for as long as a phrase may still
 * want its stretch of it.
 *
 * The app hears the microphone through the noise filter, and the phrase detector counts the
 * filtered blocks (`vad.seen`). A second capture node on the unfiltered source delivers the same
 * blocks a filter's delay earlier, into this tape. When a phrase is stored, the detector says which
 * filtered blocks it is made of; the same stretch of the tape, moved earlier by the delay, is the
 * phrase as the microphone heard it (`Segment.raw`), sample for sample in step with the filtered
 * version. The delay is a constant per filter (see `audio/mic.ts`), and the stretch is checked
 * against the filtered phrase by correlation and nudged when the two disagree, so a filter that
 * changed mid-phrase, or a block that went missing, never leaves the two versions out of step.
 *
 * Nothing in this file touches the browser; the tests run it in Node.
 */

export interface SampleRange {
  from: number;
  to: number;
}

/** Blocks the tape keeps beyond what is asked for, so a phrase that reaches a little back still has its start. */
const SLACK_BLOCKS = 16;

export class Tape {
  private blocks: Float32Array[] = [];
  /** The stream index of `blocks[0]`. */
  private first = 0;
  private _seen = 0;

  constructor(readonly blockSize: number) {}

  /** Blocks taken so far: the tape's own clock, in step with the detector's. */
  get seen(): number {
    return this._seen;
  }

  /** Blocks held right now. */
  get held(): number {
    return this.blocks.length;
  }

  push(block: Float32Array): void {
    this.blocks.push(block);
    this._seen++;
  }

  /** Lets go of every block before `keepFrom` (a block index), bar a little slack. */
  prune(keepFrom: number): void {
    const drop = Math.min(this.blocks.length, keepFrom - SLACK_BLOCKS - this.first);
    if (drop <= 0) return;
    this.blocks.splice(0, drop);
    this.first += drop;
  }

  reset(): void {
    this.blocks = [];
    this.first = 0;
    this._seen = 0;
  }

  /** The samples `[from, to)` of the stream, zeros where the tape has nothing (before its start, or already let go of). */
  read(from: number, to: number): Float32Array {
    const out = new Float32Array(Math.max(0, to - from));
    if (out.length === 0) return out;
    const size = this.blockSize;
    const firstBlock = Math.max(this.first, Math.floor(from / size));
    const lastBlock = Math.min(this.first + this.blocks.length - 1, Math.floor((to - 1) / size));
    for (let b = firstBlock; b <= lastBlock; b++) {
      const block = this.blocks[b - this.first];
      if (!block) continue;
      const start = b * size;
      const lo = Math.max(from, start);
      const hi = Math.min(to, start + block.length);
      for (let i = lo; i < hi; i++) out[i - from] = block[i - start] ?? 0;
    }
    return out;
  }
}

/** The stretch of the tape, in samples, that lines up with filtered blocks `[from, to)` delayed by `delay` samples. */
export function rawRange(
  blocks: { from: number; to: number },
  blockSize: number,
  delay: number,
): SampleRange {
  return { from: blocks.from * blockSize - delay, to: blocks.to * blockSize - delay };
}

/** The loudest `length` samples of a clip, as a start index, for a correlation that should not land on a pause. */
export function loudestWindow(samples: Float32Array, length: number): number {
  const n = samples.length;
  if (n <= length) return 0;
  const step = Math.max(1, Math.floor(length / 8));
  let best = 0;
  let bestEnergy = -1;
  for (let start = 0; start + length <= n; start += step) {
    let e = 0;
    for (let i = start; i < start + length; i++) e += (samples[i] ?? 0) ** 2;
    if (e > bestEnergy) {
      bestEnergy = e;
      best = start;
    }
  }
  return best;
}

/** `samples` averaged over runs of `factor`. */
function decimate(samples: Float32Array, factor: number): Float32Array {
  const n = Math.floor(samples.length / factor);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < factor; k++) s += samples[i * factor + k] ?? 0;
    out[i] = s / factor;
  }
  return out;
}

/** The normalised correlation of `a` with `b` shifted by `lag` (`b[i + lag]` against `a[i]`). */
function correlation(a: Float32Array, b: Float32Array, lag: number, length: number): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < length; i++) {
    const x = a[i] ?? 0;
    const y = b[i + lag] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

export interface Lag {
  /** Samples to add to the nominal start: the candidate's best match of the reference starts `lag` samples in. */
  lag: number;
  /** The normalised correlation at that lag: 1 is a perfect match, under about 0.3 says nothing matched. */
  peak: number;
}

/** The correlation a lag needs before it overrides the nominal delay. */
export const LAG_TRUSTED = 0.3;
/** The search is done at this fraction of the rate first, then refined at the full rate. */
const COARSE = 6;
/** How much of the reference is correlated: its loudest stretch of this many seconds, at most. */
const WINDOW_SEC = 1.5;

/**
 * Where `reference` (a filtered phrase) starts inside `candidate` (the tape around it, `maxShift`
 * samples longer on both sides), as an offset from `maxShift`: 0 means the nominal delay was right,
 * a positive lag means the tape ran that much later. A coarse search at a sixth of the rate over the
 * whole range, then a fine one at the full rate around its best, over the reference's loudest
 * second and a half.
 */
export function bestLag(
  reference: Float32Array,
  candidate: Float32Array,
  rate: number,
  maxShift: number,
): Lag {
  const window = Math.min(reference.length, Math.round(rate * WINDOW_SEC));
  if (window < COARSE * 8 || candidate.length < reference.length) return { lag: 0, peak: 0 };
  const start = loudestWindow(reference, window);
  const ref = reference.subarray(start, start + window);
  const cand = candidate.subarray(start, start + window + 2 * maxShift);
  const refC = decimate(ref, COARSE);
  const candC = decimate(cand, COARSE);
  const maxC = Math.floor(maxShift / COARSE);
  let bestC = 0;
  let peakC = -Infinity;
  for (let lag = 0; lag <= 2 * maxC; lag++) {
    const c = correlation(refC, candC, lag, refC.length);
    if (c > peakC) {
      peakC = c;
      bestC = lag;
    }
  }
  let best = bestC * COARSE;
  let peak = -Infinity;
  const lo = Math.max(0, best - COARSE);
  const hi = Math.min(2 * maxShift, best + COARSE);
  for (let lag = lo; lag <= hi; lag++) {
    const c = correlation(ref, cand, lag, window);
    if (c > peak) {
      peak = c;
      best = lag;
    }
  }
  return { lag: best - maxShift, peak };
}

/**
 * The phrase as the microphone heard it: the tape's stretch for the phrase's blocks, moved by the
 * filter's delay and nudged by up to `maxShift` samples to where it best matches the filtered
 * phrase. Returns the samples (as long as `filtered`) and the lag that was used.
 */
export function takeRaw(
  tape: Tape,
  filtered: Float32Array,
  blocks: { from: number; to: number },
  delay: number,
  maxShift: number,
  rate: number,
): { samples: Float32Array; lag: Lag } {
  const nominal = rawRange(blocks, tape.blockSize, delay);
  const around = tape.read(nominal.from - maxShift, nominal.to + maxShift);
  const lag = bestLag(filtered, around, rate, maxShift);
  const shift = lag.peak >= LAG_TRUSTED ? lag.lag : 0;
  const from = maxShift + shift;
  return { samples: around.slice(from, from + filtered.length), lag: { lag: shift, peak: lag.peak } };
}
