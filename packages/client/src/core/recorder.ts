/**
 * One recording session: the live phrase detector, the two ways of driving it, and the second listen
 * that every finished phrase goes through before it is stored.
 *
 * - `auto`: the mic is live the whole time and the detector decides when a phrase starts and ends.
 * - `hold` (press to speak): nothing is captured until the talk key or button is held. The detector
 *   still trims the dead air inside what was held and still cuts pauses longer than the hangover, so
 *   the result sounds the same; the difference is that the app only ever hears what you chose to say.
 *
 * The live detector is lenient on purpose: it opens a phrase on anything that could be a voice and
 * holds it open through soft or quiet stretches (see `vad.ts`), so nothing a speaker says is cut as
 * they say it. When a phrase ends it is handed to the `review` (the second listen in `hindsight.ts`,
 * through `cutPhrase` in `silence.ts`), which goes over the whole of it and says which stretches to
 * keep: the pauses longer than the hangover go, the dead air at either end goes, and a phrase with no
 * voice in it at all goes altogether. Reviews run one after another, in the order the phrases ended,
 * so phrases are stored in the order they were spoken; `settled()` resolves once every review so far
 * is done. Without a review, phrases are stored as they are.
 *
 * The recorder also keeps the bookkeeping that ties phrases to slides: a slide change mid-sentence
 * splits the phrase, and the part spoken on the new slide remembers the id of the part before it,
 * as long as the review cut nothing off the seam between them.
 */
import { VoiceActivityDetector, type VadSettings } from './vad.js';

export type CaptureMode = 'auto' | 'hold';

export interface Phrase {
  blocks: Float32Array[];
  /** Zero-based slide the phrase was spoken on. */
  slide: number;
  /** Continues the previous phrase without a gap (the slide changed mid-sentence). */
  joined: boolean;
  prevId: string | null;
  /**
   * The live phrase this piece came from: the number handed to `onSpeakingChange` when it started.
   * Every piece of one live phrase (the parts either side of a slide change, the stretches the
   * review kept) shares it.
   */
  key: number;
  /** Where the piece sits in the microphone's stream, as block indices (see `VoiceActivityDetector.seen`). */
  at: BlockRange;
}

/** A stretch of a phrase to keep, as block indices (the end exclusive). */
export interface BlockRange {
  from: number;
  to: number;
}

/** What the second listen made of a finished phrase. */
export interface PhraseVerdict {
  /** The stretches to keep, in order; none means the phrase held no voice and is dropped. */
  keep: BlockRange[];
  /** Something was cut off the front of the phrase, so it cannot continue the one before it seamlessly. */
  startCut: boolean;
  /** Something was cut off the end, so nothing can continue it seamlessly. */
  endCut: boolean;
}

/** Goes over a finished phrase with the whole of it in view and says what to keep. */
export type PhraseReview = (blocks: Float32Array[]) => Promise<PhraseVerdict>;

export interface RecorderCallbacks {
  /** Stores a finished phrase (or the part spoken before a slide change) and returns its id. */
  onPhrase: (phrase: Phrase) => string;
  /**
   * A live phrase started or ended; `key` names it (see `Phrase.key`). An end comes whether the
   * phrase was kept, too short, or discarded, and a slide change in mid-sentence is not an end.
   */
  onSpeakingChange: (speaking: boolean, key: number) => void;
}

export interface RecorderOptions {
  mode: CaptureMode;
  slide: number;
  /** The second listen. Without one, phrases are stored as the live detector ends them. */
  review?: PhraseReview;
}

/** A phrase the live detector has finished, waiting for its review. */
interface Finished {
  blocks: Float32Array[];
  slide: number;
  /** Continues the part stored at the last slide change, if the review leaves the seam alone. */
  continuation: boolean;
  dropped: boolean;
  /** The live phrase it came from. */
  key: number;
  /** The stream index of its first block. */
  start: number;
}

export class Recorder {
  readonly vad: VoiceActivityDetector;
  private _mode: CaptureMode;
  private _held = false;
  private _muted = false;
  private _paused = false;
  /** The pen is on the slide: nothing is heard until it has rested (see `ink.ts`). */
  private _inking = false;
  private _slide: number;
  private readonly review: PhraseReview | null;
  /** Phrases finished but not yet reviewed, oldest first. */
  private readonly waiting: Finished[] = [];
  private queue: Promise<void> = Promise.resolve();
  /** Id of the last piece stored. */
  private lastId: string | null = null;
  /** The last phrase stored ended mid-sentence at a slide change with nothing cut off its end: a continuation may join it. */
  private lastOpen = false;
  /** Counts the live phrases; the current one's number is `phrase`. */
  private _phrase = 0;

  constructor(
    blockMs: number,
    settings: VadSettings,
    options: RecorderOptions,
    private readonly callbacks: RecorderCallbacks,
  ) {
    this._mode = options.mode;
    this._slide = options.slide;
    this.review = options.review ?? null;
    this.vad = new VoiceActivityDetector(blockMs, settings, {
      onSpeechStart: () => callbacks.onSpeakingChange(true, ++this._phrase),
      onSpeechEnd: (phrase) => {
        if (phrase) this.finish(phrase.blocks, phrase.continuation, phrase.endBlock);
        callbacks.onSpeakingChange(false, this._phrase);
      },
    });
    this.sync();
  }

  /** The key of the live phrase being spoken, or of the last one once it has ended; 0 before the first. */
  get phrase(): number {
    return this._phrase;
  }

  get mode(): CaptureMode {
    return this._mode;
  }

  get held(): boolean {
    return this._held;
  }

  get muted(): boolean {
    return this._muted;
  }

  /** Preview or export is running: the mic is ignored until it ends. */
  get paused(): boolean {
    return this._paused;
  }

  /** A drawing is being made: the voice and the pen are never recorded together. */
  get inking(): boolean {
    return this._inking;
  }

  get slide(): number {
    return this._slide;
  }

  get speaking(): boolean {
    return this.vad.speaking;
  }

  /** Phrases finished by the live detector whose review has not come back yet. */
  get pending(): number {
    return this.waiting.length;
  }

  /** Resolves once every phrase finished so far has been reviewed and stored (or dropped). */
  settled(): Promise<void> {
    return this.queue;
  }

  /**
   * Index of the earliest block that may still end up in a phrase: the oldest phrase waiting for its
   * review, else the one being spoken, else the pre-roll. Whatever records alongside the microphone
   * can let go of everything before it.
   */
  get heldFrom(): number {
    let from = this.vad.heldFrom;
    for (const finished of this.waiting) if (!finished.dropped) from = Math.min(from, finished.start);
    return from;
  }

  /** Whether sound reaching the mic right now can become a phrase. */
  get gateOpen(): boolean {
    return !this._muted && !this._paused && !this._inking && (this._mode === 'auto' || this._held);
  }

  private sync(): void {
    this.vad.gate = this.gateOpen;
  }

  /** Takes the next block with the voice detector's latest score (null: decide by level alone). */
  process(block: Float32Array, speech: number | null = null): void {
    this.vad.process(block, speech);
  }

  /** Switching modes ends the phrase being spoken and lets go of the talk key. */
  setMode(mode: CaptureMode): void {
    if (mode === this._mode) return;
    this.vad.end();
    this._held = false;
    this._mode = mode;
    this.sync();
  }

  /**
   * The talk key or button went down or up. Returns false when it changed nothing: the recorder is
   * in auto mode (so the key keeps its other meaning), or the key was already in that state.
   */
  hold(down: boolean): boolean {
    if (this._mode !== 'hold' || this._held === down) return false;
    this._held = down;
    // Up: the phrase ends now, with the trailing quiet trimmed. Down: the gate opens on an empty
    // pre-roll, so nothing from before the press can be in the phrase.
    if (!down) this.vad.end();
    this.sync();
    return true;
  }

  setMuted(muted: boolean): void {
    if (muted === this._muted) return;
    this.vad.end();
    this._muted = muted;
    this.sync();
  }

  setPaused(paused: boolean): void {
    if (paused === this._paused) return;
    this.vad.end();
    this._paused = paused;
    this.sync();
  }

  /**
   * The pen went down (true) or has rested (false). Down ends the phrase being spoken where it is,
   * with its trailing quiet trimmed as ever, and nothing heard while the pen is on the slide can
   * become a phrase; up lets the detector listen again.
   */
  setInking(inking: boolean): void {
    if (inking === this._inking) return;
    if (inking) this.vad.end();
    this._inking = inking;
    this.sync();
  }

  /**
   * Runs `fn` once every phrase finished so far has been reviewed and stored. A drawing that ends
   * while a phrase is still under its second listen is stored after that phrase, so clips always
   * land in the order they were made.
   */
  after(fn: () => void): Promise<void> {
    this.queue = this.queue.then(fn);
    return this.queue;
  }

  /** The slide changed. A sentence in progress is split: the part so far is stored on the old slide. */
  setSlide(index: number): void {
    if (index === this._slide) return;
    this.splitPhrase();
    this._slide = index;
  }

  /**
   * Something happened on the slide mid-sentence (a slide change, the slide wiped clean): the part
   * spoken so far is stored now, and what follows continues it. Nothing happens while no one speaks.
   */
  splitPhrase(): void {
    if (!this.vad.speaking) return;
    // whether the part being stored itself continued an earlier part: read before the split marks the rest as one
    const continuation = this.vad.continuing;
    const part = this.vad.split();
    if (part) this.finish(part.blocks, continuation, part.endBlock, true);
  }

  /**
   * Drops the phrase being spoken right now (the speaker flubbed it), or, when nothing is being
   * spoken, the last phrase still waiting for its review. Returns false when there was neither: the
   * phrase the speaker means is already stored.
   */
  discard(): boolean {
    if (this.vad.speaking) {
      this.vad.discard();
      return true;
    }
    for (let k = this.waiting.length - 1; k >= 0; k--) {
      const finished = this.waiting[k];
      if (finished && !finished.dropped) {
        finished.dropped = true;
        return true;
      }
    }
    return false;
  }

  /** The mic is stopping: finish the phrase being spoken. */
  end(): void {
    this.vad.end();
  }

  /**
   * A phrase (or, with `split`, the part of one spoken before a slide change) is finished: queue it
   * for its review, or store it at once when there is none.
   */
  private finish(blocks: Float32Array[], continuation: boolean, endBlock: number, split = false): void {
    const finished: Finished = {
      blocks,
      slide: this._slide,
      continuation,
      dropped: false,
      key: this._phrase,
      start: endBlock - blocks.length,
    };
    if (!this.review) {
      this.store(finished, { keep: [{ from: 0, to: blocks.length }], startCut: false, endCut: false }, split);
      return;
    }
    const review = this.review;
    this.waiting.push(finished);
    this.queue = this.queue.then(async () => {
      let verdict: PhraseVerdict | null = null;
      try {
        if (!finished.dropped) verdict = await review(blocks);
      } catch (error) {
        console.warn('the second listen failed; keeping the phrase as heard', error);
        verdict = { keep: [{ from: 0, to: blocks.length }], startCut: false, endCut: false };
      }
      this.waiting.shift();
      if (finished.dropped || !verdict) {
        this.lastOpen = false;
        return;
      }
      this.store(finished, verdict, split);
    });
  }

  /** Stores what the review kept of a phrase, joining the first piece to the part before it when the seam survived. */
  private store(finished: Finished, verdict: PhraseVerdict, split: boolean): void {
    const pieces = verdict.keep.filter((r) => r.to > r.from);
    if (pieces.length === 0) {
      this.lastOpen = false;
      return;
    }
    pieces.forEach((range, i) => {
      const joined = i === 0 && finished.continuation && this.lastOpen && !verdict.startCut;
      this.lastId = this.callbacks.onPhrase({
        blocks: finished.blocks.slice(range.from, range.to),
        slide: finished.slide,
        joined,
        prevId: joined ? this.lastId : null,
        key: finished.key,
        at: { from: finished.start + range.from, to: finished.start + range.to },
      });
    });
    // only a part that ended at a slide change, with its end intact, can be continued
    this.lastOpen = split && !verdict.endCut;
  }
}
