import { segmentToFloat } from '../core/pcm.js';
import { type Timeline } from '../core/timeline.js';

import { acquireAudio, releaseAudio } from './context.js';

export interface PreviewCallbacks {
  /** Called every animation frame with the item currently playing and the position in seconds. */
  onTick: (itemIndex: number, nowSec: number, totalSec: number) => void;
  onEnd: () => void;
}

/** When playback starts in the middle of a phrase, the first phrase fades in over this long. */
const SEEK_FADE_SEC = 0.01;

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
  private _position = 0;

  constructor(private readonly callbacks: PreviewCallbacks) {}

  get playing(): boolean {
    return this._playing;
  }

  /** Where playback is, or where it stopped, in seconds from the start of the timeline. */
  get position(): number {
    return this._position;
  }

  /** Plays from the beginning of the phrase at `fromIndex`. */
  start(timeline: Timeline, fromIndex: number): Promise<void> {
    const index = Math.max(0, Math.min(timeline.items.length - 1, fromIndex));
    return this.startAtTime(timeline, timeline.items[index]?.from ?? 0);
  }

  /** Plays from any point on the timeline, including the middle of a phrase. */
  async startAtTime(timeline: Timeline, seconds: number): Promise<void> {
    if (this._playing) this.stop();
    if (timeline.items.length === 0) return;
    this.context = await acquireAudio('preview');
    const sec = Math.max(0, Math.min(timeline.total, seconds));
    let index = timeline.items.findIndex((it) => sec < it.end);
    if (index < 0) index = timeline.items.length;
    this.timeline = timeline;
    this.offset = sec;
    this._position = sec;
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
      const when = this.startAt + it.start - this.offset;
      if (when >= ctx.currentTime) {
        src.connect(ctx.destination);
        src.start(when);
      } else {
        // Starting inside the phrase: skip what has already passed and fade in so the cut is silent.
        const into = ctx.currentTime - when;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(1, ctx.currentTime + SEEK_FADE_SEC);
        src.connect(gain).connect(ctx.destination);
        src.start(ctx.currentTime, Math.min(into, it.dur));
      }
      this.sources.push(src);
      this.nextIdx++;
    }
    while (this.curIdx < tl.items.length && now >= (tl.items[this.curIdx]?.end ?? Infinity)) this.curIdx++;
    if (this.curIdx >= tl.items.length) {
      this._position = tl.total;
      this.stop();
      this.callbacks.onEnd();
      return;
    }
    this._position = Math.max(0, now);
    this.callbacks.onTick(this.curIdx, this._position, tl.total);
    this.raf = requestAnimationFrame(this.tick);
  };
}
