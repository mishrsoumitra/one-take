/**
 * One take for the editor: open the microphone, run the same recorder as the main recording (auto
 * or press to speak, each phrase through the second listen), and hand back the phrases, pauses
 * already cut, when the user presses Stop.
 */
import { type TakePhrase } from '../core/edit.js';
import { floatBlocksToInt16 } from '../core/pcm.js';
import { Recorder, type CaptureMode } from '../core/recorder.js';
import { cutPhrase } from '../core/silence.js';
import { MicScorer, type VoiceScorer } from '../core/speech.js';
import { type VadSettings } from '../core/vad.js';
import { type CameraCapture } from '../video/camera.js';

import { type MicCapture } from './mic.js';

export interface Take {
  /** Each phrase, in the order spoken, with the silence between them removed; its picture when the camera was on. */
  phrases: TakePhrase[];
  sampleRate: number;
}

export interface TakeStartOptions {
  settings: VadSettings;
  mode: CaptureMode;
  deviceId?: string;
  noiseFilter: boolean;
  /** The camera, when it is on: each phrase of the take gets its picture too. */
  camera?: CameraCapture | null;
}

export class TakeRecorder {
  private recorder: Recorder | null = null;
  private phrases: TakePhrase[] = [];
  private sampleRate = 48000;
  private doneMs = 0;
  private camera: CameraCapture | null = null;

  constructor(
    private readonly mic: MicCapture,
    private readonly blockMs: number,
    /** The voice detector that cuts the take. */
    private readonly speech: () => VoiceScorer,
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

  /** The voice detector's latest score, or null while the level alone decides. */
  get voice(): number | null {
    return this.recorder?.vad.voice ?? null;
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
    const camera = options.camera ?? null;
    const recorder = new Recorder(
      this.blockMs,
      options.settings,
      {
        mode: options.mode,
        slide: 0,
        review: (blocks) => cutPhrase(blocks, this.sampleRate, options.settings),
      },
      {
        onPhrase: (phrase) => {
          const pcm = floatBlocksToInt16(phrase.blocks);
          const video =
            camera?.take(phrase.at * this.blockMs, (phrase.at + phrase.blocks.length) * this.blockMs) ?? null;
          this.phrases.push({ pcm, video });
          this.doneMs += (pcm.length / this.sampleRate) * 1000;
          return String(this.phrases.length);
        },
        onSpeakingChange: () => undefined,
      },
    );
    const scorer = new MicScorer(this.speech());
    const info = await this.mic.start({
      deviceId: options.deviceId,
      noiseFilter: options.noiseFilter,
      blockMs: this.blockMs,
      onBlock: (block) => {
        scorer.push(block, this.mic.sampleRate);
        const rec = this.recorder;
        if (!rec) return;
        rec.process(block, scorer.prob);
        // the camera runs on the microphone's clock: this many blocks have gone by, and nothing
        // before the earliest pending phrase (or the pre-roll) is needed any more
        this.camera?.tick(rec.vad.seen, rec.heldFrom - rec.vad.settings.prerollMs / this.blockMs);
      },
    });
    if (!info) return false;
    this.sampleRate = info.sampleRate;
    this.recorder = recorder;
    if (camera) {
      camera.record(this.blockMs);
      this.camera = camera;
    }
    return true;
  }

  /** Press to speak: the talk key or button went down or up. */
  hold(down: boolean): boolean {
    return this.recorder?.hold(down) ?? false;
  }

  /**
   * Ends the phrase being spoken, closes the microphone, waits for the last phrases to come through
   * the second listen and returns everything heard.
   */
  async stop(): Promise<Take> {
    const recorder = this.recorder;
    this.recorder = null;
    recorder?.end();
    this.mic.stop();
    // the camera stops taking frames now, but keeps what it has until the last phrases are stored
    this.camera?.pause();
    await recorder?.settled();
    this.camera?.stopRecording();
    this.camera = null;
    const take = { phrases: this.phrases, sampleRate: this.sampleRate };
    this.phrases = [];
    this.doneMs = 0;
    return take;
  }

  /** Closes the microphone and throws the take away. */
  cancel(): void {
    this.recorder = null;
    this.mic.stop();
    this.camera?.stopRecording();
    this.camera = null;
    this.phrases = [];
    this.doneMs = 0;
  }
}
