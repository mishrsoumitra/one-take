/** User-facing presets for resolution, frame rate, quality and compression. */

export const RESOLUTION_PRESETS = ['2160p', '1440p', '1080p', '720p', '480p', '360p'] as const;
export type ResolutionPreset = (typeof RESOLUTION_PRESETS)[number];

export const RESOLUTION_SIZES: Record<ResolutionPreset, { width: number; height: number; label: string }> = {
  '2160p': { width: 3840, height: 2160, label: '4K · 3840×2160' },
  '1440p': { width: 2560, height: 1440, label: '1440p · 2560×1440' },
  '1080p': { width: 1920, height: 1080, label: '1080p · 1920×1080' },
  '720p': { width: 1280, height: 720, label: '720p · 1280×720' },
  '480p': { width: 854, height: 480, label: '480p · 854×480' },
  '360p': { width: 640, height: 360, label: '360p · 640×360' },
};

/** Frame rates offered in the UI. Slides are still images, so low rates lose nothing. */
export const FPS_OPTIONS = [1, 2, 5, 10, 12, 15, 24, 25, 30, 50, 60] as const;

export const QUALITY_LEVELS = ['low', 'medium', 'high', 'very-high'] as const;
export type QualityLevel = (typeof QUALITY_LEVELS)[number];

/**
 * Video bitrate (kbit/s) for each quality level at 1080p30. Other sizes and rates are scaled from this
 * (see `videoBitrateKbps`). These are upper bounds: static slides compress far below them.
 */
export const QUALITY_BITRATE_1080P30_KBPS: Record<QualityLevel, number> = {
  low: 1200,
  medium: 2500,
  high: 5000,
  'very-high': 10000,
};

export const QUALITY_LABELS: Record<QualityLevel, string> = {
  low: 'Low · smallest file',
  medium: 'Medium · good for slides',
  high: 'High · crisp text',
  'very-high': 'Very high · near lossless',
};

export const AUDIO_BITRATES_KBPS = [48, 64, 96, 128, 192] as const;

export const COMPRESSION_PRESETS = [
  'ultrafast',
  'veryfast',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow',
] as const;
export type CompressionPreset = (typeof COMPRESSION_PRESETS)[number];

/** Sensible CRF ranges per server codec (lower is better quality, bigger file). */
export const CRF_RANGES = {
  h264: { min: 0, max: 51, default: 23 },
  h265: { min: 0, max: 51, default: 28 },
  vp9: { min: 0, max: 63, default: 32 },
  av1: { min: 0, max: 63, default: 35 },
} as const;

export const SEGMENT_SECONDS_OPTIONS = [2, 4, 6, 10] as const;

/** Rungs of the adaptive ladder (heights); the source height is added on top when it is larger. */
export const LADDER_RUNGS: readonly { height: number; videoBitrateKbps: number; audioBitrateKbps: number }[] =
  [
    { height: 1080, videoBitrateKbps: 4500, audioBitrateKbps: 128 },
    { height: 720, videoBitrateKbps: 2500, audioBitrateKbps: 96 },
    { height: 480, videoBitrateKbps: 1200, audioBitrateKbps: 64 },
    { height: 360, videoBitrateKbps: 700, audioBitrateKbps: 48 },
  ];

export const MAX_DIMENSION = 7680;
export const MIN_DIMENSION = 16;

/** Video bitrate for a size, frame rate and quality level, scaled from the 1080p30 table. */
export function videoBitrateKbps(level: QualityLevel, width: number, height: number, fps: number): number {
  const pixelRatio = (width * height) / (1920 * 1080);
  // Frame rate matters less than pixel count for mostly-static content: use a square-root weighting.
  const fpsRatio = Math.sqrt(Math.max(1, fps) / 30);
  const kbps = QUALITY_BITRATE_1080P30_KBPS[level] * pixelRatio * fpsRatio;
  return Math.max(150, Math.round(kbps));
}

/** Round a dimension to an even number, which H.264/H.265 require, within the supported range. */
export function evenDimension(value: number): number {
  const clamped = Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, Math.round(value)));
  return clamped % 2 === 0 ? clamped : clamped - 1;
}
