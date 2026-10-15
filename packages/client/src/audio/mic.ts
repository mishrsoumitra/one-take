import { NoiseFilter } from '../core/denoise.js';

// eslint-disable-next-line import-x/default -- Vite's `?worker&url` import is the bundled worklet's URL
import processorUrl from './capture-processor.ts?worker&url';
import { acquireAudio, releaseAudio } from './context.js';
import { DeepFilter } from './deepfilter.js';

// `import type`, never a plain import: anything else would bundle the worklet into the page, where
// AudioWorkletProcessor does not exist
import type { CaptureMessage } from './capture-processor.js';

/**
 * Which noise filter runs over the microphone before anything hears it:
 * - `deep`: DeepFilterNet3 (`deepfilter.ts`), a trained model that takes fans, typing, traffic,
 *   music and chatter out; the browser's own suppression is turned off under it. Where it cannot
 *   run (an old browser, a slow machine) the classic filter stands in.
 * - `classic`: the readable DSP filter (`core/denoise.ts`), for steady noise.
 * - `off`: only what the browser does on its own.
 */
export type NoiseFilterMode = 'deep' | 'classic' | 'off';

export interface MicStartOptions {
  deviceId?: string;
  noiseFilter: NoiseFilterMode;
  /** Block length handed to the detector, in milliseconds. */
  blockMs: number;
  onBlock: (block: Float32Array) => void;
  /** The filter that is really running changed: the deep one came up, or gave way to the classic one. */
  onEngineChange?: (engine: NoiseFilterMode) => void;
}

export interface MicInfo {
  sampleRate: number;
  blockMs: number;
}

/**
 * Microphone capture through an AudioWorklet, with a ScriptProcessor fallback for old browsers. The
 * browser's own processing (echo cancellation, automatic gain, and its noise suppression unless the
 * deep filter is on) is asked for; the app's own filter runs after it, on the audio thread:
 * `source → DeepFilterNet3 → capture` or `source → capture`, the capture worklet running the classic
 * filter when that is the one wanted. The deep filter takes a moment to load, so the classic one
 * covers the wait; a machine that cannot keep up gets the classic one for good.
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
  /** The deep filter's node, once loaded; kept across microphone sessions. */
  private readonly deep = new DeepFilter();
  private deepNode: AudioWorkletNode | null = null;
  private wanted: NoiseFilterMode = 'deep';
  private _engine: NoiseFilterMode = 'off';
  private onEngineChange: ((engine: NoiseFilterMode) => void) | null = null;
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

  /** Whether a noise filter of any kind is running over the microphone right now. */
  get filtering(): boolean {
    return this._engine !== 'off';
  }

  /** The filter that is really running (`off` while the mic is closed). */
  get engine(): NoiseFilterMode {
    return this._engine;
  }

  /** The filter asked for. */
  get wantedFilter(): NoiseFilterMode {
    return this.wanted;
  }

  /** Why the deep filter is not running although it was asked for; null while it can. */
  get deepNote(): string | null {
    return this.deep.unavailable;
  }

  /** Chooses the noise filter; takes effect at once, mid-stream too, without reopening the microphone. */
  setNoiseFilter(mode: NoiseFilterMode): void {
    this.wanted = mode;
    if (this.node) void this.applyFilter();
    // the browser's own suppression gets out of the deep filter's way, and comes back without it
    const track = this.stream?.getAudioTracks()[0];
    if (track) {
      track.applyConstraints({ noiseSuppression: mode !== 'deep' }).catch(() => {
        /* a browser that cannot change it live keeps what it has */
      });
    }
  }

  /** Opens the microphone; null when a stop (or another start) overtook this one while it was opening. */
  async start(options: MicStartOptions): Promise<MicInfo | null> {
    if (this.stream) this.stop();
    this.wanted = options.noiseFilter;
    this.onEngineChange = options.onEngineChange ?? null;
    const gen = ++this.generation;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: options.deviceId ? { exact: options.deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: this.wanted !== 'deep',
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
    if (ctx !== this.context) {
      this.workletReady = false; // a new context has no modules yet
      this.deep.dispose();
      this.deepNode = null;
    }
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
          processorOptions: { size, filter: false },
        });
        node.port.onmessage = (e: MessageEvent<Float32Array>) => options.onBlock(e.data);
        this.node = node;
      } catch (error) {
        console.warn('AudioWorkletNode failed, falling back to ScriptProcessor', error);
        worklet = false;
      }
    }
    if (!worklet) {
      /* eslint-disable @typescript-eslint/no-deprecated -- ScriptProcessor is the only fallback where AudioWorklet is missing */
      const node = ctx.createScriptProcessor(1024, 1, 1);
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
      node.connect(ctx.destination);
      this.node = node;
      /* eslint-enable @typescript-eslint/no-deprecated */
    }
    this._engine = 'off';
    await this.applyFilter();
    if (gen !== this.generation) return null;
    return { sampleRate: ctx.sampleRate, blockMs };
  }

  /**
   * Puts the wanted filter in the chain. The deep filter is loaded on first use, the classic one
   * standing in meanwhile; when it cannot run here the classic one stays.
   */
  private async applyFilter(): Promise<void> {
    const gen = this.generation;
    const ctx = this.context;
    const node = this.node;
    if (!ctx || !node) return;
    // the deep filter needs worklets; without them the classic one stands in for it
    const deepWanted = this.wanted === 'deep' && 'port' in node;
    if (!deepWanted) {
      this.wire(null, this.wanted === 'deep' ? 'classic' : this.wanted);
      return;
    }
    if (!this.deepNode) {
      this.wire(null, 'classic');
      const deepNode = await this.deep.node(ctx, {
        onOverload: () => {
          this.deepNode = null;
          if (this.node && this.wanted === 'deep') this.wire(null, 'classic');
        },
      });
      if (gen !== this.generation || !this.node) return; // stopped or restarted meanwhile
      if (!deepNode) return; // the classic filter stays; `deepNote` says why
      this.deepNode = deepNode;
    }
    // the choice may have changed during the wait
    if (this.wanted === 'deep') this.wire(this.deepNode, 'deep');
    else this.wire(null, this.wanted);
  }

  /** Connects `source → (deep →) capture` and switches the classic filter on or off in the capture node. */
  private wire(deepNode: AudioWorkletNode | null, engine: NoiseFilterMode): void {
    const { source, node, context } = this;
    if (!source || !node || !context) return;
    source.disconnect();
    this.deepNode?.disconnect();
    if (deepNode) {
      source.connect(deepNode);
      deepNode.connect(node);
    } else {
      source.connect(node);
    }
    const classic = engine === 'classic';
    if ('port' in node)
      node.port.postMessage((classic ? 'filter-on' : 'filter-off') satisfies CaptureMessage);
    else this.fallbackFilter = classic ? (this.fallbackFilter ?? new NoiseFilter(context.sampleRate)) : null;
    if (this._engine !== engine) {
      this._engine = engine;
      this.onEngineChange?.(engine);
    }
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
    // the deep node stays loaded for the next session, with nothing feeding it
    this.deepNode?.disconnect();
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
    this._engine = 'off';
    this.onEngineChange = null;
  }
}
