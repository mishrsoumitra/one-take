/**
 * The segmenter worker: tells the speaker from the background in a camera frame with MediaPipe's
 * Image Segmenter (the selfie model), off the main thread. For each frame it is handed it answers
 * with one confidence per pixel, 0 for background and 1 for the person, at the frame's own size.
 */
import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';

export type SegmenterRequest =
  | { type: 'init'; model: ArrayBuffer; wasmBase: string }
  | { type: 'segment'; id: number; frame: ImageBitmap };

export type SegmenterResponse =
  | { type: 'ready'; loadMs: number; delegate: 'GPU' | 'CPU' }
  | { type: 'error'; message: string }
  /** The person mask: `width × height` confidences in row order. */
  | { type: 'mask'; id: number; width: number; height: number; mask: Float32Array };

const scope = self as unknown as {
  postMessage(message: SegmenterResponse, transfer?: Transferable[]): void;
};
let segmenter: ImageSegmenter | null = null;
let lastStamp = 0;

async function init(model: ArrayBuffer, wasmBase: string): Promise<void> {
  const started = performance.now();
  const vision = await FilesetResolver.forVisionTasks(wasmBase, true);
  const bytes = new Uint8Array(model);
  let delegate: 'GPU' | 'CPU' = 'GPU';
  const create = () =>
    ImageSegmenter.createFromOptions(vision, {
      baseOptions: { modelAssetBuffer: bytes, delegate },
      runningMode: 'VIDEO',
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    });
  try {
    segmenter = await create();
  } catch (error) {
    console.warn('Image Segmenter on the GPU failed; trying the CPU', error);
    delegate = 'CPU';
    segmenter = await create();
  }
  scope.postMessage({ type: 'ready', loadMs: Math.round(performance.now() - started), delegate });
}

function segment(id: number, frame: ImageBitmap): void {
  try {
    if (!segmenter) throw new Error('the segmenter is not loaded');
    const stamp = Math.max(lastStamp + 1, Math.round(performance.now()));
    lastStamp = stamp;
    const result = segmenter.segmentForVideo(frame, stamp);
    try {
      // the selfie model's confidence masks: index 0 is the background, index 1 the person
      const masks = result.confidenceMasks ?? [];
      const person = masks[1] ?? masks[0];
      if (!person) throw new Error('the segmenter gave no mask');
      const data = Float32Array.from(person.getAsFloat32Array());
      if (masks.length === 1) for (let i = 0; i < data.length; i++) data[i] = 1 - (data[i] ?? 0);
      scope.postMessage({ type: 'mask', id, width: person.width, height: person.height, mask: data }, [
        data.buffer,
      ]);
    } finally {
      result.close();
    }
  } catch (error) {
    scope.postMessage({ type: 'error', message: `${id}:${(error as Error).message}` });
  } finally {
    frame.close();
  }
}

self.onmessage = (event: MessageEvent<SegmenterRequest>) => {
  const message = event.data;
  switch (message.type) {
    case 'init':
      init(message.model, message.wasmBase).catch((error: unknown) => {
        scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      });
      break;
    case 'segment':
      segment(message.id, message.frame);
      break;
  }
};
