/* Globals of the AudioWorklet scope, which lib.dom does not declare. */
/** The sample rate of the context the worklet runs in. */
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: { processorOptions?: Record<string, unknown> });
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
declare function registerProcessor(
  name: string,
  processorCtor: new (options?: { processorOptions?: Record<string, unknown> }) => AudioWorkletProcessor,
): void;
