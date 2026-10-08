/**
 * What this browser can do, probed once at start-up: which codecs WebCodecs encodes, which of them the
 * GPU takes (`prefer-hardware` at 1080p and 4K), how many threads and how much memory the browser
 * admits to, and the GPU's name. The export planner uses this to choose codecs and encoder settings
 * for this machine rather than a generic one.
 */
import {
  NO_HARDWARE,
  type BrowserCapabilities,
  type BrowserEncoderBenchmark,
  type HardwareSupport,
  type VideoCodecId,
} from '@one-take/shared';
import { canEncodeVideo, getEncodableAudioCodecs, getEncodableVideoCodecs } from 'mediabunny';

import { BT709_LIMITED, rgbaToI420 } from '../core/yuv.js';

export function hasWebCodecs(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined';
}

export function hasFileSystemAccess(): boolean {
  return typeof window.showSaveFilePicker === 'function';
}

const VIDEO: readonly VideoCodecId[] = ['avc', 'hevc', 'vp9', 'av1'];
const PROBE_SIZES = [
  { width: 1920, height: 1080, bitrate: 4_000_000 },
  { width: 3840, height: 2160, bitrate: 16_000_000 },
] as const;

/** The largest probed height at which `prefer-hardware` is accepted for each codec, 0 when never. */
export async function probeHardwareEncoders(codecs: readonly VideoCodecId[]): Promise<HardwareSupport> {
  const support: HardwareSupport = { ...NO_HARDWARE };
  await Promise.all(
    codecs.map(async (codec) => {
      for (const size of PROBE_SIZES) {
        let ok: boolean;
        try {
          ok = await canEncodeVideo(codec, { ...size, hardwareAcceleration: 'prefer-hardware' });
        } catch {
          ok = false;
        }
        if (!ok) break;
        support[codec] = size.height;
      }
    }),
  );
  return support;
}

const BENCH_FRAMES = 150;
const BENCH_CACHE_KEY = 'one-take.encoder-benchmark.v1';
const BENCH_CACHE_DAYS = 7;

/** Encodes `BENCH_FRAMES` clones of one 1080p planar frame; frames per second, or null when it fails. */
async function timeEncoder(
  base: VideoFrame,
  hardwareAcceleration: 'prefer-hardware' | 'prefer-software',
): Promise<number | null> {
  const config: VideoEncoderConfig = {
    codec: 'avc1.640028',
    width: base.codedWidth,
    height: base.codedHeight,
    bitrate: 5_000_000,
    framerate: 15,
    hardwareAcceleration,
    latencyMode: 'quality',
  };
  try {
    if (!(await VideoEncoder.isConfigSupported(config)).supported) return null;
    let failed = false as boolean; // set from the error callback, which the type checker cannot see
    const encoder = new VideoEncoder({
      output: () => undefined,
      error: () => {
        failed = true;
      },
    });
    encoder.configure(config);
    const started = performance.now();
    for (let i = 0; i < BENCH_FRAMES && !failed; i++) {
      const frame = new VideoFrame(base, { timestamp: i * 66_667, duration: 66_667 });
      encoder.encode(frame, { keyFrame: i % 60 === 0 });
      frame.close();
      if (encoder.encodeQueueSize >= 4) {
        await new Promise((resolve) => encoder.addEventListener('dequeue', resolve, { once: true }));
      }
    }
    await encoder.flush();
    const seconds = (performance.now() - started) / 1000;
    encoder.close();
    return failed || seconds <= 0 ? null : Math.round(BENCH_FRAMES / seconds);
  } catch {
    return null;
  }
}

/**
 * Races the GPU and the software H.264 encoder on a 1080p slide-like frame (about half a second in all)
 * and remembers the answer for a week, keyed by browser and core count. The fastest mode uses whichever
 * won; on an M2 Max that is the software encoder, 700 against 390 fps.
 */
export async function benchmarkAvcEncoders(hasHardware: boolean): Promise<BrowserEncoderBenchmark | null> {
  if (!hasWebCodecs()) return null;
  const cacheKey = `${BENCH_CACHE_KEY}:${navigator.userAgent}:${navigator.hardwareConcurrency}`;
  try {
    const raw = localStorage.getItem(cacheKey);
    if (raw) {
      const cached = JSON.parse(raw) as { at: number; result: BrowserEncoderBenchmark };
      if (Date.now() - cached.at < BENCH_CACHE_DAYS * 86_400_000) return cached.result;
    }
  } catch {
    // no storage, measure again
  }
  const width = 1920;
  const height = 1080;
  let base: VideoFrame;
  try {
    const canvas = new OffscreenCanvas(width, height);
    const g = canvas.getContext('2d', { alpha: false });
    if (!g) return null;
    g.fillStyle = '#1b2a44';
    g.fillRect(0, 0, width, height);
    g.fillStyle = '#fff';
    g.font = '72px sans-serif';
    g.fillText('One Take encoder test', 160, 320);
    g.fillText('slides, text, a picture or two', 160, 440);
    const planes = rgbaToI420(g.getImageData(0, 0, width, height).data, width, height);
    base = new VideoFrame(planes.data, {
      format: 'I420',
      codedWidth: width,
      codedHeight: height,
      layout: planes.layout,
      colorSpace: BT709_LIMITED,
      timestamp: 0,
    });
  } catch {
    return null;
  }
  try {
    const hardwareFps = hasHardware ? await timeEncoder(base, 'prefer-hardware') : null;
    const softwareFps = await timeEncoder(base, 'prefer-software');
    const result: BrowserEncoderBenchmark = { avc: { hardwareFps, softwareFps } };
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), result }));
    } catch {
      // storage blocked; fine
    }
    return result;
  } finally {
    base.close();
  }
}

interface NavigatorExtras {
  deviceMemory?: number;
  gpu?: {
    requestAdapter: () => Promise<{
      info?: { vendor?: string; architecture?: string; device?: string; description?: string };
    } | null>;
  };
  userAgentData?: { brands: { brand: string; version: string }[] };
}

/** The GPU as WebGPU names it, else the unmasked WebGL renderer string, else null. */
export async function detectGpuName(): Promise<string | null> {
  const nav = navigator as unknown as NavigatorExtras;
  try {
    const adapter = await nav.gpu?.requestAdapter();
    const info = adapter?.info;
    const parts = [info?.vendor, info?.architecture, info?.device, info?.description].filter(
      (p): p is string => typeof p === 'string' && p.length > 0,
    );
    if (parts.length > 0) return [...new Set(parts)].join(' · ');
  } catch {
    // no WebGPU
  }
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    if (gl && ext) {
      const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as unknown;
      if (typeof renderer === 'string' && renderer) {
        // "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max, Unspecified Version)" → "Apple M2 Max"
        const m = /Renderer:\s*([^,)]+)/.exec(renderer);
        return m?.[1]?.trim() ?? renderer;
      }
    }
  } catch {
    // no WebGL
  }
  return null;
}

export function browserName(): string | null {
  const nav = navigator as unknown as NavigatorExtras;
  const brands = nav.userAgentData?.brands.filter((b) => !/not.?a.?brand|chromium/i.test(b.brand)) ?? [];
  const first = brands[0];
  if (first) return `${first.brand} ${first.version}`;
  const m = /(Firefox|Safari|Edg|Chrome)\/([\d.]+)/.exec(navigator.userAgent);
  return m ? `${m[1] === 'Edg' ? 'Edge' : m[1]} ${m[2]?.split('.')[0] ?? ''}`.trim() : null;
}

/** Everything the planner needs to know about this browser; checked once and cached by the caller. */
export async function detectBrowserCapabilities(): Promise<BrowserCapabilities> {
  const nav = navigator as unknown as NavigatorExtras;
  const base = {
    fileSystemAccess: hasFileSystemAccess(),
    hardwareConcurrency: navigator.hardwareConcurrency > 0 ? navigator.hardwareConcurrency : null,
    deviceMemoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    browser: browserName(),
  };
  if (!hasWebCodecs()) {
    return {
      ...base,
      videoCodecs: [],
      audioCodecs: [],
      hardware: { ...NO_HARDWARE },
      benchmark: null,
      gpu: await detectGpuName(),
    };
  }
  const [video, audio, gpu] = await Promise.all([
    getEncodableVideoCodecs([...VIDEO], { width: 1920, height: 1080, bitrate: 4_000_000 }),
    getEncodableAudioCodecs(['aac', 'opus'], { numberOfChannels: 1, sampleRate: 48000, bitrate: 96_000 }),
    detectGpuName(),
  ]);
  const videoCodecs = video.filter((c): c is VideoCodecId => (VIDEO as readonly string[]).includes(c));
  const hardware = await probeHardwareEncoders(videoCodecs);
  const benchmark = videoCodecs.includes('avc') ? await benchmarkAvcEncoders(hardware.avc > 0) : null;
  return {
    ...base,
    videoCodecs,
    audioCodecs: audio.filter((c): c is 'aac' | 'opus' => c === 'aac' || c === 'opus'),
    hardware,
    benchmark,
    gpu,
  };
}
