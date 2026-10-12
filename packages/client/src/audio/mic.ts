import { NoiseFilter } from '../core/denoise.js';

// eslint-disable-next-line import-x/default -- Vite's `?worker&url` import is the bundled worklet's URL
import processorUrl from './capture-processor.ts?worker&url';
import { acquireAudio, releaseAudio } from './context.js';

// `import type`, never a plain import: anything else would bundle the worklet into the page, where
// AudioWorkletProcessor does not exist
import type { CaptureMessage } from './capture-processor.js';

export interface MicStartOptions {
  deviceId?: string;
  /** Run the noise filter (`core/denoise.ts`) over the microphone before anything hears it. */
  noiseFilter: boolean;
  /** Block length handed to the detector, in milliseconds. */
  blockMs: number;
  onBlock: (block: Float32Array) => void;
}

export interface MicInfo {
  sampleRate: number;
  blockMs: number;
}

/**
 * Microphone capture through an AudioWorklet, with a ScriptProcessor fallback for old browsers. The
 * browser's own processing (echo cancellation, its noise suppression, automatic gain) is asked for,
 * and the app's noise filter runs after it, on the audio thread, when it is on.
 *
 * Opening the microphone takes a moment. A `stop()` that arrives while a `start()` is still waiting
 * for the browser wins: the stream that then arrives is released at once and `start()` returns null,
 * so a quick stop (or a second start) can never leave a forgotten stream holding the mic open.
 */
export class MicCapture {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- kept only as a fallback
  private node: AudioWorkletNode | ScriptProcessorNode | null = null;
  private workletReady = false;
  /** The noise filter of the ScriptProcessor fallback; the worklet runs its own. */
  private fallbackFilter: NoiseFilter | null = null;
  private noiseFilter = true;
  /** Bumped by every start and stop; a start whose number is stale was overtaken and gives up. */
  private generation = 0;

  static async listDevices(): Promise<MediaDeviceInfo[]> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default');
    } catch {
      return [];
    }
  }

  get sampleRate(): number {
    return this.context?.sampleRate ?? 48000;
  }

  get running(): boolean {
    return this.stream !== null;
  }

  /** Whether the noise filter is on; takes effect at once, mid-stream too. */
  get filtering(): boolean {
    return this.noiseFilter;
  }

  /** Turns the noise filter on or off, without reopening the microphone. */
  setNoiseFilter(on: boolean): void {
    this.noiseFilter = on;
    if (this.node && 'port' in this.node) {
      this.node.port.postMessage((on ? 'filter-on' : 'filter-off') satisfies CaptureMessage);
    } else if (this.node && this.context) {
      if (on) this.fallbackFilter ??= new NoiseFilter(this.context.sampleRate);
      else this.fallbackFilter = null;
    }
  }

  /** Opens the microphone; null when a stop (or another start) overtook this one while it was opening. */
  async start(options: MicStartOptions): Promise<MicInfo | null> {
    if (this.stream) this.stop();
    this.noiseFilter = options.noiseFilter;
    const gen = ++this.generation;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: options.deviceId ? { exact: options.deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
    if (gen !== this.generation) {
      for (const track of stream.getTracks()) track.stop();
      return null;
    }
    this.stream = stream;
    const ctx = await acquireAudio('mic');
    if (ctx !== this.context) this.workletReady = false; // a new context has no modules yet
    this.context = ctx;
    let worklet = this.workletReady;
    if (!worklet) {
      try {
        await ctx.audioWorklet.addModule(processorUrl);
        this.workletReady = worklet = true;
      } catch (error) {
        console.warn('AudioWorklet unavailable, falling back to ScriptProcessor', error);
      }
    }
    // a stop during the waits above has already released the stream
    if (gen !== this.generation) {
      releaseAudio('mic');
      return null;
    }
    const size = Math.round((ctx.sampleRate * options.blockMs) / 1000);
    const blockMs = (size / ctx.sampleRate) * 1000;
    this.source = ctx.createMediaStreamSource(stream);
    if (worklet) {
      try {
        const node = new AudioWorkletNode(ctx, 'one-take-capture', {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 1,
          channelCountMode: 'explicit',
          processorOptions: { size, filter: this.noiseFilter },
        });
        node.port.onmessage = (e: MessageEvent<Float32Array>) => options.onBlock(e.data);
        this.source.connect(node);
        this.node = node;
      } catch (error) {
        console.warn('AudioWorkletNode failed, falling back to ScriptProcessor', error);
        worklet = false;
      }
    }
    if (!worklet) {
      /* eslint-disable @typescript-eslint/no-deprecated -- ScriptProcessor is the only fallback where AudioWorklet is missing */
      const node = ctx.createScriptProcessor(1024, 1, 1);
      this.fallbackFilter = this.noiseFilter ? new NoiseFilter(ctx.sampleRate) : null;
      let acc = new Float32Array(size);
      let n = 0;
      node.onaudioprocess = (ev) => {
        const raw = ev.inputBuffer.getChannelData(0);
        const data = this.fallbackFilter ? this.fallbackFilter.process(raw) : raw;
        for (const sample of data) {
          acc[n++] = sample;
          if (n === size) {
            options.onBlock(acc);
            acc = new Float32Array(size);
            n = 0;
          }
        }
      };
      this.source.connect(node);
      node.connect(ctx.destination);
      this.node = node;
      /* eslint-enable @typescript-eslint/no-deprecated */
    }
    return { sampleRate: ctx.sampleRate, blockMs };
  }

  stop(): void {
    this.generation++;
    if (this.node) {
      if ('port' in this.node) {
        // tells the processor to let go: a worklet node that keeps returning true would otherwise
        // run on the audio thread for the life of the context, one more after every restart
        this.node.port.postMessage('stop' satisfies CaptureMessage);
        this.node.port.onmessage = null;
      }
      try {
        this.node.disconnect();
      } catch {
        /* already disconnected */
      }
      this.node = null;
    }
    this.fallbackFilter = null;
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        /* already disconnected */
      }
      this.source = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
      releaseAudio('mic');
    }
  }
}
