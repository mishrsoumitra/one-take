/**
 * For browsers without WebCodecs: play the lecture in real time into a MediaRecorder. Slow, WebM only,
 * but it works everywhere the microphone works.
 */
import { type Slide } from '../app/types.js';
import { segmentToFloat } from '../core/pcm.js';
import { type Timeline } from '../core/timeline.js';

import { ExportCancelledError } from './encoder.js';

export interface RealtimeOptions {
  timeline: Timeline;
  slides: readonly Slide[];
  width: number;
  height: number;
  fps: number;
  videoBitrateKbps: number;
  signal: AbortSignal;
  onProgress: (fraction: number, nowSec: number, totalSec: number) => void;
}

export function canRecordRealtime(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function'
  );
}

export async function recordRealtime(options: RealtimeOptions): Promise<Blob> {
  const { timeline, slides, width, height, signal } = options;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('Canvas 2D is not available');
  const ctx = new AudioContext();
  await ctx.resume();
  const dest = ctx.createMediaStreamDestination();
  const stream = new MediaStream([
    ...canvas.captureStream(Math.max(1, Math.min(30, options.fps))).getVideoTracks(),
    ...dest.stream.getAudioTracks(),
  ]);
  const mime =
    ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) =>
      MediaRecorder.isTypeSupported(m),
    ) ?? '';
  const recorder = new MediaRecorder(
    stream,
    mime ? { mimeType: mime, videoBitsPerSecond: options.videoBitrateKbps * 1000 } : undefined,
  );
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  const bitmaps = new Map<number, ImageBitmap>();
  const draw = async (index: number) => {
    let bmp = bitmaps.get(index);
    if (!bmp) {
      const slide = slides[index];
      if (!slide) return;
      bmp = await createImageBitmap(slide.blob);
      bitmaps.set(index, bmp);
    }
    g.fillStyle = '#000';
    g.fillRect(0, 0, width, height);
    const s = Math.min(width / bmp.width, height / bmp.height);
    const dw = Math.round(bmp.width * s);
    const dh = Math.round(bmp.height * s);
    g.drawImage(bmp, (width - dw) / 2, (height - dh) / 2, dw, dh);
  };
  const first = timeline.items[0];
  if (!first) throw new Error('Nothing to export');
  await draw(first.seg.slide);
  recorder.start(1000);
  const t0 = ctx.currentTime + 0.3;
  const sources: AudioBufferSourceNode[] = [];
  let next = 0;
  let cur = 0;
  let shown = -1;
  let lastDraw = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (signal.aborted) {
          clearInterval(timer);
          reject(new ExportCancelledError());
          return;
        }
        const now = ctx.currentTime - t0;
        while (next < timeline.items.length) {
          const it = timeline.items[next];
          if (!it || it.start >= now + 2) break;
          const floats = segmentToFloat(
            it.seg.pcm,
            it.seg.sampleRate,
            it.seg.sampleRate,
            it.fadeIn,
            it.fadeOut,
          );
          const buffer = ctx.createBuffer(1, floats.length, it.seg.sampleRate);
          buffer.copyToChannel(floats, 0);
          const src = ctx.createBufferSource();
          src.buffer = buffer;
          src.connect(dest);
          src.start(Math.max(ctx.currentTime, t0 + it.start));
          sources.push(src);
          next++;
        }
        while (cur < timeline.items.length && now >= (timeline.items[cur]?.end ?? Infinity)) cur++;
        if (cur >= timeline.items.length) {
          clearInterval(timer);
          resolve();
          return;
        }
        const slide = timeline.items[cur]?.seg.slide ?? 0;
        if (slide !== shown || now - lastDraw > 0.5) {
          shown = slide;
          lastDraw = now;
          void draw(slide);
        }
        options.onProgress(Math.max(0, now) / timeline.total, Math.max(0, now), timeline.total);
      }, 40);
    });
    await new Promise((r) => setTimeout(r, 400));
  } finally {
    for (const s of sources) {
      try {
        s.stop();
      } catch {
        /* not started */
      }
    }
    recorder.stop();
    await stopped;
    await ctx.close();
    for (const b of bitmaps.values()) b.close();
  }
  return new Blob(chunks, { type: mime || 'video/webm' });
}
