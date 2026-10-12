/**
 * Voice activity detection over fixed-size blocks (10 ms by default).
 *
 * Each block arrives with the voice model's latest score (see `speech.ts`): how likely it is that a
 * voice is speaking right now. A block is "heard" when the score says voice (0.5 to start a phrase,
 * 0.35 to keep one going) and, for the first blocks of a phrase, its level is above the speech line,
 * so a faint voice from the next room does not start a phrase. Without a score (the model is still
 * loading, or could not load) the level alone decides, and the speech line rises above the room's
 * noise floor to make up for it.
 *
 * A phrase starts after three heard blocks and keeps `prerollMs` of audio from before that moment. It
 * ends after `hangoverMs` of unheard blocks, of which only `tailMs` is kept. Bursts shorter than
 * `minSpeechMs` are dropped unless they continue a phrase that was split by a slide change.
 *
 * The detector does not know how it is being driven: `gate` is opened and closed by the recorder,
 * which in press-to-speak mode only opens it while the talk key is held.
 */
import { rmsDb } from './pcm.js';
import { SPEECH_KEEP, SPEECH_START } from './speech.js';

export interface VadSettings {
  /** dBFS; the speech line. Sound under it never counts as speech (raised above the noise floor when there is no voice model). */
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
  /** The voice model's latest score for the meter; null while the level alone decides. */
  voice: number | null = null;
  private loudRun = 0;
  private quietRun = 0;
  private pre: Float32Array[] = [];
  private cur: Float32Array[] = [];
  private curLoud = 0;
  private continuation = false;
  private _speaking = false;
  /** When false (muted, preview, export, talk key up), blocks only feed the level and noise readings. */
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

  /** Audio held in memory right now: the pre-roll plus the phrase being spoken. Bounded while idle. */
  get bufferedMs(): number {
    return (this.pre.length + this.cur.length) * this.blockMs;
  }

  reset(): void {
    this.noise = -60;
    this.level = -90;
    this.voice = null;
    this.loudRun = 0;
    this.quietRun = 0;
    this.pre = [];
    this.cur = [];
    this.curLoud = 0;
    this.continuation = false;
    this._speaking = false;
  }

  /**
   * Takes the next block. `speech` is the voice model's latest score, or null to decide by level
   * alone (no model, or it failed).
   */
  process(block: Float32Array, speech: number | null = null): void {
    const db = rmsDb(block);
    this.level = db;
    this.voice = speech;
    // Fast to follow drops, slow to rise: the floor tracks the quiet parts of the room.
    this.noise += db < this.noise ? (db - this.noise) * 0.2 : (db - this.noise) * 0.002;
    this.noise = Math.max(-90, Math.min(-30, this.noise));
    // With a voice model the line is the user's setting alone: the model, not the floor, tells a
    // noisy room from a voice. Without one the line has to stay above the noise.
    this.threshold =
      speech === null ? Math.max(this.settings.threshold, this.noise + 6) : this.settings.threshold;
    const loud = db > this.threshold;
    const heard =
      speech === null ? loud : this._speaking ? speech >= SPEECH_KEEP : speech >= SPEECH_START && loud;

    if (!this.gate) {
      // Nothing heard while the gate is closed is kept, not even as pre-roll: what was said while
      // muted, during a preview, or before the talk key went down never reaches a phrase.
      this.pre = [];
      this.loudRun = 0;
      return;
    }
    if (!this._speaking) {
      this.pushPre(block);
      if (heard) {
        if (++this.loudRun >= 3) this.start();
      } else {
        this.loudRun = 0;
      }
      return;
    }
    this.cur.push(block);
    if (heard) {
      this.quietRun = 0;
      this.curLoud++;
    } else if (++this.quietRun * this.blockMs >= this.settings.hangoverMs) {
      this.end();
    }
  }

  /**
   * The slide changed while speaking. Returns the blocks spoken so far (to be stored on the old slide)
   * and continues the phrase on the new slide. Returns null when there is nothing to store: the speaker
   * had already gone quiet (the phrase simply ends), or nothing was said since the previous split (the
   * phrase carries on, still joined to the part before).
   */
  split(): Float32Array[] | null {
    if (!this._speaking) return null;
    if (this.quietRun * this.blockMs > this.settings.tailMs) {
      this.end();
      return null;
    }
    if (this.curLoud === 0) {
      // Nothing was said on the slide being left (two slide changes in quick succession): the sentence
      // simply moves on, and the sliver of quiet since the last split is dropped rather than stored.
      this.cur = [];
      this.quietRun = 0;
      return null;
    }
    const blocks = this.cur;
    this.cur = [];
    this.continuation = true;
    this.curLoud = 0;
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
    // A continuation is kept however short it is, as long as something was actually said on the new
    // slide; a slide change right at the end of a sentence must not leave a silent stub behind.
    const keep = loudMs >= this.settings.minSpeechMs || (continuation && loudMs > 0);
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
