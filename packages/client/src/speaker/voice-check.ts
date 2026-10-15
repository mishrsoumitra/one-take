/**
 * The voice check on the main thread: loads the speaker model into its worker, feeds it the
 * microphone while a phrase is being spoken, and answers, when the phrase ends, how close the voice
 * came to the enrolled profile. Also embeds a whole clip for the enrollment itself.
 *
 * The audio is handed over in 100 ms batches to keep the message count low; the worker does the
 * rest (see `workers/speaker.worker.ts`).
 */
import { MODELS } from '@one-take/shared';

import { cosine, SPEAKER_MODEL, type VoiceProfile } from '../core/speaker.js';
import { loadModel, type FetchProgress } from '../models/fetch.js';

import type { SpeakerRequest, SpeakerResponse } from '../workers/speaker.worker.js';

export type VoiceCheckState = 'off' | 'loading' | 'ready' | 'failed';

/** What the check found about one phrase. */
export interface VoiceResult {
  /** The cosine against the profile, or null without a profile or enough speech. */
  similarity: number | null;
  embedding: Float32Array | null;
  /** Seconds of audio the vector came from. */
  seconds: number;
  /** How long the last step took once the phrase had ended, in ms. */
  tailMs: number;
}

/** Audio is sent to the worker in batches of about this long. */
const BATCH_MS = 100;

interface Open {
  rate: number;
  batch: Float32Array[];
  batched: number;
  resolve: ((result: VoiceResult) => void) | null;
}

export class VoiceCheck {
  private worker: Worker | null = null;
  private starting: Promise<boolean> | null = null;
  private _state: VoiceCheckState = 'off';
  private _note: string | null = null;
  private _threads = 0;
  /** Bumped by every `stop()`, so a load that was under way knows it is no longer wanted. */
  private generation = 0;
  private readonly open = new Map<number, Open>();
  private readonly enrolling = new Map<
    number,
    (result: { embedding: Float32Array | null; seconds: number }) => void
  >();
  private enrollSerial = 0;

  constructor(
    /** The enrolled profile, whenever there is one. */
    private readonly profile: () => VoiceProfile | null,
    private readonly onProgress?: (p: FetchProgress) => void,
  ) {}

  get state(): VoiceCheckState {
    return this._state;
  }

  /** Why the check is off, once it has failed. */
  get note(): string | null {
    return this._note;
  }

  /** Worker threads onnxruntime runs the model on (one without cross-origin isolation). */
  get threads(): number {
    return this._threads;
  }

  /** Loads the model into the worker; true once it answers. Safe to call again at any time. */
  start(): Promise<boolean> {
    if (this._state === 'ready') return Promise.resolve(true);
    if (this._state === 'failed') return Promise.resolve(false);
    if (this.starting) return this.starting;
    const load = this.load().finally(() => {
      if (this.starting === load) this.starting = null;
    });
    this.starting = load;
    return load;
  }

  /**
   * Stops the worker and forgets the model, even while it is still loading; a later `start()` loads
   * it again. Anything waiting on a verdict gets none. Used when the enrollment is skipped, so a
   * model that is no longer wanted does not go on loading (and stalling the camera) under the
   * recording that follows.
   */
  stop(): void {
    this.generation++;
    this.starting = null;
    this.worker?.terminate();
    this.worker = null;
    this._state = 'off';
    this._note = null;
    for (const open of this.open.values()) {
      open.resolve?.({ similarity: null, embedding: null, seconds: 0, tailMs: 0 });
    }
    this.open.clear();
    for (const done of this.enrolling.values()) done({ embedding: null, seconds: 0 });
    this.enrolling.clear();
  }

  private async load(): Promise<boolean> {
    const gen = this.generation;
    this._state = 'loading';
    try {
      const model = await loadModel(MODELS.speaker, this.onProgress);
      if (gen !== this.generation) return false; // stopped while the model was fetched
      const worker = new Worker(new URL('../workers/speaker.worker.ts', import.meta.url), { type: 'module' });
      this.worker = worker;
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the voice model took too long to load')), 60_000);
        worker.onmessage = (e: MessageEvent<SpeakerResponse>) => {
          if (e.data.type === 'ready') {
            clearTimeout(timer);
            this._threads = e.data.threads;
            console.info(
              `voice model ${SPEAKER_MODEL.name} ready in ${e.data.loadMs} ms on ${e.data.threads} thread(s)`,
            );
            resolve();
          } else if (e.data.type === 'error') {
            clearTimeout(timer);
            reject(new Error(e.data.message));
          }
        };
        worker.onerror = (e) => {
          clearTimeout(timer);
          reject(new Error(e.message || 'the voice worker failed'));
        };
      });
      worker.postMessage({ type: 'init', model } satisfies SpeakerRequest, [model]);
      await ready;
      if (gen !== this.generation) return false; // stopped while the model loaded: the worker is gone
      worker.onmessage = (e: MessageEvent<SpeakerResponse>) => this.onMessage(e.data);
      worker.onerror = (e) => console.warn('voice worker', e.message);
      this._state = 'ready';
      return true;
    } catch (error) {
      if (gen !== this.generation) return false; // stopped: not a failure
      this._state = 'failed';
      this._note = (error as Error).message;
      console.warn('the voice check is off:', error);
      this.worker?.terminate();
      this.worker = null;
      return false;
    }
  }

  private onMessage(message: SpeakerResponse): void {
    switch (message.type) {
      case 'phrase': {
        const open = this.open.get(message.key);
        if (!open) return;
        this.open.delete(message.key);
        const profile = this.profile();
        const similarity = message.embedding && profile ? cosine(message.embedding, profile.embedding) : null;
        open.resolve?.({
          similarity,
          embedding: message.embedding,
          seconds: message.seconds,
          tailMs: message.tailMs,
        });
        break;
      }
      case 'embedded': {
        const resolve = this.enrolling.get(message.id);
        this.enrolling.delete(message.id);
        resolve?.({ embedding: message.embedding, seconds: message.seconds });
        break;
      }
      case 'error':
        console.warn('voice worker:', message.message);
        break;
      case 'ready':
        break;
    }
  }

  /** A phrase started: its audio follows through `push`. */
  begin(key: number, rate: number): void {
    if (this._state !== 'ready' || !this.worker) return;
    this.open.set(key, { rate, batch: [], batched: 0, resolve: null });
    this.worker.postMessage({ type: 'begin', key, rate } satisfies SpeakerRequest);
  }

  /** The next block of the phrase's audio, at the rate given to `begin`. */
  push(key: number, block: Float32Array): void {
    const open = this.open.get(key);
    if (!open) return;
    open.batch.push(block);
    open.batched += block.length;
    if (open.batched >= (open.rate * BATCH_MS) / 1000) this.flush(key, open);
  }

  private flush(key: number, open: Open): void {
    if (open.batched === 0 || !this.worker) return;
    const samples = new Float32Array(open.batched);
    let at = 0;
    for (const b of open.batch) {
      samples.set(b, at);
      at += b.length;
    }
    open.batch = [];
    open.batched = 0;
    this.worker.postMessage({ type: 'audio', key, samples } satisfies SpeakerRequest, [samples.buffer]);
  }

  /** The phrase ended: resolves with its result once the tail is embedded. */
  end(key: number): Promise<VoiceResult> {
    const open = this.open.get(key);
    if (!open || !this.worker) {
      return Promise.resolve({ similarity: null, embedding: null, seconds: 0, tailMs: 0 });
    }
    this.flush(key, open);
    this.worker.postMessage({ type: 'end', key } satisfies SpeakerRequest);
    return new Promise((resolve) => {
      open.resolve = resolve;
    });
  }

  /** The phrase was thrown away: nothing more is wanted of it. */
  cancel(key: number): void {
    if (!this.open.delete(key)) return;
    this.worker?.postMessage({ type: 'cancel', key } satisfies SpeakerRequest);
  }

  /** Embeds a whole clip (the enrollment); null without enough speech in it. */
  embed(samples: Float32Array, rate: number): Promise<{ embedding: Float32Array | null; seconds: number }> {
    if (this._state !== 'ready' || !this.worker) return Promise.resolve({ embedding: null, seconds: 0 });
    const id = ++this.enrollSerial;
    const copy = Float32Array.from(samples);
    this.worker.postMessage({ type: 'embed', id, samples: copy, rate } satisfies SpeakerRequest, [
      copy.buffer,
    ]);
    return new Promise((resolve) => {
      this.enrolling.set(id, resolve);
    });
  }
}
