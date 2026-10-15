/**
 * The deep noise filter: DeepFilterNet3, a trained model that takes fans, typing, traffic, music
 * and other people's chatter out from under a voice, running on the audio thread in its own
 * AudioWorklet. The model and its runtime (libDF compiled to WebAssembly) come from the
 * `@workadventure/noise-suppression` package and are served with the app; nothing is fetched from
 * anywhere else.
 *
 * It only works at 48 kHz (the app's context runs at that rate, see `context.ts`) and costs a few
 * per cent of one core on a recent laptop. On a machine that cannot keep up the worklet says so
 * once, and the microphone falls back to the classic filter (`core/denoise.ts`), which is plain
 * arithmetic and always keeps up.
 */
import {
  createDeepFilterNetAudioWorklet,
  type DeepFilterNetAudioWorkletHandle,
} from '@workadventure/noise-suppression/deepfilternet';

/**
 * The most the model may take out, in dB. Unlimited (100) silences the background between words,
 * which can sound like dropouts; 40 leaves a faint, steady trace of the room while still taking the
 * noise far under the voice detector's floor.
 */
export const ATTENUATION_DB = 40;
/** The share of real time the model may use before the machine is judged too slow. */
export const MAX_LOAD = 0.6;

export interface DeepFilterEvents {
  /** The machine cannot keep up: `load` is the share of real time the model took. Sent once. */
  onOverload: (load: number) => void;
}

/**
 * One DeepFilterNet3 node for the app's context, created once and kept: loading the model into the
 * worklet takes a moment, and a node that is not connected to anything costs nothing.
 */
export class DeepFilter {
  private handle: DeepFilterNetAudioWorkletHandle | null = null;
  private context: AudioContext | null = null;
  private opening: Promise<AudioWorkletNode | null> | null = null;
  /** Why the deep filter is not available, once it has failed or proved too slow; null while it works. */
  private _unavailable: string | null = null;

  get unavailable(): string | null {
    return this._unavailable;
  }

  /** The node once it is ready, or null when the deep filter cannot run here (see `unavailable`). */
  node(context: AudioContext, events: DeepFilterEvents): Promise<AudioWorkletNode | null> {
    if (this._unavailable) return Promise.resolve(null);
    if (this.handle && this.context === context) return Promise.resolve(this.handle.node);
    this.opening ??= this.open(context, events).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async open(context: AudioContext, events: DeepFilterEvents): Promise<AudioWorkletNode | null> {
    this.dispose();
    try {
      const handle = await createDeepFilterNetAudioWorklet(context, {
        speechAttenuationDb: ATTENUATION_DB,
        // no pause gate: the phrase detector and the second listen decide what a pause is, and
        // the gate would delay the voice and could clip the first syllable after a keystroke
        pauseAttenuationDb: ATTENUATION_DB,
        bypassUntilReady: true,
        maxLoad: MAX_LOAD,
        onOverload: (load) => {
          this._unavailable = `too slow for this computer (it took ${Math.round(load * 100)}% of real time)`;
          this.dispose();
          events.onOverload(load);
        },
      });
      await handle.ready;
      this.handle = handle;
      this.context = context;
      return handle.node;
    } catch (error) {
      this._unavailable = `could not load (${(error as Error).message})`;
      console.warn('DeepFilterNet3 is unavailable; the classic noise filter will be used', error);
      return null;
    }
  }

  /** Lets the node go; the next `node()` loads it again. */
  dispose(): void {
    if (this.handle) {
      try {
        this.handle.dispose();
      } catch {
        /* already gone */
      }
    }
    this.handle = null;
    this.context = null;
  }
}
