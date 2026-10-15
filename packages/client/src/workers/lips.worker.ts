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

import { FACE_FPS, FACE_SIZE, faceBox, faceCropRect, PAD_GREY } from '../core/faces.js';
import { mouthOpening } from '../core/lips.js';

export type LipsRequest =
  | { type: 'init'; model: ArrayBuffer; wasmBase: string; crops: boolean }
  | { type: 'watch'; frames: ReadableStream<VideoFrame> }
  | { type: 'stop' };

export type LipsResponse =
  | { type: 'ready'; loadMs: number; delegate: 'GPU' | 'CPU' }
  | { type: 'error'; message: string }
  /** One frame: when it was seen, how open the mouth was (null without a face), and the mouth crop as a JPEG when asked for. */
  | { type: 'sample'; t: number; open: number | null; crop: ArrayBuffer | null };

/** Frames are looked at this far apart at most: the studio's film runs at 25 a second. */
const FRAME_MS = 1000 / FACE_FPS;
/** The mouth crops are small and grey; this keeps one near two kilobytes. */
const CROP_QUALITY = 0.6;

const scope = self as unknown as {
  postMessage(message: LipsResponse, transfer?: Transferable[]): void;
};
let landmarker: FaceLandmarker | null = null;
let reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
let lastStamp = 0;
/** The 112 × 112 canvas the mouth is cut into, when crops are wanted. */
let cropCanvas: OffscreenCanvas | null = null;
let cropContext: OffscreenCanvasRenderingContext2D | null = null;

/**
 * Cuts the mouth out of the frame the way the studio's model wants it: the face's landmarks give
 * the box, `faceCropRect` the square to take, and the pixels go grey. Returns the JPEG bytes.
 */
async function cropMouth(frame: VideoFrame, landmarks: { x: number; y: number }[]): Promise<ArrayBuffer | null> {
  const g = cropContext;
  const canvas = cropCanvas;
  if (!g || !canvas) return null;
  const box = faceBox(landmarks, frame.displayWidth, frame.displayHeight);
  if (!box) return null;
  const rect = faceCropRect(box);
  g.fillStyle = `rgb(${PAD_GREY}, ${PAD_GREY}, ${PAD_GREY})`;
  g.fillRect(0, 0, FACE_SIZE, FACE_SIZE);
  // drawImage clips the source rectangle to the frame; the grey fill stands in outside it
  const sx = Math.max(0, rect.sx);
  const sy = Math.max(0, rect.sy);
  const ex = Math.min(frame.displayWidth, rect.sx + rect.size);
  const ey = Math.min(frame.displayHeight, rect.sy + rect.size);
  if (ex <= sx || ey <= sy) return null;
  const scale = FACE_SIZE / rect.size;
  g.drawImage(frame, sx, sy, ex - sx, ey - sy, (sx - rect.sx) * scale, (sy - rect.sy) * scale, (ex - sx) * scale, (ey - sy) * scale);
  const image = g.getImageData(0, 0, FACE_SIZE, FACE_SIZE);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const grey = 0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0);
    d[i] = d[i + 1] = d[i + 2] = grey;
  }
  g.putImageData(image, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: CROP_QUALITY });
  return blob.arrayBuffer();
}

async function init(model: ArrayBuffer, wasmBase: string, crops: boolean): Promise<void> {
  if (crops) {
    cropCanvas = new OffscreenCanvas(FACE_SIZE, FACE_SIZE);
    cropContext = cropCanvas.getContext('2d', { willReadFrequently: true });
  }
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
      // the crop reads the frame, so it is made before the frame is closed below
      const crop = landmarks && cropContext ? await cropMouth(frame, landmarks) : null;
      scope.postMessage({ type: 'sample', t: performance.timeOrigin + now, open, crop }, crop ? [crop] : []);
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
      init(message.model, message.wasmBase, message.crops).catch((error: unknown) => {
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
