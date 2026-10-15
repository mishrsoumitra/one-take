/**
 * The microphone's clock as seen from the main thread, for stamping things that arrive alongside
 * the audio (camera frames).
 *
 * The audio thread produces one block every `blockMs`, but the main thread hears about them in
 * fits and starts: a busy moment holds several back and then delivers them together. Reading the
 * clock as "the last block's time plus a little" therefore stalls during a hold-up and then jumps,
 * and two frames that arrived 50 ms apart during the hold-up get the same stamp.
 *
 * Instead the clock keeps an estimate of the wall time at which block 0 began, the *origin*: every
 * block says `now − seen × blockMs`, and since a block can arrive late but never early, the smallest
 * of those over the last couple of seconds is the truth. Wall time minus the origin is then the
 * microphone time at any instant, hold-ups or not, and the window lets the estimate follow a slow
 * drift between the two clocks.
 */
export class BlockClock {
  private origin = Infinity;
  private bucketStart = -Infinity;
  private bucketMin = Infinity;
  private prevMin = Infinity;
  /** Microphone time at the latest block delivered. */
  private latest = 0;

  constructor(
    readonly blockMs: number,
    /** How long the origin is remembered: two windows at most, then a lower (earlier) one is forgotten. */
    private readonly windowMs = 1000,
  ) {}

  /** A block arrived: `seen` blocks have been delivered so far, this one at wall time `nowMs`. */
  tick(seen: number, nowMs: number): void {
    const candidate = nowMs - seen * this.blockMs;
    if (nowMs - this.bucketStart >= this.windowMs) {
      this.prevMin = this.bucketMin;
      this.bucketMin = candidate;
      this.bucketStart = nowMs;
    } else if (candidate < this.bucketMin) {
      this.bucketMin = candidate;
    }
    this.origin = Math.min(this.prevMin, this.bucketMin);
    this.latest = seen * this.blockMs;
  }

  /**
   * Microphone time at wall time `nowMs`, in milliseconds; null before the first block. Never more
   * than a window ahead of the latest block: a longer silence from the audio thread is not a
   * hold-up but a stall, and stamps wait for it.
   */
  at(nowMs: number): number | null {
    if (!Number.isFinite(this.origin)) return null;
    return Math.min(nowMs - this.origin, this.latest + this.windowMs);
  }

  /** Microphone time of the latest block delivered, in milliseconds. */
  get latestMs(): number {
    return this.latest;
  }
}
