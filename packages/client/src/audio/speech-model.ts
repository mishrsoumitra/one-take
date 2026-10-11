/**
 * Loads the voice model in the browser: ONNX Runtime's WebAssembly build plus the Silero VAD file,
 * both served from this app (nothing is fetched from anywhere else). Loading is lazy and happens
 * once; a browser that cannot run it gets null, and the detector then listens for level alone.
 */
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';

import { SileroModel } from '../core/silero.js';
import { type SpeechModel } from '../core/speech.js';

import modelUrl from './silero/silero_vad.onnx?url';

let loading: Promise<SpeechModel | null> | null = null;

export function loadSpeechModel(): Promise<SpeechModel | null> {
  loading ??= load();
  return loading;
}

async function load(): Promise<SpeechModel | null> {
  try {
    const ort = await import('onnxruntime-web/wasm');
    // the bundle carries its own loader script; only the binary has to be found, at the URL Vite gave it
    ort.env.wasm.wasmPaths = { wasm: wasmUrl };
    // one thread: Silero is tiny, and more would need the page to be cross-origin isolated
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = 'error';
    const response = await fetch(modelUrl);
    if (!response.ok) throw new Error(`model ${response.status}`);
    const session = await ort.InferenceSession.create(await response.arrayBuffer(), {
      executionProviders: ['wasm'],
    });
    return new SileroModel(ort, session);
  } catch (error) {
    console.warn('Voice model unavailable; speech will be detected by level alone', error);
    return null;
  }
}
