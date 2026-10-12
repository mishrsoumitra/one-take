/**
 * Runs on the audio thread: runs the microphone through the noise filter when it is on, gathers the
 * mono samples into fixed-size blocks and posts each block to the main thread, transferring the
 * buffer so nothing is copied.
 */
import { NoiseFilter } from '../core/denoise.js';

/** What the main thread may tell the processor. */
export type CaptureMessage = 'stop' | 'filter-on' | 'filter-off';

class CaptureProcessor extends AudioWorkletProcessor {
  private readonly size: number;
  private buffer: Float32Array;
  private filled = 0;
  /** The noise filter, while it is on. */
  private filter: NoiseFilter | null = null;
  /** Set by the 'stop' message; the processor then ends and can be collected. */
  private stopped = false;

  constructor(options?: { processorOptions?: Record<string, unknown> }) {
    super(options);
    const size = options?.processorOptions?.size;
    this.size = typeof size === 'number' && size > 0 ? size : 480;
    this.buffer = new Float32Array(this.size);
    if (options?.processorOptions?.filter === true) this.filter = new NoiseFilter(sampleRate);
    this.port.onmessage = (e: MessageEvent<unknown>) => {
      const message: unknown = e.data;
      if (message === 'stop') this.stopped = true;
      else if (message === 'filter-on') this.filter ??= new NoiseFilter(sampleRate);
      else if (message === 'filter-off') this.filter = null;
    };
  }

  override process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false;
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    const samples = this.filter ? this.filter.process(channel) : channel;
    for (const sample of samples) {
      this.buffer[this.filled++] = sample;
      if (this.filled === this.size) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(this.size);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('one-take-capture', CaptureProcessor);
