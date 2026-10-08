/**
 * Renders a timeline into a video file with WebCodecs, faster than real time.
 *
 * Large exports are the normal case here, so the whole pipeline streams: the muxer writes positioned
 * chunks into the target, every `add()` awaits the encoder's queue (back-pressure), slide bitmaps are
 * cached in a small LRU, and timestamps are computed from integer counters so hours of video never drift.
 *
 * Slides are still images, so a slide is drawn once and captured into one VideoFrame; every frame of
 * that slide is a reference clone of it with a new timestamp (no pixel copy, no canvas read-back). The
 * plan says whether to ask for the GPU encoder and the `realtime` latency mode (see shared/performance).
 */
import { type BrowserContainer, type BrowserEncodePlan } from '@one-take/shared';
import {
  AudioSample,
  AudioSampleSource,
  MkvOutputFormat,
  MovOutputFormat,
  Mp4OutputFormat,
  Output,
  VideoSample,
  VideoSampleSource,
  WebMOutputFormat,
  type OutputFormat,
  type Target,
} from 'mediabunny';

import { type Slide } from '../app/types.js';
import { segmentToFloat } from '../core/pcm.js';
import { type Timeline } from '../core/timeline.js';
import { BT709_LIMITED, rgbaToI420 } from '../core/yuv.js';

export const EXPORT_SAMPLE_RATE = 48000;
/** The last slide stays on screen this long after the last word. */
const TAIL_SECONDS = 0.25;
const AUDIO_CHUNK_SECONDS = 0.1;
const BITMAP_CACHE = 8;

export type FastStart = false | 'in-memory' | 'fragmented';

export interface EncodeProgress {
  frames: number;
  totalFrames: number;
  seconds: number;
  totalSeconds: number;
  bytes: number;
  phrase: number;
  totalPhrases: number;
}

export interface EncodeOptions {
  timeline: Timeline;
  slides: readonly Slide[];
  plan: BrowserEncodePlan;
  target: Target;
  fastStart: FastStart;
  /** The target supports writes at arbitrary positions (files, the server); false for append-only streams. */
  seekable: boolean;
  signal: AbortSignal;
  onProgress: (progress: EncodeProgress) => void;
}

export interface EncodeResult {
  frames: number;
  bytes: number;
  seconds: number;
  videoCodecString: string | null;
  /** What WebCodecs was configured with, for the result panel and the tests. */
  encoder: { hardwareAcceleration: string; latencyMode: string } | null;
}

export class ExportCancelledError extends Error {
  constructor() {
    super('Export cancelled');
    this.name = 'ExportCancelledError';
  }
}

export function makeOutputFormat(
  container: BrowserContainer,
  fastStart: FastStart,
  seekable: boolean,
): OutputFormat {
  switch (container) {
    case 'mp4':
      return new Mp4OutputFormat({ fastStart });
    case 'fmp4':
      return new Mp4OutputFormat({ fastStart: 'fragmented' });
    case 'mov':
      return new MovOutputFormat({ fastStart });
    case 'mkv':
      return new MkvOutputFormat({ appendOnly: !seekable });
    case 'webm':
      return new WebMOutputFormat({ appendOnly: !seekable });
  }
}

export function totalFrames(timeline: Timeline, fps: number): number {
  return Math.ceil((timeline.total + TAIL_SECONDS) * fps);
}

type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A drawing surface off the page when the browser has one (no layout, no compositor involvement). */
function makeCanvas(
  width: number,
  height: number,
): { canvas: HTMLCanvasElement | OffscreenCanvas; g: Canvas2D } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const g = canvas.getContext('2d', { alpha: false });
    if (g) return { canvas, g };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d', { alpha: false });
  if (!g) throw new Error('Canvas 2D is not available');
  return { canvas, g };
}

class BitmapCache {
  private readonly map = new Map<number, ImageBitmap>();

  constructor(
    private readonly slides: readonly Slide[],
    private readonly width: number,
    private readonly height: number,
  ) {}

  /** The slide decoded and already scaled to fit the frame, so drawing it is a plain copy. */
  async get(index: number): Promise<ImageBitmap> {
    const hit = this.map.get(index);
    if (hit) {
      this.map.delete(index);
      this.map.set(index, hit);
      return hit;
    }
    const slide = this.slides[index];
    if (!slide) throw new Error(`Slide ${index + 1} is missing`);
    const s = Math.min(this.width / slide.width, this.height / slide.height);
    const bmp = await createImageBitmap(slide.blob, {
      resizeWidth: Math.max(1, Math.round(slide.width * s)),
      resizeHeight: Math.max(1, Math.round(slide.height * s)),
      resizeQuality: 'high',
    });
    this.map.set(index, bmp);
    while (this.map.size > BITMAP_CACHE) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.get(oldest)?.close();
      this.map.delete(oldest);
    }
    return bmp;
  }

  dispose(): void {
    for (const b of this.map.values()) b.close();
    this.map.clear();
  }
}

export async function encodeLecture(options: EncodeOptions): Promise<EncodeResult> {
  const { timeline, slides, plan, target, signal } = options;
  const { width, height, fps } = plan;
  const rate = EXPORT_SAMPLE_RATE;
  if (signal.aborted) throw new ExportCancelledError();

  const { canvas, g } = makeCanvas(width, height);

  let bytes = 0;
  const offWrite = target.on('write', ({ end }) => {
    bytes = Math.max(bytes, end);
  });
  const aborted = () => signal.aborted;

  const output = new Output({
    format: makeOutputFormat(plan.container, options.fastStart, options.seekable),
    target,
  });
  let codecString: string | null = null;
  let encoderConfig: EncodeResult['encoder'] = null;
  const video = new VideoSampleSource({
    codec: plan.videoCodec,
    bitrate: plan.videoBitrateKbps * 1000,
    bitrateMode: 'variable',
    latencyMode: plan.latencyMode,
    keyFrameInterval: plan.keyFrameIntervalSec,
    hardwareAcceleration: plan.hardwareAcceleration,
    onEncoderConfig: (config) => {
      codecString = config.codec;
      encoderConfig = {
        hardwareAcceleration: config.hardwareAcceleration ?? 'no-preference',
        latencyMode: config.latencyMode ?? 'quality',
      };
    },
  });
  const audio = new AudioSampleSource({ codec: plan.audioCodec, bitrate: plan.audioBitrateKbps * 1000 });
  output.addVideoTrack(video, { frameRate: fps });
  output.addAudioTrack(audio);

  const bitmaps = new BitmapCache(slides, width, height);
  const frameDuration = 1 / fps;
  const frameTotal = totalFrames(timeline, fps);
  const chunkFrames = Math.round(rate * AUDIO_CHUNK_SECONDS);
  let frames = 0;
  let audioPos = 0; // samples emitted
  let currentSlide = -1;
  /** The current slide as one captured frame; every frame of it is a reference clone of this. */
  let slideFrame: VideoSample | null = null;
  let acc = new Float32Array(chunkFrames);
  let accN = 0;
  let lastProgress = 0;

  const report = (phrase: number) => {
    const now = performance.now();
    if (now - lastProgress < 100 && phrase < timeline.items.length) return;
    lastProgress = now;
    options.onProgress({
      frames,
      totalFrames: frameTotal,
      seconds: frames / fps,
      totalSeconds: timeline.total + TAIL_SECONDS,
      bytes,
      phrase,
      totalPhrases: timeline.items.length,
    });
  };

  const checkAbort = () => {
    if (aborted()) throw new ExportCancelledError();
  };

  /**
   * The slide as one frame, cloned for every video frame of that slide.
   *
   * For a software encoder it is a planar I420 frame in CPU memory: a canvas-backed frame is RGBA on
   * the GPU and the browser converts it again for every `encode()` call, which capped every encoder at
   * about 370 fps for 1080p; one conversion per slide (see core/yuv.ts) lifts Chrome's software H.264
   * encoder to about 570 fps on an M2 Max. A GPU encoder is happier with the canvas frame, which
   * already lives in its memory (the planar frame costs it an upload per frame, about 10 %).
   */
  const planar = !plan.hardware;
  function captureSlide(): VideoSample {
    if (planar) {
      try {
        const pixels = g.getImageData(0, 0, width, height).data;
        const planes = rgbaToI420(pixels, width, height);
        return new VideoSample(planes.data, {
          format: 'I420',
          codedWidth: planes.codedWidth,
          codedHeight: planes.codedHeight,
          layout: planes.layout,
          colorSpace: BT709_LIMITED,
          timestamp: 0,
          duration: frameDuration,
        });
      } catch {
        // fall through to the canvas frame
      }
    }
    return new VideoSample(canvas, { timestamp: 0, duration: frameDuration });
  }

  async function drawSlide(index: number): Promise<VideoSample> {
    if (index === currentSlide && slideFrame) return slideFrame;
    currentSlide = index;
    const bmp = await bitmaps.get(index);
    g.fillStyle = '#000';
    g.fillRect(0, 0, width, height);
    g.drawImage(bmp, Math.round((width - bmp.width) / 2), Math.round((height - bmp.height) / 2));
    slideFrame?.close();
    slideFrame = captureSlide();
    return slideFrame;
  }

  async function pushFrames(untilSec: number, slideIndex: number, keyFirst: boolean): Promise<void> {
    const base = await drawSlide(slideIndex);
    let key = keyFirst;
    while (frames * frameDuration < untilSec - 1e-6) {
      checkAbort();
      const frame = base.clone();
      frame.setTimestamp(frames / fps);
      frame.setDuration(frameDuration);
      try {
        await video.add(frame, key ? { keyFrame: true } : undefined);
      } finally {
        frame.close();
      }
      key = false;
      frames++;
    }
  }

  async function emitAudio(samples: Float32Array): Promise<void> {
    const sample = new AudioSample({
      data: samples,
      format: 'f32',
      numberOfChannels: 1,
      sampleRate: rate,
      timestamp: audioPos / rate,
    });
    audioPos += samples.length;
    await audio.add(sample);
    sample.close();
  }

  async function pushSamples(samples: Float32Array): Promise<void> {
    let i = 0;
    while (i < samples.length) {
      const n = Math.min(chunkFrames - accN, samples.length - i);
      acc.set(samples.subarray(i, i + n), accN);
      accN += n;
      i += n;
      if (accN === chunkFrames) {
        checkAbort();
        await emitAudio(acc);
        acc = new Float32Array(chunkFrames);
        accN = 0;
      }
    }
  }

  try {
    await output.start();
    for (let k = 0; k < timeline.items.length; k++) {
      const it = timeline.items[k];
      if (!it) continue;
      if (it.gap > 0) await pushSamples(new Float32Array(Math.round(it.gap * rate)));
      await pushSamples(segmentToFloat(it.seg.pcm, it.seg.sampleRate, rate, it.fadeIn, it.fadeOut));
      const prev = timeline.items[k - 1];
      await pushFrames(audioPos / rate, it.seg.slide, k === 0 || prev?.seg.slide !== it.seg.slide);
      report(k + 1);
    }
    if (accN > 0) await emitAudio(acc.subarray(0, accN));
    await pushFrames(audioPos / rate + TAIL_SECONDS, Math.max(0, currentSlide), false);
    checkAbort();
    video.close();
    audio.close();
    await output.finalize();
    report(timeline.items.length);
    return { frames, bytes, seconds: audioPos / rate, videoCodecString: codecString, encoder: encoderConfig };
  } catch (error) {
    try {
      if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel();
    } catch {
      /* already torn down */
    }
    if (aborted()) throw new ExportCancelledError();
    throw error;
  } finally {
    (slideFrame as VideoSample | null)?.close();
    bitmaps.dispose();
    offWrite();
  }
}
