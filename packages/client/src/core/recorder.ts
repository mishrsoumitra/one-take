/**
 * One recording session: the voice detector plus the two ways of driving it.
 *
 * - `auto`: the mic is live the whole time and the detector decides when a phrase starts and ends.
 * - `hold` (press to speak): nothing is captured until the talk key or button is held. The detector
 *   still trims the dead air inside what was held and still cuts pauses longer than the hangover, so
 *   the result sounds the same; the difference is that the app only ever hears what you chose to say.
 *
 * The recorder also keeps the bookkeeping that ties phrases to slides: a slide change mid-sentence
 * splits the phrase, and the part spoken on the new slide remembers the id of the part before it.
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
}

export interface RecorderCallbacks {
  /** Stores a finished phrase (or the part spoken before a slide change) and returns its id. */
  onPhrase: (phrase: Phrase) => string;
  onSpeakingChange: (speaking: boolean) => void;
}

export class Recorder {
  readonly vad: VoiceActivityDetector;
  private _mode: CaptureMode;
  private _held = false;
  private _muted = false;
  private _paused = false;
  private _slide: number;
  /** Id of the phrase part stored at the last slide change, while the same sentence continues. */
  private prevId: string | null = null;

  constructor(
    blockMs: number,
    settings: VadSettings,
    options: { mode: CaptureMode; slide: number },
    private readonly callbacks: RecorderCallbacks,
  ) {
    this._mode = options.mode;
    this._slide = options.slide;
    this.vad = new VoiceActivityDetector(blockMs, settings, {
      onSpeechStart: () => {
        this.prevId = null;
        callbacks.onSpeakingChange(true);
      },
      onSpeechEnd: (phrase) => {
        if (phrase) {
          callbacks.onPhrase({
            blocks: phrase.blocks,
            slide: this._slide,
            joined: phrase.continuation,
            prevId: phrase.continuation ? this.prevId : null,
          });
        }
        this.prevId = null;
        callbacks.onSpeakingChange(false);
      },
    });
    this.sync();
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

  get slide(): number {
    return this._slide;
  }

  get speaking(): boolean {
    return this.vad.speaking;
  }

  /** Whether sound reaching the mic right now can become a phrase. */
  get gateOpen(): boolean {
    return !this._muted && !this._paused && (this._mode === 'auto' || this._held);
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

  /** The slide changed. A sentence in progress is split: the part so far is stored on the old slide. */
  setSlide(index: number): void {
    if (index === this._slide) return;
    if (this.vad.speaking) {
      const blocks = this.vad.split();
      if (blocks) {
        this.prevId = this.callbacks.onPhrase({
          blocks,
          slide: this._slide,
          joined: this.prevId !== null,
          prevId: this.prevId,
        });
      }
    }
    this._slide = index;
  }

  /** Drop the phrase being spoken right now. */
  discard(): void {
    this.vad.discard();
  }

  /** The mic is stopping: finish the phrase being spoken. */
  end(): void {
    this.vad.end();
  }
}
