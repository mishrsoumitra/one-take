import { presentationExtension } from '@one-take/shared';
import * as pdfjs from 'pdfjs-dist';
// eslint-disable-next-line import-x/default -- Vite's ?url import has a default export
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import { type PresentationPick, type Slide, type SlideSource } from '../app/types.js';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** Slides are rasterised at most this large; exports above it are upscaled from here. */
export const MAX_SLIDE_WIDTH = 2560;
export const MAX_SLIDE_HEIGHT = 1440;
const THUMB_WIDTH = 240;

export type SlideProgress = (done: number, total: number) => void;

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode slide image'))),
      type,
      quality,
    );
  });
}

async function slideFromCanvas(canvas: HTMLCanvasElement, index: number): Promise<Slide> {
  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.94);
  const thumbCanvas = document.createElement('canvas');
  const scale = THUMB_WIDTH / canvas.width;
  thumbCanvas.width = THUMB_WIDTH;
  thumbCanvas.height = Math.max(1, Math.round(canvas.height * scale));
  const g = thumbCanvas.getContext('2d');
  if (!g) throw new Error('Canvas 2D is not available');
  g.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
  const thumb = await canvasToBlob(thumbCanvas, 'image/jpeg', 0.8);
  return {
    index,
    width: canvas.width,
    height: canvas.height,
    blob,
    url: URL.createObjectURL(blob),
    thumbUrl: URL.createObjectURL(thumb),
  };
}

async function renderPdf(blob: Blob, onProgress: SlideProgress): Promise<Slide[]> {
  const doc = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
  const slides: Slide[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      onProgress(i, doc.numPages);
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(MAX_SLIDE_WIDTH / base.width, MAX_SLIDE_HEIGHT / base.height);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D is not available');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      slides.push(await slideFromCanvas(canvas, i - 1));
      page.cleanup();
    }
  } finally {
    // Not awaited: tearing down the worker can stall in some browsers, and nothing depends on it.
    void doc.destroy().catch(() => undefined);
  }
  return slides;
}

async function renderImages(files: SlideSource['files'], onProgress: SlideProgress): Promise<Slide[]> {
  const slides: Slide[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file) continue;
    onProgress(i + 1, files.length);
    const bitmap = await createImageBitmap(file.blob);
    const scale = Math.min(1, MAX_SLIDE_WIDTH / bitmap.width, MAX_SLIDE_HEIGHT / bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    slides.push(await slideFromCanvas(canvas, i));
  }
  return slides;
}

export async function loadSlides(
  source: SlideSource,
  onProgress: SlideProgress = () => undefined,
): Promise<Slide[]> {
  const first = source.files[0];
  if (!first) throw new Error('No slide files');
  const slides =
    source.kind === 'pdf'
      ? await renderPdf(first.blob, onProgress)
      : await renderImages(source.files, onProgress);
  if (slides.length === 0) throw new Error('No slides found in the file');
  return slides;
}

export function releaseSlides(slides: readonly Slide[]): void {
  for (const s of slides) {
    URL.revokeObjectURL(s.url);
    URL.revokeObjectURL(s.thumbUrl);
  }
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Turns a drop or file-input selection into a slide source, a presentation that still needs converting,
 * or null when nothing usable was chosen. A PDF wins over a presentation, which wins over images.
 */
export function slideSourceFromFiles(fileList: Iterable<File>): SlideSource | PresentationPick | null {
  const files = [...fileList];
  const pdf = files.find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (pdf) return { kind: 'pdf', files: [{ name: pdf.name, type: 'application/pdf', blob: pdf }] };
  for (const file of files) {
    const extension = presentationExtension(file.name);
    if (extension) return { kind: 'presentation', file, extension };
  }
  const images = files
    .filter((f) => f.type.startsWith('image/'))
    .sort((a, b) => naturalCompare(a.name, b.name));
  if (images.length === 0) return null;
  return { kind: 'images', files: images.map((f) => ({ name: f.name, type: f.type, blob: f })) };
}
