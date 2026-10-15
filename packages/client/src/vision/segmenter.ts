/**
 * The segmenter on the main thread: loads the selfie model into its worker and asks it, frame by
 * frame, which pixels are the speaker. Used by the camera cleanup at export time
 * (`export/camera-clean.ts`), one frame at a time, in order.
 */
import { MODELS } from '@one-take/shared';

import { loadModel, type FetchProgress } from '../models/fetch.js';

import type { SegmenterRequest, SegmenterResponse } from '../workers/segmenter.worker.js';

/** Where the build puts MediaPipe's wasm runtime (see `vite.config.ts`). */
const WASM_BASE = '/vendor/mediapipe';

export interface PersonMask {
  width: number;
  height: number;
  /** One confidence per pixel, row by row: 0 background, 1 the person. */
  mask: Float32Array;
}

export class Segmenter {
  private worker: Worker | null = null;
  private starting: Promise<boolean> | null = null;
  private _note: string | null = null;
  private serial = 0;
  private readonly waiting = new Map<
    number,
    { resolve: (m: PersonMask) => void; reject: (e: Error) => void }
  >();

  constructor(private readonly onProgress?: (p: FetchProgress) => void) {}

  /** Why the segmenter is off, once it has failed. */
  get note(): string | null {
    return this._note;
  }

  get ready(): boolean {
    return this.worker !== null;
  }

  /** Loads the model into the worker; true once it answers. */
  start(): Promise<boolean> {
    if (this.worker) return Promise.resolve(true);
    if (this._note) return Promise.resolve(false);
    this.starting ??= this.load().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async load(): Promise<boolean> {
    try {
      const model = await loadModel(MODELS.segmenter, this.onProgress);
      const worker = new Worker(new URL('../workers/segmenter.worker.ts', import.meta.url), {
        type: 'module',
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('the segmenter model took too long to load')),
          60_000,
        );
        worker.onmessage = (e: MessageEvent<SegmenterResponse>) => {
          if (e.data.type === 'ready') {
            clearTimeout(timer);
            console.info(`segmenter ready in ${e.data.loadMs} ms on the ${e.data.delegate}`);
            resolve();
          } else if (e.data.type === 'error') {
            clearTimeout(timer);
            reject(new Error(e.data.message));
          }
        };
        worker.onerror = (e) => {
          clearTimeout(timer);
          reject(new Error(e.message || 'the segmenter worker failed'));
        };
        worker.postMessage({ type: 'init', model, wasmBase: WASM_BASE } satisfies SegmenterRequest, [model]);
      });
      worker.onmessage = (e: MessageEvent<SegmenterResponse>) => this.onMessage(e.data);
      worker.onerror = (e) => console.warn('segmenter worker', e.message);
      this.worker = worker;
      return true;
    } catch (error) {
      this._note = (error as Error).message;
      console.warn('the segmenter is off:', error);
      return false;
    }
  }

  private onMessage(message: SegmenterResponse): void {
    if (message.type === 'mask') {
      const pending = this.waiting.get(message.id);
      this.waiting.delete(message.id);
      pending?.resolve({ width: message.width, height: message.height, mask: message.mask });
    } else if (message.type === 'error') {
      const [id, ...rest] = message.message.split(':');
      const pending = this.waiting.get(Number(id));
      if (pending) {
        this.waiting.delete(Number(id));
        pending.reject(new Error(rest.join(':')));
      } else console.warn('segmenter worker:', message.message);
    }
  }

  /** The person mask of a frame; the bitmap is handed to the worker and closed there. */
  segment(frame: ImageBitmap): Promise<PersonMask> {
    const worker = this.worker;
    if (!worker) {
      frame.close();
      return Promise.reject(new Error(this._note ?? 'the segmenter is not loaded'));
    }
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      worker.postMessage({ type: 'segment', id, frame } satisfies SegmenterRequest, [frame]);
    });
  }

  stop(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const pending of this.waiting.values()) pending.reject(new Error('the segmenter was stopped'));
    this.waiting.clear();
  }
}
