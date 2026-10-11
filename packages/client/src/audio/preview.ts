import { segmentToFloat } from '../core/pcm.js';
import { type Timeline } from '../core/timeline.js';

import { acquireAudio, releaseAudio } from './context.js';

export interface PreviewCallbacks {
  /** Called every animation frame with the item currently playing and the position in seconds. */
  onTick: (itemIndex: number, nowSec: number, totalSec: number) => void;
  onEnd: () => void;
}

/** Plays a timeline through Web Audio, scheduling phrases a couple of seconds ahead. */
export class PreviewPlayer {
  private context: AudioContext | null = null;
  private sources: AudioBufferSourceNode[] = [];
  private raf = 0;
  private timeline: Timeline | null = null;
  private startAt = 0;
  private offset = 0;
  private nextIdx = 0;
  private curIdx = 0;
  private _playing = false;

  constructor(private readonly callbacks: PreviewCallbacks) {}

  get playing(): boolean {
    return this._playing;
  }

  async start(timeline: Timeline, fromIndex: number): Promise<void> {
    if (this._playing) this.stop();
    if (timeline.items.length === 0) return;
    const index = Math.max(0, Math.min(timeline.items.length - 1, fromIndex));
    this.context = await acquireAudio('preview');
    this.timeline = timeline;
    this.offset = timeline.items[index]?.from ?? 0;
    this.nextIdx = index;
    this.curIdx = index;
    this.startAt = this.context.currentTime + 0.08;
    this.sources = [];
    this._playing = true;
    this.tick();
  }

  stop(): void {
    const wasPlaying = this._playing;
    this._playing = false;
    cancelAnimationFrame(this.raf);
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* not started */
      }
    }
    this.sources = [];
    if (wasPlaying) releaseAudio('preview');
  }

  private tick = (): void => {
    const ctx = this.context;
    const tl = this.timeline;
    if (!this._playing || !ctx || !tl) return;
    const now = ctx.currentTime - this.startAt + this.offset;
    while (this.nextIdx < tl.items.length) {
      const it = tl.items[this.nextIdx];
      if (!it || it.start >= now + 2) break;
      const floats = segmentToFloat(it.seg.pcm, it.seg.sampleRate, it.seg.sampleRate, it.fadeIn, it.fadeOut);
      const buffer = ctx.createBuffer(1, floats.length, it.seg.sampleRate);
      buffer.copyToChannel(floats, 0);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start(Math.max(ctx.currentTime, this.startAt + it.start - this.offset));
      this.sources.push(src);
      this.nextIdx++;
    }
    while (this.curIdx < tl.items.length && now >= (tl.items[this.curIdx]?.end ?? Infinity)) this.curIdx++;
    if (this.curIdx >= tl.items.length) {
      this.stop();
      this.callbacks.onEnd();
      return;
    }
    this.callbacks.onTick(this.curIdx, Math.max(0, now), tl.total);
    this.raf = requestAnimationFrame(this.tick);
  };
}
