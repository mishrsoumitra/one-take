/**
 * One take for the editor: open the microphone, run the same recorder as the main recording (auto
 * or press to speak), and hand back the phrases, pauses already cut, when the user presses Stop.
 */
import { floatBlocksToInt16 } from '../core/pcm.js';
import { Recorder, type CaptureMode } from '../core/recorder.js';
import { type VadSettings } from '../core/vad.js';

import { type MicCapture } from './mic.js';

export interface Take {
  /** Each phrase as 16-bit mono PCM, in the order spoken, with the silence between them removed. */
  phrases: Int16Array[];
  sampleRate: number;
}

export interface TakeStartOptions {
  settings: VadSettings;
  mode: CaptureMode;
  deviceId?: string;
}

export class TakeRecorder {
  private recorder: Recorder | null = null;
  private phrases: Int16Array[] = [];
  private sampleRate = 48000;
  private doneMs = 0;

  constructor(
    private readonly mic: MicCapture,
    private readonly blockMs: number,
  ) {}

  get recording(): boolean {
    return this.recorder !== null;
  }

  get speaking(): boolean {
    return this.recorder?.speaking ?? false;
  }

  get mode(): CaptureMode | null {
    return this.recorder?.mode ?? null;
  }

  /** Press to speak: the talk key or button is down. */
  get held(): boolean {
    return this.recorder?.held ?? false;
  }

  get level(): number {
    return this.recorder?.vad.level ?? -90;
  }

  get threshold(): number | null {
    return this.recorder?.vad.threshold ?? null;
  }

  get noise(): number {
    return this.recorder?.vad.noise ?? -60;
  }

  /** Phrases finished so far. */
  get phraseCount(): number {
    return this.phrases.length;
  }

  /** Speech captured so far, finished phrases plus the one being spoken, in seconds. */
  get seconds(): number {
    return (this.doneMs + (this.recorder?.vad.currentMs ?? 0)) / 1000;
  }

  /** Opens the microphone. Resolves false when the take was cancelled while the mic was opening. */
  async start(options: TakeStartOptions): Promise<boolean> {
    if (this.recorder) this.cancel();
    this.phrases = [];
    this.doneMs = 0;
    const recorder = new Recorder(
      this.blockMs,
      options.settings,
      { mode: options.mode, slide: 0 },
      {
        onPhrase: (phrase) => {
          const pcm = floatBlocksToInt16(phrase.blocks);
          this.phrases.push(pcm);
          this.doneMs += (pcm.length / this.sampleRate) * 1000;
          return String(this.phrases.length);
        },
        onSpeakingChange: () => undefined,
      },
    );
    const info = await this.mic.start({
      deviceId: options.deviceId,
      blockMs: this.blockMs,
      onBlock: (block) => this.recorder?.process(block),
    });
    if (!info) return false;
    this.sampleRate = info.sampleRate;
    this.recorder = recorder;
    return true;
  }

  /** Press to speak: the talk key or button went down or up. */
  hold(down: boolean): boolean {
    return this.recorder?.hold(down) ?? false;
  }

  /** Ends the phrase being spoken, closes the microphone and returns everything heard. */
  stop(): Take {
    const recorder = this.recorder;
    this.recorder = null;
    recorder?.end();
    this.mic.stop();
    const take = { phrases: this.phrases, sampleRate: this.sampleRate };
    this.phrases = [];
    this.doneMs = 0;
    return take;
  }

  /** Closes the microphone and throws the take away. */
  cancel(): void {
    this.recorder = null;
    this.mic.stop();
    this.phrases = [];
    this.doneMs = 0;
  }
}
