import processorUrl from './capture-processor.ts?worker&url';

export interface MicStartOptions {
  deviceId?: string;
  /** Block length handed to the detector, in milliseconds. */
  blockMs: number;
  onBlock: (block: Float32Array) => void;
}

export interface MicInfo {
  sampleRate: number;
  blockMs: number;
}

/** Microphone capture through an AudioWorklet, with a ScriptProcessor fallback for old browsers. */
export class MicCapture {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- kept only as a fallback
  private node: AudioWorkletNode | ScriptProcessorNode | null = null;
  private workletReady = false;

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

  async start(options: MicStartOptions): Promise<MicInfo> {
    if (this.stream) this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: options.deviceId ? { exact: options.deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
    this.context ??= new AudioContext();
    if (this.context.state === 'suspended') await this.context.resume();
    const ctx = this.context;
    const size = Math.round((ctx.sampleRate * options.blockMs) / 1000);
    const blockMs = (size / ctx.sampleRate) * 1000;
    this.source = ctx.createMediaStreamSource(this.stream);
    try {
      if (!this.workletReady) {
        await ctx.audioWorklet.addModule(processorUrl);
        this.workletReady = true;
      }
      const node = new AudioWorkletNode(ctx, 'one-take-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: { size },
      });
      node.port.onmessage = (e: MessageEvent<Float32Array>) => options.onBlock(e.data);
      this.source.connect(node);
      this.node = node;
    } catch (error) {
      /* eslint-disable @typescript-eslint/no-deprecated -- ScriptProcessor is the only fallback where AudioWorklet is missing */
      console.warn('AudioWorklet unavailable, falling back to ScriptProcessor', error);
      const node = ctx.createScriptProcessor(1024, 1, 1);
      let acc = new Float32Array(size);
      let n = 0;
      node.onaudioprocess = (ev) => {
        const data = ev.inputBuffer.getChannelData(0);
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
    if (this.node) {
      try {
        this.node.disconnect();
      } catch {
        /* already disconnected */
      }
      if ('port' in this.node) this.node.port.onmessage = null;
      this.node = null;
    }
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
    }
  }
}
