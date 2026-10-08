/**
 * Performance modes: the few decisions that make an export fast or small on a given machine, and how
 * they are applied to a request. Everything here is pure so the dialog can show the outcome before
 * anything runs and the choices are unit-tested.
 *
 * What a mode decides:
 * - which browser codec to prefer when the user says "auto" (hardware-encodable ones first in `fastest`);
 * - whether the browser asks WebCodecs for the hardware encoder and the `realtime` latency mode;
 * - whether server compression uses the GPU encoder and which x264/x265 preset it starts from.
 */
import { type ExportRequest, type ServerCapabilities } from './api.js';
import { isHardwareEncoder, VIDEO_CODECS, type VideoCodecId } from './containers.js';

export const PERFORMANCE_MODES = ['fastest', 'balanced', 'quality'] as const;
export type PerformanceMode = (typeof PERFORMANCE_MODES)[number];

export const PERFORMANCE_MODE_INFO: Record<PerformanceMode, { label: string; description: string }> = {
  fastest: {
    label: 'Fastest',
    description:
      'Hardware encoders wherever they exist, software encoders in their quick modes. Files are a little larger.',
  },
  balanced: {
    label: 'Balanced',
    description: 'Lets the browser and ffmpeg pick their defaults. A good middle ground.',
  },
  quality: {
    label: 'Smallest file',
    description:
      'Software encoders with slow, thorough presets. Several times slower; use for the final version of a long course.',
  },
};

export interface PerformanceSettings {
  mode: PerformanceMode;
}

export const DEFAULT_PERFORMANCE: PerformanceSettings = { mode: 'fastest' };

/**
 * The largest frame height each codec can be hardware-encoded at in this browser, 0 when it cannot.
 * Probed with WebCodecs' `prefer-hardware` at 1080p and 4K (see the client's export/capabilities.ts).
 */
export type HardwareSupport = Record<VideoCodecId, number>;

export const NO_HARDWARE: HardwareSupport = { avc: 0, hevc: 0, vp9: 0, av1: 0 };

/** Frames per second of 1080p slide video each H.264 encoder managed in a short start-up test. */
export interface BrowserEncoderBenchmark {
  avc: { hardwareFps: number | null; softwareFps: number | null };
}

export interface BrowserCapabilities {
  videoCodecs: VideoCodecId[];
  audioCodecs: ('aac' | 'opus')[];
  /** `showSaveFilePicker` exists, so large files can be streamed to disk without a server. */
  fileSystemAccess: boolean;
  hardware: HardwareSupport;
  /** Measured encoder speeds, null until the test has run (see the client's export/capabilities.ts). */
  benchmark: BrowserEncoderBenchmark | null;
  /** `navigator.hardwareConcurrency`; null when the browser hides it. */
  hardwareConcurrency: number | null;
  /** `navigator.deviceMemory` in GB (Chrome rounds it and caps it at 8); null elsewhere. */
  deviceMemoryGb: number | null;
  /** GPU name as reported through WebGPU or WebGL; null when hidden. */
  gpu: string | null;
  /** Browser name and version for the system line. */
  browser: string | null;
}

export function browserHasHardware(
  browser: BrowserCapabilities,
  codec: VideoCodecId,
  height: number,
): boolean {
  return browser.hardware[codec] >= height;
}

/**
 * Order in which "auto" tries codecs. The container family decides the candidates; in `fastest` mode
 * the codecs this browser can hardware-encode at the wanted size move to the front.
 */
export function codecPreference(
  family: readonly VideoCodecId[],
  mode: PerformanceMode,
  browser: BrowserCapabilities,
  height: number,
): VideoCodecId[] {
  const list = [...family];
  if (mode !== 'fastest') return list;
  return list.sort((a, b) => {
    const ha = browserHasHardware(browser, a, height) ? 0 : 1;
    const hb = browserHasHardware(browser, b, height) ? 0 : 1;
    return ha - hb;
  });
}

export interface BrowserEncodeTuning {
  hardwareAcceleration: 'prefer-hardware' | 'no-preference' | 'prefer-software';
  latencyMode: 'quality' | 'realtime';
  /** The GPU encoder is expected to do the work. */
  hardware: boolean;
  /** Frames per second to expect from this choice, when the start-up test measured it. */
  measuredFps: number | null;
}

/**
 * True when the start-up test showed the browser's software H.264 encoder clearly beating the GPU one.
 * On an M2 Max it did, 700 against 390 fps on slide video, because the software encoder skips unchanged
 * blocks while the GPU pipeline processes every frame; a 15 % margin keeps the choice from flapping.
 */
export function softwareBeatsHardware(browser: BrowserCapabilities, codec: VideoCodecId): boolean {
  if (codec !== 'avc' || !browser.benchmark) return false;
  const { hardwareFps, softwareFps } = browser.benchmark.avc;
  if (softwareFps === null) return false;
  if (hardwareFps === null) return true;
  return softwareFps > hardwareFps * 1.15;
}

/**
 * WebCodecs knobs for one browser encode. `prefer-hardware` is only requested when the probe said it
 * works at this size, because an unsupported request fails instead of falling back; `prefer-software`
 * when the start-up test showed it faster. `realtime` is used only for software encoders without a
 * measurement: measured on an M2 Max it cut the VideoToolbox encoder from 374 to 166 fps (its real-time
 * mode drops look-ahead and pipelining) and made no difference to Chrome's software H.264 or VP9.
 */
export function browserTuning(
  mode: PerformanceMode,
  codec: VideoCodecId,
  height: number,
  browser: BrowserCapabilities,
): BrowserEncodeTuning {
  const hardware = browserHasHardware(browser, codec, height);
  const bench = codec === 'avc' ? (browser.benchmark?.avc ?? null) : null;
  if (mode === 'fastest') {
    if (softwareBeatsHardware(browser, codec)) {
      return {
        hardwareAcceleration: 'prefer-software',
        latencyMode: 'quality',
        hardware: false,
        measuredFps: bench?.softwareFps ?? null,
      };
    }
    return {
      hardwareAcceleration: hardware ? 'prefer-hardware' : 'no-preference',
      latencyMode: hardware ? 'quality' : 'realtime',
      hardware,
      measuredFps: hardware ? (bench?.hardwareFps ?? null) : null,
    };
  }
  return {
    hardwareAcceleration: 'no-preference',
    latencyMode: 'quality',
    hardware,
    measuredFps: hardware ? (bench?.hardwareFps ?? null) : null,
  };
}

export function serverHasHardwareEncoder(server: ServerCapabilities | null): boolean {
  return (server?.system?.ffmpeg?.encoders.length ?? 0) > 0;
}

/**
 * Whether the server's GPU encoder should do compression in the fastest mode. Decided by the start-up
 * benchmark, not by the GPU's presence: on slide video x264 skips the unchanged blocks almost for free
 * and beat an Apple M2 Max's VideoToolbox encoder two to one at 1080p. Until the benchmark has run,
 * software it is.
 */
export function serverPrefersHardwareEncoder(server: ServerCapabilities | null): boolean {
  const fastest = server?.system?.ffmpeg?.fastestEncoder ?? null;
  return fastest !== null && isHardwareEncoder(fastest);
}

/**
 * Applies a mode to the request: sets the mode and the compression fields a mode implies. The user can
 * still change any field afterwards; the mode only picks the starting point.
 */
export function applyPerformanceMode(
  request: ExportRequest,
  mode: PerformanceMode,
  server: ServerCapabilities | null,
): void {
  request.performance = { mode };
  const c = request.compression;
  switch (mode) {
    case 'fastest':
      c.hardware = serverPrefersHardwareEncoder(server);
      c.preset = 'veryfast';
      break;
    case 'balanced':
      c.hardware = false;
      c.preset = 'medium';
      break;
    case 'quality':
      c.hardware = false;
      c.preset = 'slow';
      if (c.codec === 'h264') c.tune = 'stillimage';
      break;
  }
}

/** Codecs the browser can encode at all, for the system line. */
export function hardwareCodecLabels(browser: BrowserCapabilities): string[] {
  return VIDEO_CODECS.filter((c) => browser.hardware[c] > 0).map((c) =>
    browser.hardware[c] >= 2160 ? `${c.toUpperCase()} up to 4K` : `${c.toUpperCase()} up to 1080p`,
  );
}
