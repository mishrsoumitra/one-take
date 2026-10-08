/**
 * Which process needs which resource, and roughly how much: memory per stage, whether the GPU or the
 * CPU does the work, disk space, and a wall-clock estimate. The numbers are models, not measurements;
 * they are tuned so that a 1080p slide lecture on a modern laptop comes out in the right ballpark, and
 * every figure in the UI is labelled "roughly". The point is to spot the exports that will not fit or
 * will take an hour before they start.
 */
import { type ServerCapabilities } from './api.js';
import { isHardwareEncoder, type VideoCodecId } from './containers.js';
import { type ExportEstimate } from './estimate.js';
import { type BrowserCapabilities } from './performance.js';
import { type ExportPlan, pickServerVideoEncoder } from './plan.js';
import { type CompressionPreset } from './presets.js';
import { formatGb, GB } from './system.js';

export type ResourceUnit = 'gpu' | 'cpu' | 'disk' | 'light';

export interface ResourceLine {
  /** `Browser encodes`, `Server packages`, ... */
  stage: string;
  runsOn: 'browser' | 'server';
  /** The resource that limits this stage. */
  unit: ResourceUnit;
  /** What does the work: `H.264 hardware encoder (GPU)`, `libx264 on 12 cores`, `stream copy`. */
  detail: string;
  memoryBytes: number;
  diskBytes: number;
  /** Rough wall time in seconds; null when nothing sensible can be said. */
  seconds: number | null;
}

export interface SlideSet {
  count: number;
  width: number;
  height: number;
}

const MB = 1024 ** 2;
const PIXELS_1080P = 1920 * 1080;
const BITMAP_CACHE = 8;

/**
 * Seconds per 1080p frame for the browser's encoders. The hardware figure is what an Apple M2 Max's
 * VideoToolbox encoder managed through WebCodecs on slide video (370 fps); the software figures are
 * rough values for Chrome's built-in encoders.
 */
const BROWSER_SECONDS_PER_FRAME: Record<VideoCodecId, { hardware: number; software: number }> = {
  avc: { hardware: 0.0027, software: 0.012 },
  hevc: { hardware: 0.003, software: 0.03 },
  vp9: { hardware: 0.004, software: 0.03 },
  av1: { hardware: 0.005, software: 0.09 },
};

/**
 * Seconds per 1080p frame for ffmpeg's software encoders on eight fast cores, by x264-style preset, on
 * slide video (unchanged blocks are skipped, so even `slow` stays quick: measured 1.1 ms at `veryfast`
 * and 1.6 ms at `slow` with `stillimage` on an M2 Max).
 */
const X264_SECONDS_PER_FRAME: Record<CompressionPreset, number> = {
  ultrafast: 0.001,
  veryfast: 0.0012,
  fast: 0.0015,
  medium: 0.002,
  slow: 0.0025,
  slower: 0.004,
  veryslow: 0.008,
};
const ENCODER_FACTOR: Record<string, number> = {
  libx264: 1,
  libx265: 3,
  'libvpx-vp9': 4,
  libsvtav1: 2.5,
  'libaom-av1': 10,
};
/** GPU encoders run at a fixed pipeline rate whatever the content: about 400 fps at 1080p (M2 Max). */
const HARDWARE_SECONDS_PER_FRAME = 0.0025;
/** Software decoding of slide video: thousands of frames per second. */
const DECODE_SECONDS_PER_FRAME = 0.00015;

/** Working memory ffmpeg's encoders keep per 1080p frame-equivalent, plus a fixed base. */
const ENCODER_MEMORY: Record<string, { baseBytes: number; framesHeld: number }> = {
  libx264: { baseBytes: 100 * MB, framesHeld: 60 },
  libx265: { baseBytes: 150 * MB, framesHeld: 120 },
  'libvpx-vp9': { baseBytes: 120 * MB, framesHeld: 90 },
  libsvtav1: { baseBytes: 400 * MB, framesHeld: 150 },
  'libaom-av1': { baseBytes: 600 * MB, framesHeld: 200 },
};

function frameBytes(width: number, height: number): number {
  return width * height * 1.5; // yuv420
}

/** Memory the browser tab holds for slides, canvas, bitmap cache and encoder queues during an export. */
export function browserExportMemoryBytes(plan: ExportPlan, slides: SlideSet, audioBytes: number): number {
  const { width, height } = plan.browser;
  const canvas = width * height * 4 * 2; // canvas + the VideoFrame of the current slide
  const bitmaps = Math.min(BITMAP_CACHE, Math.max(1, slides.count)) * slides.width * slides.height * 4;
  const jpegs = slides.count * 350_000; // rasterised slides kept as JPEG blobs
  const queue = frameBytes(width, height) * 12 + 8 * MB; // encoder queue and the muxer's pending chunks
  return 120 * MB + canvas + bitmaps + jpegs + queue + audioBytes;
}

/** Memory the Node server needs while receiving an upload (chunks are 4 MB, a few in flight). */
export function serverUploadMemoryBytes(): number {
  return 90 * MB + 4 * 4 * MB;
}

/** Memory ffmpeg needs for a processing spec. */
export function ffmpegMemoryBytes(plan: ExportPlan, server: ServerCapabilities | null): number {
  const p = plan.processing;
  if (!p) return 0;
  if (p.video.mode === 'copy') return 50 * MB;
  const encoder = pickServerVideoEncoder(server, p.video.codec, p.video.hardware) ?? 'libx264';
  const height = p.video.height ?? plan.browser.height;
  const width = Math.round((plan.browser.width * height) / plan.browser.height);
  const rungs = p.ladder
    ? p.ladder.map((r) => ({ w: Math.round((width * r.height) / height), h: r.height }))
    : [{ w: width, h: height }];
  const decode = frameBytes(plan.browser.width, plan.browser.height) * 20 + 60 * MB;
  let total = decode;
  for (const r of rungs) {
    if (isHardwareEncoder(encoder)) total += 100 * MB + frameBytes(r.w, r.h) * 12;
    else {
      const m = ENCODER_MEMORY[encoder] ?? ENCODER_MEMORY.libx264 ?? { baseBytes: 100 * MB, framesHeld: 60 };
      const slow = p.video.preset === 'slow' || p.video.preset === 'slower' || p.video.preset === 'veryslow';
      total += m.baseBytes + frameBytes(r.w, r.h) * m.framesHeld * (slow ? 1.5 : 1);
    }
  }
  return total;
}

/** Memory the PowerPoint renderer needs for a deck: the file, its pictures as base64, and the PDF. */
export function conversionMemoryBytes(fileBytes: number): number {
  return 150 * MB + fileBytes * 6;
}

/** Memory one second of recorded speech takes (16-bit mono), in RAM and again in IndexedDB. */
export function recordingBytesPerSecond(sampleRate: number): number {
  return sampleRate * 2;
}

function cores(server: ServerCapabilities | null, browser: BrowserCapabilities): number {
  return server?.system?.cpu.cores ?? browser.hardwareConcurrency ?? 4;
}

/** The slowdown of a software encoder relative to the eight-core reference, from the core count. */
function coreFactor(n: number): number {
  return 8 / Math.min(16, Math.max(1, n));
}

export interface ResourceInput {
  plan: ExportPlan;
  estimate: ExportEstimate;
  durationSec: number;
  slides: SlideSet;
  /** Bytes of recorded PCM held in memory. */
  audioBytes: number;
  server: ServerCapabilities | null;
  browser: BrowserCapabilities;
}

/** The resource map of an export: one line per stage. */
export function estimateResources(input: ResourceInput): ResourceLine[] {
  const { plan, estimate, durationSec, slides, audioBytes, server, browser } = input;
  const b = plan.browser;
  const pixelRatio = (b.width * b.height) / PIXELS_1080P;
  const lines: ResourceLine[] = [];

  // Stage 1: the browser encodes. A measured speed (1080p) wins over the model.
  const perFrame = BROWSER_SECONDS_PER_FRAME[b.videoCodec];
  const hw = b.hardware;
  let browserSeconds: number;
  if (b.measuredFps !== null && b.measuredFps > 0) {
    browserSeconds = (estimate.frames / b.measuredFps) * pixelRatio;
  } else {
    browserSeconds = estimate.frames * (hw ? perFrame.hardware : perFrame.software) * pixelRatio;
    if (!hw) browserSeconds *= coreFactor(browser.hardwareConcurrency ?? cores(server, browser));
    if (!hw && b.latencyMode === 'realtime') browserSeconds *= 0.6;
  }
  browserSeconds += slides.count * 0.05 + durationSec * 0.002; // slide conversion and audio chunks
  const measured = b.measuredFps !== null ? `, measured ${Math.round(b.measuredFps)} fps at 1080p` : '';
  lines.push({
    stage: 'Browser encodes',
    runsOn: 'browser',
    unit: hw ? 'gpu' : 'cpu',
    detail: hw
      ? `${b.videoCodec.toUpperCase()} hardware encoder (GPU)${measured}, ${b.width}×${b.height} @ ${b.fps} fps`
      : `${b.videoCodec.toUpperCase()} software encoder on ${browser.hardwareConcurrency ?? '?'} threads${b.latencyMode === 'realtime' ? ', realtime mode' : ''}${measured}, ${b.width}×${b.height} @ ${b.fps} fps`,
    memoryBytes: browserExportMemoryBytes(plan, slides, audioBytes),
    diskBytes: plan.destination === 'browser' ? estimate.uploadBytes : 0,
    seconds: Math.max(1, Math.round(browserSeconds)),
  });

  if (plan.destination !== 'server') return lines;

  // Stage 2: the server receives the file.
  lines.push({
    stage: 'Server receives',
    runsOn: 'server',
    unit: 'disk',
    detail: `${formatGb(estimate.uploadBytes)} written in 4 MB chunks`,
    memoryBytes: serverUploadMemoryBytes(),
    diskBytes: estimate.uploadBytes,
    seconds: null,
  });

  // Stage 3: ffmpeg.
  const p = plan.processing;
  if (!p) return lines;
  if (p.video.mode === 'copy') {
    lines.push({
      stage: 'Server packages',
      runsOn: 'server',
      unit: 'light',
      detail: `ffmpeg stream copy into ${p.container.toUpperCase()}, no re-encoding`,
      memoryBytes: ffmpegMemoryBytes(plan, server),
      diskBytes: estimate.finalBytes,
      seconds: Math.max(1, Math.round(durationSec / 80)),
    });
    return lines;
  }
  const encoder = pickServerVideoEncoder(server, p.video.codec, p.video.hardware) ?? 'libx264';
  const hardware = isHardwareEncoder(encoder);
  const outFps = p.video.fps ?? b.fps;
  const outHeight = p.video.height ?? b.height;
  const rungs = p.ladder ? p.ladder.map((r) => r.height) : [outHeight];
  const outFrames = durationSec * outFps;
  const n = cores(server, browser);
  let seconds = durationSec * b.fps * DECODE_SECONDS_PER_FRAME; // decoding the upload
  for (const h of rungs) {
    const ratio = (h * h * (16 / 9)) / PIXELS_1080P;
    seconds += hardware
      ? outFrames * HARDWARE_SECONDS_PER_FRAME * ratio
      : outFrames *
        X264_SECONDS_PER_FRAME[p.video.preset] *
        (ENCODER_FACTOR[encoder] ?? 1) *
        ratio *
        coreFactor(n);
  }
  lines.push({
    stage: 'Server re-encodes',
    runsOn: 'server',
    unit: hardware ? 'gpu' : 'cpu',
    detail: hardware
      ? `${encoder} (GPU)${p.ladder ? `, ${p.ladder.length} renditions` : ''}`
      : `${encoder} ${p.video.preset} on ${n} cores${p.ladder ? `, ${p.ladder.length} renditions` : ''}`,
    memoryBytes: ffmpegMemoryBytes(plan, server),
    diskBytes: estimate.finalBytes + estimate.tempBytes,
    seconds: Math.max(1, Math.round(seconds)),
  });
  return lines;
}

/** Total wall time of the lines that run one after another. */
export function totalSeconds(lines: readonly ResourceLine[]): number | null {
  let sum = 0;
  let known = false;
  for (const l of lines) {
    if (l.seconds !== null) {
      sum += l.seconds;
      known = true;
    }
  }
  return known ? sum : null;
}

export function peakMemoryBytes(lines: readonly ResourceLine[]): number {
  // The browser keeps its memory for the whole export; server stages come one after another.
  const browser = lines.filter((l) => l.runsOn === 'browser').reduce((a, l) => a + l.memoryBytes, 0);
  const server = Math.max(0, ...lines.filter((l) => l.runsOn === 'server').map((l) => l.memoryBytes));
  return browser + server;
}

/**
 * Warnings that depend on the machine rather than on the format: exports that will not fit in memory,
 * software encoding of codecs the GPU could not do, and jobs that will take very long.
 */
export function performanceWarnings(input: ResourceInput, lines: readonly ResourceLine[]): string[] {
  const { plan, estimate, server, browser } = input;
  const warnings: string[] = [];
  const b = plan.browser;
  const totalBytes =
    server?.system?.memory.totalBytes ??
    (browser.deviceMemoryGb !== null ? browser.deviceMemoryGb * GB : null);
  const peak = peakMemoryBytes(lines);
  // Past 40 % of RAM the OS starts swapping with the browser's own tabs and the encoder; say so.
  if (totalBytes !== null && peak > totalBytes * 0.4) {
    warnings.push(
      `This export needs roughly ${formatGb(peak)} of memory and the machine has ${formatGb(totalBytes)}. Lower the resolution or export to a folder instead of the browser.`,
    );
  }
  if (
    plan.destination === 'browser' &&
    !browser.fileSystemAccess &&
    totalBytes !== null &&
    estimate.uploadBytes > totalBytes * 0.25
  ) {
    warnings.push(
      `The file (${formatGb(estimate.uploadBytes)}) is assembled in memory here; that is a quarter of this machine's RAM.`,
    );
  }
  if (!b.hardware && b.hardwareAcceleration !== 'prefer-software') {
    const hwCodec = (['avc', 'hevc'] as const).find((c) => browser.hardware[c] >= b.height);
    if (hwCodec && b.videoCodec !== hwCodec) {
      warnings.push(
        `${b.videoCodec.toUpperCase()} is encoded in software in this browser. ${hwCodec.toUpperCase()} (MP4) would use the GPU and be several times faster.`,
      );
    } else if (b.width * b.height > PIXELS_1080P && Object.values(browser.hardware).some((h) => h >= 1080)) {
      warnings.push(
        'The GPU encoder works up to 1080p in this browser; above that the CPU encodes, which is much slower.',
      );
    }
  }
  const total = totalSeconds(lines);
  if (total !== null && total > 1800) {
    warnings.push(`Expect roughly ${Math.round(total / 60)} minutes for this export.`);
  }
  return warnings;
}
