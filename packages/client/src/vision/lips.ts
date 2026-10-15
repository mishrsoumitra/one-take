/**
 * The lip check on the main thread: opens the camera, hands its frames to the lip worker
 * (`workers/lips.worker.ts`, MediaPipe's Face Landmarker) and keeps the samples that come back in a
 * `LipTrack`, so a phrase can ask what the mouth was doing over its span. The camera's stream is
 * also there for a self-view, so the speaker can see they are in the frame. When the camera is
 * already open to be recorded (`video/camera.ts`), a clone of its track is watched instead of
 * opening the device a second time; each side stops its own track and leaves the other's alone.
 *
 * Chrome's `MediaStreamTrackProcessor` is what gets the frames to the worker without the page in
 * the way; a browser without it gets no lip check, and says why.
 */
import { MODELS } from '@one-take/shared';

import { LipTrack, type LipActivity, type LipSample } from '../core/lips.js';
import { loadModel, type FetchProgress } from '../models/fetch.js';

import type { LipsRequest, LipsResponse } from '../workers/lips.worker.js';

export type LipWatcherState = 'off' | 'starting' | 'watching' | 'failed';

/** Where the build puts MediaPipe's wasm runtime (see `vite.config.ts`). */
const WASM_BASE = '/vendor/mediapipe';

/** A frame size that is plenty for a mouth and cheap to look at. */
const VIDEO = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } };

interface TrackProcessor {
  readable: ReadableStream<VideoFrame>;
}
type TrackProcessorCtor = new (init: { track: MediaStreamTrack }) => TrackProcessor;

function trackProcessor(): TrackProcessorCtor | null {
  const ctor = (globalThis as { MediaStreamTrackProcessor?: TrackProcessorCtor }).MediaStreamTrackProcessor;
  return ctor ?? null;
}

export class LipWatcher {
  readonly track = new LipTrack();
  private worker: Worker | null = null;
  private stream: MediaStream | null = null;
  private _state: LipWatcherState = 'off';
  private _note: string | null = null;
  private _delegate: 'GPU' | 'CPU' | null = null;
  private _shared = false;
  private generation = 0;

  constructor(private readonly onProgress?: (p: FetchProgress) => void) {}

  get state(): LipWatcherState {
    return this._state;
  }

  /** Why the camera is not being watched, once it has failed. */
  get note(): string | null {
    return this._note;
  }

  /** Where the landmarker runs. */
  get delegate(): 'GPU' | 'CPU' | null {
    return this._delegate;
  }

  /** Watching a clone of a track opened elsewhere (the recorded camera) rather than its own stream. */
  get shared(): boolean {
    return this._shared;
  }

  /** The camera's stream, for a self-view, while it is open. */
  get video(): MediaStream | null {
    return this.stream;
  }

  /** The newest sample, or null before the first. */
  get latest(): LipSample | null {
    return this.track.latest;
  }

  static async listDevices(): Promise<MediaDeviceInfo[]> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'videoinput' && d.deviceId && d.deviceId !== 'default');
    } catch {
      return [];
    }
  }

  /**
   * Opens the camera and starts watching; false (with `note` set) when that cannot be done here.
   * With `shared` (the track of a camera already open), a clone of it is watched instead.
   */
  async start(deviceId?: string, shared?: MediaStreamTrack | null): Promise<boolean> {
    this.stop();
    const gen = ++this.generation;
    const Processor = trackProcessor();
    if (!Processor) {
      this.fail('the lip check needs Chrome or Edge (MediaStreamTrackProcessor)');
      return false;
    }
    this._state = 'starting';
    this._note = null;
    try {
      const borrow = shared?.readyState === 'live';
      const stream = borrow
        ? new MediaStream([shared.clone()])
        : await navigator.mediaDevices.getUserMedia({
            video: { ...VIDEO, deviceId: deviceId ? { exact: deviceId } : undefined },
            audio: false,
          });
      if (gen !== this.generation) {
        for (const t of stream.getTracks()) t.stop();
        return false;
      }
      this.stream = stream;
      this._shared = borrow;
      const [model, worker] = await Promise.all([loadModel(MODELS.face, this.onProgress), this.spawn()]);
      if (gen !== this.generation) return false;
      await this.ready(worker, model);
      if (gen !== this.generation) return false;
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('the camera gave no video track');
      const frames = new Processor({ track }).readable;
      worker.postMessage({ type: 'watch', frames } satisfies LipsRequest, [frames]);
      this._state = 'watching';
      return true;
    } catch (error) {
      if (gen === this.generation) this.fail((error as Error).message);
      return false;
    }
  }

  private spawn(): Promise<Worker> {
    const worker = new Worker(new URL('../workers/lips.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    return Promise.resolve(worker);
  }

  private ready(worker: Worker, model: ArrayBuffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the face model took too long to load')), 60_000);
      worker.onmessage = (e: MessageEvent<LipsResponse>) => {
        if (e.data.type === 'ready') {
          clearTimeout(timer);
          this._delegate = e.data.delegate;
          console.info(`face model ready in ${e.data.loadMs} ms on the ${e.data.delegate}`);
          worker.onmessage = (ev: MessageEvent<LipsResponse>) => this.onMessage(ev.data);
          resolve();
        } else if (e.data.type === 'error') {
          clearTimeout(timer);
          reject(new Error(e.data.message));
        }
      };
      worker.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error(e.message || 'the lip worker failed'));
      };
      worker.postMessage({ type: 'init', model, wasmBase: WASM_BASE } satisfies LipsRequest, [model]);
    });
  }

  private onMessage(message: LipsResponse): void {
    if (message.type === 'sample') this.track.push({ t: message.t, open: message.open });
    else if (message.type === 'error') console.warn('lip worker:', message.message);
  }

  private fail(note: string): void {
    this.stop();
    this._state = 'failed';
    this._note = note;
    console.warn('the lip check is off:', note);
  }

  /** What the camera saw between two moments (absolute ms). */
  activity(from: number, to: number): LipActivity {
    return this.track.activity(from, to);
  }

  stop(): void {
    this.generation++;
    this.worker?.postMessage({ type: 'stop' } satisfies LipsRequest);
    this.worker?.terminate();
    this.worker = null;
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    this.track.clear();
    this._state = 'off';
    this._delegate = null;
    this._shared = false;
  }
}
