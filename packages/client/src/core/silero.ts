/**
 * Silero VAD, the neural voice model, through ONNX Runtime. The model is a small recurrent network
 * (about 2 MB) trained to tell a human voice from everything else: it scores 32 ms of 16 kHz audio
 * from 0 (no voice) to 1 (voice), carrying a memory of the stream from one frame to the next.
 *
 * The model's own protocol: each call takes the 512 new samples with the last 64 samples of the
 * previous frame in front of them (the "context"), the memory from the previous call, and the sample
 * rate; it returns the score and the new memory. This class keeps all of that per stream and makes
 * sure two streams never run on the one session at the same time.
 *
 * The file `audio/silero/silero_vad.onnx` is the model from github.com/snakers4/silero-vad (MIT).
 * Which ONNX Runtime build runs it is up to the caller: the browser build in `audio/speech-model.ts`,
 * the Node build in the tests.
 */
import { SPEECH_FRAME, SPEECH_RATE, type SpeechModel, type SpeechStream } from './speech.js';

// a whole-import `import type` leaves nothing behind in the output; the inline form would keep an
// empty import that drags the full ONNX Runtime bundle (with its 28 MB WebGPU binary) into the build
import type { InferenceSession, Tensor } from 'onnxruntime-web';

/** Samples of the previous frame handed to the model in front of each new frame. */
export const SILERO_CONTEXT = 64;
const STATE_SHAPE = [2, 1, 128] as const;
const STATE_SIZE = 2 * 128;

/** What the model wrapper needs from the ONNX Runtime namespace: the tensor constructor. */
export interface OrtLike {
  Tensor: typeof Tensor;
}

export class SileroModel implements SpeechModel {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly ort: OrtLike,
    private readonly session: InferenceSession,
  ) {}

  stream(): SpeechStream {
    let state: Float32Array = new Float32Array(STATE_SIZE);
    const context = new Float32Array(SILERO_CONTEXT);
    return {
      score: (frame) =>
        this.serialize(async () => {
          if (frame.length !== SPEECH_FRAME) throw new Error(`Silero frame must be ${SPEECH_FRAME} samples`);
          const input = new Float32Array(SILERO_CONTEXT + SPEECH_FRAME);
          input.set(context, 0);
          input.set(frame, SILERO_CONTEXT);
          const out = await this.session.run({
            input: new this.ort.Tensor('float32', input, [1, input.length]),
            state: new this.ort.Tensor('float32', state, [...STATE_SHAPE]),
            sr: new this.ort.Tensor('int64', BigInt64Array.from([BigInt(SPEECH_RATE)]), []),
          });
          const next = out.stateN?.data;
          if (next instanceof Float32Array && next.length === STATE_SIZE) state = next;
          context.set(input.subarray(input.length - SILERO_CONTEXT));
          const score = out.output?.data;
          return score instanceof Float32Array ? (score[0] ?? 0) : 0;
        }),
    };
  }

  /** One run at a time: a session cannot run two inferences at once. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }
}
