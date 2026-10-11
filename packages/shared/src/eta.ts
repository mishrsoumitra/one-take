/**
 * Time-left estimates that start sensible and stay calm.
 *
 * The usual estimate, work left ÷ average rate since the start, is why a progress bar can open with
 * "1 h 30 min left" and finish thirty seconds later: at the start the average is dominated by set-up
 * time during which nothing counted as progress, so the rate looks tiny and the time left enormous.
 * Three things fix that here:
 *
 * 1. Until enough has been measured, the figure comes from the model made before the export started
 *    (the resource map in the dialog), and is labelled as such.
 * 2. The rate is measured over a sliding window of recent samples, so the warm-up drops out of the
 *    figure as soon as it is over, and a slowdown or speed-up shows within seconds.
 * 3. The figure shown follows a measured drop quickly but a measured rise only slowly, so it counts
 *    down instead of jumping around.
 *
 * Everything is pure arithmetic on (time, fraction done) samples, so it is unit-tested with a clock
 * of its own; the client feeds it `performance.now()`.
 */

/** Where a time-left figure comes from. */
export type EtaBasis = 'model' | 'measuring' | 'measured';

export interface Eta {
  /** Seconds left; null when nothing sensible can be said yet. */
  seconds: number | null;
  basis: EtaBasis | null;
}

export interface StageEtaOptions {
  /** Seconds of recent progress the rate is measured over. */
  windowSec?: number;
  /** Fraction of the work before which the measurement is not used at all. */
  minFraction?: number;
  /** Fraction of the work after which the measurement counts fully (the model no longer does). */
  settledFraction?: number;
  /** Seconds that must have passed since the first progress before the measurement is used. */
  minElapsedSec?: number;
}

const DEFAULTS: Required<StageEtaOptions> = {
  windowSec: 8,
  minFraction: 0.02,
  settledFraction: 0.12,
  minElapsedSec: 2,
};

interface Sample {
  t: number;
  f: number;
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** The time left for one stage of work, from a model estimate and progress samples. */
export class StageEta {
  private readonly options: Required<StageEtaOptions>;
  private samples: Sample[] = [];
  /** The first sample with any progress at all: the end of the warm-up. */
  private started: Sample | null = null;
  private shown: number | null = null;
  private shownAt: number | null = null;
  private basis: EtaBasis | null = null;

  constructor(
    /** What the plan expected this stage to take; null when there is no model. */
    readonly modelSeconds: number | null,
    options: StageEtaOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** Records that `fraction` (0..1) of the stage was done at `atSec`, and returns the estimate. */
  update(atSec: number, fraction: number): Eta {
    const f = clamp01(fraction);
    if (f > 0 && this.started === null) {
      // The warm-up is over: what came before was not work, so it must not dilute the rate.
      this.started = { t: atSec, f };
      this.samples = [];
    }
    this.samples.push({ t: atSec, f });
    this.prune(atSec);
    const raw = this.estimate(atSec, f);
    this.smooth(raw, atSec);
    return this.current(atSec);
  }

  /** The estimate as of `atSec`: the figure last shown, counted down by the time since. */
  current(atSec: number): Eta {
    if (this.shown === null || this.shownAt === null) return { seconds: null, basis: null };
    return { seconds: Math.max(0, this.shown - (atSec - this.shownAt)), basis: this.basis };
  }

  /** Work per second measured over the recent window; null until two samples differ. */
  private measuredRate(): number | null {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last || last === first) return null;
    const dt = last.t - first.t;
    const df = last.f - first.f;
    if (dt <= 0 || df <= 0) return null;
    return df / dt;
  }

  private estimate(atSec: number, f: number): { seconds: number | null; basis: EtaBasis | null } {
    const { minFraction, settledFraction, minElapsedSec } = this.options;
    const modelLeft = this.modelSeconds === null ? null : Math.max(0, this.modelSeconds) * (1 - f);
    const rate = this.measuredRate();
    const measuredLeft = rate !== null ? (1 - f) / rate : null;
    const elapsed = this.started ? atSec - this.started.t : 0;
    if (measuredLeft === null || elapsed < minElapsedSec || f <= minFraction) {
      return { seconds: modelLeft, basis: modelLeft === null ? null : 'model' };
    }
    const weight = clamp01((f - minFraction) / (settledFraction - minFraction));
    if (modelLeft === null) return { seconds: measuredLeft, basis: 'measured' };
    return {
      seconds: weight * measuredLeft + (1 - weight) * modelLeft,
      basis: weight >= 1 ? 'measured' : 'measuring',
    };
  }

  /** Follows a drop quickly and a rise slowly, so the figure counts down rather than jitters. */
  private smooth(raw: { seconds: number | null; basis: EtaBasis | null }, atSec: number): void {
    this.basis = raw.basis;
    if (raw.seconds === null) {
      this.shown = null;
      this.shownAt = null;
      return;
    }
    const previous = this.current(atSec).seconds;
    if (previous === null || raw.basis === 'model') this.shown = raw.seconds;
    else if (raw.seconds < previous) this.shown = previous + (raw.seconds - previous) * 0.5;
    else this.shown = previous + (raw.seconds - previous) * 0.15;
    this.shownAt = atSec;
  }

  /** Keeps the samples of the last window, and always at least three so a quiet moment has a rate. */
  private prune(atSec: number): void {
    const cutoff = atSec - this.options.windowSec;
    while (this.samples.length > 3) {
      const next = this.samples[1];
      if (!next || next.t > cutoff) break;
      this.samples.shift();
    }
  }
}

/** A rate (units per second) measured over the last `windowSec` of samples, for live meters. */
export class WindowedRate {
  private samples: { t: number; v: number }[] = [];

  constructor(private readonly windowSec = 3) {}

  add(atSec: number, value: number): void {
    this.samples.push({ t: atSec, v: value });
    const cutoff = atSec - this.windowSec;
    while (this.samples.length > 2) {
      const next = this.samples[1];
      if (!next || next.t > cutoff) break;
      this.samples.shift();
    }
  }

  /** Units per second over the window; null until two samples at least half a second apart exist. */
  rate(): number | null {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last || last === first) return null;
    const dt = last.t - first.t;
    if (dt < 0.5) return null;
    return Math.max(0, (last.v - first.v) / dt);
  }

  reset(): void {
    this.samples = [];
  }
}

/**
 * A time left for people: `2 h 5 min`, `12 min`, `4 min 30 s`, `45 s`, `a few seconds`. Coarser the
 * further away, so the figure does not flicker on every update.
 */
export function formatEta(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 8) return 'a few seconds';
  if (s < 57.5) return `${Math.max(5, Math.round(s / 5) * 5)} s`;
  const minutes = s / 60;
  if (minutes < 10) {
    const m = Math.floor(minutes);
    const rest = Math.round((s - m * 60) / 10) * 10;
    if (rest >= 60) return `${m + 1} min`;
    return rest > 0 ? `${m} min ${rest} s` : `${m} min`;
  }
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes - h * 60);
  if (m >= 60) return `${h + 1} h`;
  return m > 0 ? `${h} h ${m} min` : `${h} h`;
}
