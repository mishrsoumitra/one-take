/** Plays a stretch of one stored phrase through Web Audio: the filler list's ▶ button. */
import { acquireAudio, releaseAudio } from '../audio/context.js';

export class SnippetPlayer {
  private source: AudioBufferSourceNode | null = null;
  private onEnd: (() => void) | null = null;

  get playing(): boolean {
    return this.source !== null;
  }

  async play(
    pcm: Int16Array,
    sampleRate: number,
    fromSec: number,
    toSec: number,
    onEnd?: () => void,
  ): Promise<void> {
    this.stop();
    const from = Math.max(0, Math.floor(fromSec * sampleRate));
    const to = Math.min(pcm.length, Math.ceil(toSec * sampleRate));
    if (to <= from) return;
    const ctx = await acquireAudio('snippet');
    const buffer = ctx.createBuffer(1, to - from, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = from; i < to; i++) data[i - from] = (pcm[i] ?? 0) / 32768;
    const fade = Math.min(Math.round(sampleRate * 0.01), (to - from) >> 1);
    for (let i = 0; i < fade; i++) {
      data[i] = (data[i] ?? 0) * (i / fade);
      data[data.length - 1 - i] = (data[data.length - 1 - i] ?? 0) * (i / fade);
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => {
      if (this.source === source) {
        this.source = null;
        releaseAudio('snippet');
        this.onEnd?.();
        this.onEnd = null;
      }
    };
    this.source = source;
    this.onEnd = onEnd ?? null;
    source.start();
  }

  stop(): void {
    const source = this.source;
    if (!source) return;
    this.source = null;
    try {
      source.stop();
    } catch {
      /* not started */
    }
    releaseAudio('snippet');
    this.onEnd?.();
    this.onEnd = null;
  }
}
