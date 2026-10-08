/**
 * Runs on the audio thread: gathers mono samples into fixed-size blocks and posts each block to the
 * main thread, transferring the buffer so nothing is copied.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  private readonly size: number;
  private buffer: Float32Array;
  private filled = 0;

  constructor(options?: { processorOptions?: Record<string, unknown> }) {
    super(options);
    const size = options?.processorOptions?.size;
    this.size = typeof size === 'number' && size > 0 ? size : 480;
    this.buffer = new Float32Array(this.size);
  }

  override process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const sample of channel) {
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
