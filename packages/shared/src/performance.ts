/**
 * Performance settings: the few decisions that make an export fast or small on a given machine, and how
 * they are applied to a request. Everything here is pure so the dialog can show the outcome before
 * anything runs and the choices are unit-tested.
 *
 * Two things are decided:
 * - the **hardware switch**: whether the dedicated video encoder (Apple's media engine through
 *   VideoToolbox, NVIDIA NVENC, Intel Quick Sync, VAAPI) does the work wherever one exists, in the
 *   browser through WebCodecs and on the server through ffmpeg. It is on by default and stays on until
 *   the user turns it off; a machine without one simply encodes on the CPU;
 * - the **mode**: how hard to push for speed against file size, which picks the ffmpeg preset, the
 *   `stillimage` tune and the browser's latency mode.
 */
import { type ExportRequest } from './api.js';
import { VIDEO_CODECS, type VideoCodecId } from './containers.js';

export const PERFORMANCE_MODES = ['fastest', 'balanced', 'quality'] as const;
export type PerformanceMode = (typeof PERFORMANCE_MODES)[number];

export const PERFORMANCE_MODE_INFO: Record<PerformanceMode, { label: string; description: string }> = {
  fastest: {
    label: 'Fastest',
    description:
      'Quick presets everywhere; software encoders run in their real-time mode. Files are a little larger.',
  },
  balanced: {
    label: 'Balanced',
    description: 'Default presets for the browser and ffmpeg. A good middle ground.',
  },
  quality: {
    label: 'Smallest file',
    description:
      'ffmpeg compresses with slow, thorough software presets, which no hardware encoder matches for size. Several times slower; use for the final version of a long course.',
  },
};

export interface PerformanceSettings {
  mode: PerformanceMode;
  /** Use the dedicated hardware encoder wherever this computer has one. On until the user says no. */
  hardware: boolean;
}

export const DEFAULT_PERFORMANCE: PerformanceSettings = { mode: 'fastest', hardware: true };

/**
 * The largest frame height each codec can be hardware-encoded at in this browser, 0 when it cannot.
 * Probed with WebCodecs' `prefer-hardware` at 1080p and 4K (see the client's export/capabilities.ts).
 */
export type HardwareSupport = Record<VideoCodecId, number>;

export const NO_HARDWARE: HardwareSupport = { avc: 0, hevc: 0, vp9: 0, av1: 0 };

/** Which codecs this browser can encode on the CPU (`prefer-software` accepted at 1080p). */
export type SoftwareSupport = Record<VideoCodecId, boolean>;

export const NO_SOFTWARE: SoftwareSupport = { avc: false, hevc: false, vp9: false, av1: false };

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
  /** Codecs with a software encoder, so "no hardware" can be honoured without failing the export. */
  software: SoftwareSupport;
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
 * Whether this browser can encode `codec` the way the settings ask: on the GPU at this size when the
 * hardware switch is on (or on the CPU as a fallback), on the CPU only when it is off.
 */
export function browserCanEncode(
  browser: BrowserCapabilities,
  codec: VideoCodecId,
  height: number,
  performance: PerformanceSettings,
): boolean {
  if (!browser.videoCodecs.includes(codec)) return false;
  if (performance.hardware) return true;
  return browser.software[codec] || !browserHasHardware(browser, codec, height);
}

/**
 * Order in which "auto" tries codecs. The container family decides the candidates; with the hardware
 * switch on, the codecs this browser can hardware-encode at the wanted size move to the front.
 */
export function codecPreference(
  family: readonly VideoCodecId[],
  performance: PerformanceSettings,
  browser: BrowserCapabilities,
  height: number,
): VideoCodecId[] {
  const list = [...family];
  if (!performance.hardware) return list;
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
 * WebCodecs knobs for one browser encode. `prefer-hardware` is requested whenever the switch is on and
 * the probe said the GPU takes this codec at this size (an unsupported request fails instead of
 * falling back); `prefer-software` when the user turned the switch off and the browser has a software
 * encoder for the codec. `realtime` is used only for software encoders in the fastest mode: measured on
 * an M2 Max it cut the VideoToolbox encoder from 374 to 166 fps (its real-time mode drops look-ahead
 * and pipelining) and made no difference to Chrome's software H.264 or VP9.
 */
export function browserTuning(
  performance: PerformanceSettings,
  codec: VideoCodecId,
  height: number,
  browser: BrowserCapabilities,
): BrowserEncodeTuning {
  const bench = codec === 'avc' ? (browser.benchmark?.avc ?? null) : null;
  if (performance.hardware && browserHasHardware(browser, codec, height)) {
    return {
      hardwareAcceleration: 'prefer-hardware',
      latencyMode: 'quality',
      hardware: true,
      measuredFps: bench?.hardwareFps ?? null,
    };
  }
  return {
    hardwareAcceleration:
      !performance.hardware && browser.software[codec] ? 'prefer-software' : 'no-preference',
    latencyMode: performance.mode === 'fastest' ? 'realtime' : 'quality',
    hardware: false,
    measuredFps: bench?.softwareFps ?? null,
  };
}

/**
 * Whether ffmpeg on the server should use its hardware encoder: when the switch is on, except in the
 * "smallest file" mode, whose whole point is x264 / x265 at a slow preset (a hardware encoder makes a
 * larger file at the same quality, whatever preset it is given).
 */
export function serverUsesHardware(performance: PerformanceSettings): boolean {
  return performance.hardware && performance.mode !== 'quality';
}

/**
 * True when the start-up race showed the browser's software H.264 encoder clearly beating the GPU one,
 * so the dialog can say so next to the switch. On an M2 Max it did, 700 against 390 fps on slide
 * video, because the software encoder skips unchanged blocks while the GPU pipeline processes every
 * frame; a 15 % margin keeps the note from flapping. It is information, not a decision: the switch is
 * the user's.
 */
export function softwareBeatsHardware(browser: BrowserCapabilities): boolean {
  const software = browser.benchmark?.avc.softwareFps ?? null;
  const hardware = browser.benchmark?.avc.hardwareFps ?? null;
  if (software === null || hardware === null) return false;
  return software > hardware * 1.15;
}

/**
 * Applies a mode to the request: sets the mode and the compression fields a mode implies. The user can
 * still change any field afterwards; the mode only picks the starting point. The hardware switch is not
 * touched: it is the user's, whatever the mode.
 */
export function applyPerformanceMode(request: ExportRequest, mode: PerformanceMode): void {
  request.performance = { ...request.performance, mode };
  const c = request.compression;
  switch (mode) {
    case 'fastest':
      c.preset = 'veryfast';
      break;
    case 'balanced':
      c.preset = 'medium';
      break;
    case 'quality':
      c.preset = 'slow';
      if (c.codec === 'h264') c.tune = 'stillimage';
      break;
  }
}

/** Codecs the browser can hardware-encode, for the system line. */
export function hardwareCodecLabels(browser: BrowserCapabilities): string[] {
  return VIDEO_CODECS.filter((c) => browser.hardware[c] > 0).map((c) =>
    browser.hardware[c] >= 2160 ? `${c.toUpperCase()} up to 4K` : `${c.toUpperCase()} up to 1080p`,
  );
}
