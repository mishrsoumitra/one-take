/**
 * Energy-based voice activity detection over fixed-size blocks (10 ms by default).
 *
 * A phrase starts after three loud blocks and keeps `prerollMs` of audio from before that moment. It ends
 * after `hangoverMs` of quiet, of which only `tailMs` is kept. Bursts shorter than `minSpeechMs` are
 * dropped unless they continue a phrase that was split by a slide change.
 */
import { rmsDb } from './pcm.js';

export interface VadSettings {
  /** dBFS; sound above this counts as speech (raised automatically when the room is noisy). */
  threshold: number;
  hangoverMs: number;
  prerollMs: number;
  tailMs: number;
  minSpeechMs: number;
}

export interface PhraseResult {
  blocks: Float32Array[];
  loudMs: number;
  /** The phrase continues one that was split by a slide change. */
  continuation: boolean;
}

export interface VadCallbacks {
  onSpeechStart: () => void;
  onSpeechEnd: (phrase: PhraseResult | null) => void;
}

export class VoiceActivityDetector {
  noise = -60;
  level = -90;
  threshold = -45;
  private loudRun = 0;
  private quietRun = 0;
  private pre: Float32Array[] = [];
  private cur: Float32Array[] = [];
  private curLoud = 0;
  private continuation = false;
  private _speaking = false;
  /** When false, blocks only keep the pre-roll warm (muted, preview, export). */
  gate = true;

  constructor(
    readonly blockMs: number,
    public settings: VadSettings,
    private readonly callbacks: VadCallbacks,
  ) {
    this.threshold = settings.threshold;
  }

  get speaking(): boolean {
    return this._speaking;
  }

  get currentMs(): number {
    return this.cur.length * this.blockMs;
  }

  get quietMs(): number {
    return this.quietRun * this.blockMs;
  }

  reset(): void {
    this.noise = -60;
    this.level = -90;
    this.loudRun = 0;
    this.quietRun = 0;
    this.pre = [];
    this.cur = [];
    this.curLoud = 0;
    this.continuation = false;
    this._speaking = false;
  }

  process(block: Float32Array): void {
    const db = rmsDb(block);
    this.level = db;
    // Fast to follow drops, slow to rise: the floor tracks the quiet parts of the room.
    this.noise += db < this.noise ? (db - this.noise) * 0.2 : (db - this.noise) * 0.002;
    this.noise = Math.max(-90, Math.min(-30, this.noise));
    this.threshold = Math.max(this.settings.threshold, this.noise + 6);
    const loud = db > this.threshold;

    if (!this.gate) {
      this.pushPre(block);
      this.loudRun = 0;
      return;
    }
    if (!this._speaking) {
      this.pushPre(block);
      if (loud) {
        if (++this.loudRun >= 3) this.start();
      } else {
        this.loudRun = 0;
      }
      return;
    }
    this.cur.push(block);
    if (loud) {
      this.quietRun = 0;
      this.curLoud++;
    } else if (++this.quietRun * this.blockMs >= this.settings.hangoverMs) {
      this.end();
    }
  }

  /**
   * The slide changed while speaking. Returns the blocks spoken so far (to be stored on the old slide)
   * and continues the phrase on the new slide, or returns null when the speaker had already gone quiet
   * (in which case the phrase simply ends).
   */
  split(): Float32Array[] | null {
    if (!this._speaking) return null;
    if (this.quietRun * this.blockMs > this.settings.tailMs) {
      this.end();
      return null;
    }
    const blocks = this.cur;
    this.cur = [];
    this.continuation = true;
    this.curLoud = Number.MAX_SAFE_INTEGER / 1000; // a continuation is always kept
    return blocks;
  }

  /** Drop the phrase being spoken right now (the speaker flubbed it). */
  discard(): void {
    if (!this._speaking) return;
    this._speaking = false;
    this.cur = [];
    this.quietRun = 0;
    this.loudRun = 0;
    this.continuation = false;
    this.callbacks.onSpeechEnd(null);
  }

  /** Force the current phrase to end now (mic stopped, mute, preview). */
  end(): void {
    if (!this._speaking) return;
    const keepTail = Math.round(this.settings.tailMs / this.blockMs);
    const drop = Math.max(0, this.quietRun - keepTail);
    const blocks = this.cur.slice(0, this.cur.length - drop);
    this.pre = this.cur.slice(this.cur.length - drop);
    this.trimPre();
    const loudMs = this.curLoud * this.blockMs;
    const continuation = this.continuation;
    this._speaking = false;
    this.quietRun = 0;
    this.loudRun = 0;
    this.cur = [];
    this.continuation = false;
    const keep = loudMs >= this.settings.minSpeechMs || continuation;
    this.callbacks.onSpeechEnd(keep ? { blocks, loudMs, continuation } : null);
  }

  private start(): void {
    this._speaking = true;
    this.cur = this.pre;
    this.pre = [];
    this.quietRun = 0;
    this.curLoud = this.loudRun;
    this.loudRun = 0;
    this.continuation = false;
    this.callbacks.onSpeechStart();
  }

  private pushPre(block: Float32Array): void {
    this.pre.push(block);
    this.trimPre();
  }

  private trimPre(): void {
    const max = Math.round(this.settings.prerollMs / this.blockMs) + 3;
    while (this.pre.length > max) this.pre.shift();
  }
}
