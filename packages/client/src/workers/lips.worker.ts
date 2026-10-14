/**
 * The lip worker: watches the camera's frames with MediaPipe's Face Landmarker, off the main
 * thread, and sends back one sample per frame it looks at: when the frame was seen (absolute ms,
 * the same clock the page uses) and how open the mouth was (`core/lips.ts`), or null when no face
 * was in view.
 *
 * The frames come as a stream of VideoFrames (a MediaStreamTrackProcessor's readable, handed over
 * by the page). The landmarker is asked about one frame every `FRAME_MS` at most and the rest are
 * dropped, which is plenty for a mouth and keeps the cost down.
 */
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

import { mouthOpening } from '../core/lips.js';

export type LipsRequest =
  | { type: 'init'; model: ArrayBuffer; wasmBase: string }
  | { type: 'watch'; frames: ReadableStream<VideoFrame> }
  | { type: 'stop' };

export type LipsResponse =
  | { type: 'ready'; loadMs: number; delegate: 'GPU' | 'CPU' }
  | { type: 'error'; message: string }
  | { type: 'sample'; t: number; open: number | null };

/** Frames are looked at this far apart at most (20 a second). */
const FRAME_MS = 50;

const scope = self as unknown as { postMessage(message: LipsResponse): void };
let landmarker: FaceLandmarker | null = null;
let reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
let lastStamp = 0;

async function init(model: ArrayBuffer, wasmBase: string): Promise<void> {
  const started = performance.now();
  // the module build of the runtime: this is a module worker, which cannot importScripts
  const vision = await FilesetResolver.forVisionTasks(wasmBase, true);
  const bytes = new Uint8Array(model);
  let delegate: 'GPU' | 'CPU' = 'GPU';
  const create = () =>
    FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetBuffer: bytes, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    });
  try {
    landmarker = await create();
  } catch (error) {
    console.warn('Face Landmarker on the GPU failed; trying the CPU', error);
    delegate = 'CPU';
    landmarker = await create();
  }
  scope.postMessage({ type: 'ready', loadMs: Math.round(performance.now() - started), delegate });
}

async function watch(frames: ReadableStream<VideoFrame>): Promise<void> {
  reader?.cancel().catch(() => undefined);
  const mine = frames.getReader();
  reader = mine;
  let lastLook = -Infinity;
  for (;;) {
    const { value: frame, done } = await mine.read();
    if (done || reader !== mine) {
      frame?.close();
      break;
    }
    const now = performance.now();
    if (!landmarker || now - lastLook < FRAME_MS) {
      frame.close();
      continue;
    }
    lastLook = now;
    try {
      // the landmarker wants a timestamp that only ever grows
      const stamp = Math.max(lastStamp + 1, Math.round(now));
      lastStamp = stamp;
      const result = landmarker.detectForVideo(frame, stamp);
      const landmarks = result.faceLandmarks[0];
      const open = landmarks
        ? mouthOpening(landmarks, frame.displayWidth / Math.max(1, frame.displayHeight))
        : null;
      scope.postMessage({ type: 'sample', t: performance.timeOrigin + now, open });
    } catch (error) {
      scope.postMessage({ type: 'error', message: (error as Error).message });
    } finally {
      frame.close();
    }
  }
}

self.onmessage = (event: MessageEvent<LipsRequest>) => {
  const message = event.data;
  switch (message.type) {
    case 'init':
      init(message.model, message.wasmBase).catch((error: unknown) => {
        scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      });
      break;
    case 'watch':
      void watch(message.frames);
      break;
    case 'stop':
      reader?.cancel().catch(() => undefined);
      reader = null;
      break;
  }
};
