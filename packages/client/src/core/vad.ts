/**
 * The live phrase detector: decides, block by block (10 ms by default), whether something that could
 * be a voice is going on, and gathers it into phrases.
 *
 * Each block arrives with the voice detector's latest score (see `speech.ts` and `voice.ts`): how
 * much what is heard right now sounds like someone speaking. A block is "heard" when the score says
 * it could be a voice (0.35 to open a phrase, and only 0.15 to keep one open) and, for the first
 * blocks of a phrase, its level is above the speech line, so a faint voice from the next room does
 * not start a phrase. Without a score (null: the tests drive the detector by level alone) the level
 * alone decides, and the speech line rises above the room's noise floor to make up for it.
 *
 * The bars are low and the hold is long on purpose. This detector hears each frame once and has to
 * answer at once, so it is not the one that cuts: a soft aside, a sentence that trails off, a low
 * creaky ending, all stay in the phrase. The phrase ends only after two seconds (or `hangoverMs`,
 * whichever is longer) with nothing voice-like at all, of which only `tailMs` is kept; then the
 * second listen (`hindsight.ts`) goes over the finished phrase with the whole of it in view and
 * makes the cuts.
 *
 * A phrase starts after three heard blocks and keeps `prerollMs` of audio from before that moment.
 * Bursts shorter than `minSpeechMs` are dropped unless they continue a phrase that was split by a
 * slide change.
 *
 * The detector does not know how it is being driven: `gate` is opened and closed by the recorder,
 * which in press-to-speak mode only opens it while the talk key is held.
 */
import { rmsDb } from './pcm.js';
import { LIVE_KEEP, LIVE_START } from './speech.js';

export interface VadSettings {
  /** dBFS; the speech line. Sound under it never counts as speech (raised above the noise floor when there is no score). */
  threshold: number;
  /** A pause this long is cut by the second listen; the live phrase holds on for at least {@link LIVE_HOLD_MS}. */
  hangoverMs: number;
  prerollMs: number;
  tailMs: number;
  minSpeechMs: number;
}

/**
 * The least a live phrase stays open with nothing voice-like heard, in ms: long enough that a quiet
 * stretch inside a sentence is never cut live, short enough that the phrase shows up soon after the
 * speaker stops.
 */
export const LIVE_HOLD_MS = 2000;

export interface PhraseResult {
  blocks: Float32Array[];
  loudMs: number;
  /** The phrase continues one that was split by a slide change. */
  continuation: boolean;
  /** Where the phrase ends in the stream: the index of the block after its last one (see {@link VoiceActivityDetector.seen}). */
  endBlock: number;
}

/** What a slide change splits off: the blocks spoken so far and where they end in the stream. */
export interface SplitResult {
  blocks: Float32Array[];
  endBlock: number;
}

export interface VadCallbacks {
  onSpeechStart: () => void;
  onSpeechEnd: (phrase: PhraseResult | null) => void;
}

export class VoiceActivityDetector {
  noise = -60;
  level = -90;
  threshold = -45;
  /** The voice detector's latest score for the meter; null while the level alone decides. */
  voice: number | null = null;
  private loudRun = 0;
  private quietRun = 0;
  private pre: Float32Array[] = [];
  private cur: Float32Array[] = [];
  private curLoud = 0;
  private continuation = false;
  private _speaking = false;
  private _seen = 0;
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

  /** The phrase being spoken continues a part already split off by a slide change. */
  get continuing(): boolean {
    return this._speaking && this.continuation;
  }

  get quietMs(): number {
    return this.quietRun * this.blockMs;
  }

  /**
   * Blocks taken so far, gate open or closed: the stream's clock. A phrase's `endBlock` counts in
   * these, so `endBlock - blocks.length` is where it started, and a block's time is its index times
   * `blockMs` from the stream's start.
   */
  get seen(): number {
    return this._seen;
  }

  /** How long a phrase stays open with nothing heard: the hangover, but never under {@link LIVE_HOLD_MS}. */
  get holdMs(): number {
    return Math.max(this.settings.hangoverMs, LIVE_HOLD_MS);
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
    this._seen = 0;
  }

  /**
   * Takes the next block. `speech` is the voice detector's latest score, or null to decide by level
   * alone.
   */
  process(block: Float32Array, speech: number | null = null): void {
    this._seen++;
    const db = rmsDb(block);
    this.level = db;
    this.voice = speech;
    // Fast to follow drops, slow to rise: the floor tracks the quiet parts of the room.
    this.noise += db < this.noise ? (db - this.noise) * 0.2 : (db - this.noise) * 0.002;
    this.noise = Math.max(-90, Math.min(-30, this.noise));
    // With a score the line is the user's setting alone: the detector, not the floor, tells a noisy
    // room from a voice. Without one the line has to stay above the noise.
    this.threshold =
      speech === null ? Math.max(this.settings.threshold, this.noise + 6) : this.settings.threshold;
    const loud = db > this.threshold;
    const heard =
      speech === null ? loud : this._speaking ? speech >= LIVE_KEEP : speech >= LIVE_START && loud;

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
    } else if (++this.quietRun * this.blockMs >= this.holdMs) {
      this.end();
    }
  }

  /**
   * The slide changed while speaking. Returns the blocks spoken so far (to be stored on the old slide)
   * and continues the phrase on the new slide. Returns null when there is nothing to store: the speaker
   * had already gone quiet (the phrase simply ends), or nothing was said since the previous split (the
   * phrase carries on, still joined to the part before).
   */
  split(): SplitResult | null {
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
    return { blocks, endBlock: this._seen };
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
    this.callbacks.onSpeechEnd(keep ? { blocks, loudMs, continuation, endBlock: this._seen - drop } : null);
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
