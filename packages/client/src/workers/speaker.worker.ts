/**
 * The speaker-embedding worker: runs the voice model (`core/speaker.ts`) through onnxruntime-web's
 * WebAssembly backend, off the main thread.
 *
 * For a phrase being spoken it takes the microphone's audio as it comes, brings it to 16 kHz, and
 * embeds it window by window as `embeddingWindows` says, so that when the phrase ends only its tail
 * is left to do. For an enrollment it embeds one whole clip the same way. Either way the answer is
 * the mean of the windows' vectors, or null when there was too little speech for even one.
 */
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import * as ort from 'onnxruntime-web/wasm';

import { fbank, FBANK_RATE, subtractMean } from '../core/fbank.js';
import { embeddingWindows, meanEmbedding, SPEAKER_MODEL } from '../core/speaker.js';
import { Downsampler } from '../core/speech.js';

export type SpeakerRequest =
  | { type: 'init'; model: ArrayBuffer }
  | { type: 'begin'; key: number; rate: number }
  | { type: 'audio'; key: number; samples: Float32Array }
  | { type: 'end'; key: number }
  | { type: 'cancel'; key: number }
  | { type: 'embed'; id: number; samples: Float32Array; rate: number };

export type SpeakerResponse =
  | { type: 'ready'; threads: number; loadMs: number }
  | { type: 'error'; message: string }
  /** A phrase's vector (null without enough speech) and how long its last step took, in ms. */
  | { type: 'phrase'; key: number; embedding: Float32Array | null; seconds: number; tailMs: number }
  | { type: 'embedded'; id: number; embedding: Float32Array | null; seconds: number };

interface Stream {
  down: Downsampler;
  /** The phrase's audio at 16 kHz so far, in the pieces it came in. */
  pieces: Float32Array[];
  samples: number;
  /** Seconds covered by the windows embedded so far. */
  done: number;
  vectors: { embedding: Float32Array; seconds: number }[];
}

const scope = self as unknown as { postMessage(message: SpeakerResponse, transfer?: Transferable[]): void };
const streams = new Map<number, Stream>();
let session: ort.InferenceSession | null = null;
/** Inference runs one window at a time, in the order the windows became due. */
let queue: Promise<void> = Promise.resolve();

function post(message: SpeakerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

async function embed(samples: Float32Array): Promise<Float32Array> {
  if (!session) throw new Error('the speaker model is not loaded');
  const feats = subtractMean(fbank(samples));
  const input = new ort.Tensor('float32', feats.data, [1, feats.frames, 80]);
  const out = await session.run({ [SPEAKER_MODEL.input]: input });
  const tensor = out[SPEAKER_MODEL.output];
  if (!tensor) throw new Error('the speaker model gave no embedding');
  return Float32Array.from(tensor.data as Float32Array);
}

/** The stream's audio between two points in seconds, as one buffer. */
function slice(stream: Stream, from: number, to: number): Float32Array {
  const start = Math.round(from * FBANK_RATE);
  const end = Math.min(stream.samples, Math.round(to * FBANK_RATE));
  const out = new Float32Array(Math.max(0, end - start));
  let at = 0;
  for (const piece of stream.pieces) {
    const pieceEnd = at + piece.length;
    if (pieceEnd > start && at < end) {
      const a = Math.max(start, at);
      const b = Math.min(end, pieceEnd);
      out.set(piece.subarray(a - at, b - at), a - start);
    }
    at = pieceEnd;
    if (at >= end) break;
  }
  return out;
}

/** Embeds every window that has become due for a stream, in order. */
function schedule(key: number, stream: Stream, final: boolean): Promise<number> {
  const heard = stream.samples / FBANK_RATE;
  const windows = embeddingWindows(stream.done, heard, final);
  if (windows.length === 0) return Promise.resolve(0);
  stream.done = windows[windows.length - 1]?.to ?? stream.done;
  let ms = 0;
  for (const w of windows) {
    queue = queue.then(async () => {
      if (!streams.has(key) && !final) return; // cancelled meanwhile
      const started = performance.now();
      const embedding = await embed(slice(stream, w.from, w.to));
      ms += performance.now() - started;
      stream.vectors.push({ embedding, seconds: w.to - w.from });
    });
  }
  return queue.then(() => ms);
}

async function init(model: ArrayBuffer): Promise<void> {
  const started = performance.now();
  ort.env.wasm.wasmPaths = { wasm: ortWasmUrl };
  session = await ort.InferenceSession.create(model, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  post({
    type: 'ready',
    threads: ort.env.wasm.numThreads ?? 1,
    loadMs: Math.round(performance.now() - started),
  });
}

self.onmessage = (event: MessageEvent<SpeakerRequest>) => {
  const message = event.data;
  switch (message.type) {
    case 'init':
      init(message.model).catch((error: unknown) => {
        post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      });
      break;
    case 'begin':
      streams.set(message.key, {
        down: new Downsampler(message.rate, FBANK_RATE),
        pieces: [],
        samples: 0,
        done: 0,
        vectors: [],
      });
      break;
    case 'audio': {
      const stream = streams.get(message.key);
      if (!stream) break;
      const piece = stream.down.process(message.samples);
      stream.pieces.push(piece);
      stream.samples += piece.length;
      void schedule(message.key, stream, false);
      break;
    }
    case 'end': {
      const stream = streams.get(message.key);
      if (!stream) break;
      streams.delete(message.key);
      const seconds = stream.samples / FBANK_RATE;
      schedule(message.key, stream, true)
        .then((tailMs) => {
          const embedding = stream.vectors.length > 0 ? meanEmbedding(stream.vectors) : null;
          post({ type: 'phrase', key: message.key, embedding, seconds, tailMs: Math.round(tailMs) });
        })
        .catch((error: unknown) => {
          post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
          post({ type: 'phrase', key: message.key, embedding: null, seconds, tailMs: 0 });
        });
      break;
    }
    case 'cancel':
      streams.delete(message.key);
      break;
    case 'embed': {
      const stream: Stream = {
        down: new Downsampler(message.rate, FBANK_RATE),
        pieces: [],
        samples: 0,
        done: 0,
        vectors: [],
      };
      const piece = stream.down.process(message.samples);
      stream.pieces.push(piece);
      stream.samples = piece.length;
      const seconds = stream.samples / FBANK_RATE;
      schedule(-message.id, stream, true)
        .then(() => {
          const embedding = stream.vectors.length > 0 ? meanEmbedding(stream.vectors) : null;
          post({ type: 'embedded', id: message.id, embedding, seconds });
        })
        .catch((error: unknown) => {
          post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
          post({ type: 'embedded', id: message.id, embedding: null, seconds });
        });
      break;
    }
  }
};
