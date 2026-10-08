/**
 * Catalog of output containers and codecs, and which combinations are valid.
 *
 * Two naming schemes meet here:
 * - browser codec ids are the WebCodecs / mediabunny names (`avc`, `hevc`, `vp9`, `av1`, `aac`, `opus`);
 * - server encoder ids are the ffmpeg names (`libx264`, `libx265`, ...).
 */

export const CONTAINERS = ['mp4', 'fmp4', 'mov', 'mkv', 'webm', 'hls', 'dash'] as const;
export type Container = (typeof CONTAINERS)[number];

/** Containers the browser can write directly (no ffmpeg involved). */
export const BROWSER_CONTAINERS = ['mp4', 'fmp4', 'mov', 'mkv', 'webm'] as const;
export type BrowserContainer = (typeof BROWSER_CONTAINERS)[number];

export const VIDEO_CODECS = ['avc', 'hevc', 'vp9', 'av1'] as const;
export type VideoCodecId = (typeof VIDEO_CODECS)[number];

export const AUDIO_CODECS = ['aac', 'opus'] as const;
export type AudioCodecId = (typeof AUDIO_CODECS)[number];

/** Codecs the server can produce when it re-encodes. */
export const SERVER_VIDEO_CODECS = ['h264', 'h265', 'vp9', 'av1'] as const;
export type ServerVideoCodec = (typeof SERVER_VIDEO_CODECS)[number];

export interface ContainerInfo {
  id: Container;
  label: string;
  /** File extension of the main output (for directories this is the manifest). */
  extension: string;
  mimeType: string;
  /** The output is a folder with a manifest and segments. */
  isDirectory: boolean;
  /** Only the server (with ffmpeg) can produce this container. */
  needsServer: boolean;
  video: readonly VideoCodecId[];
  audio: readonly AudioCodecId[];
  description: string;
}

export const CONTAINER_INFO: Record<Container, ContainerInfo> = {
  mp4: {
    id: 'mp4',
    label: 'MP4',
    extension: 'mp4',
    mimeType: 'video/mp4',
    isDirectory: false,
    needsServer: false,
    video: ['avc', 'hevc', 'av1', 'vp9'],
    audio: ['aac', 'opus'],
    description:
      'Plays everywhere. The index is written at the front so the file can start playing while it downloads.',
  },
  fmp4: {
    id: 'fmp4',
    label: 'Fragmented MP4',
    extension: 'mp4',
    mimeType: 'video/mp4',
    isDirectory: false,
    needsServer: false,
    video: ['avc', 'hevc', 'av1', 'vp9'],
    audio: ['aac', 'opus'],
    description:
      'An MP4 written in small fragments. If the export is interrupted, what was written stays playable. Needs no ffmpeg.',
  },
  mov: {
    id: 'mov',
    label: 'QuickTime MOV',
    extension: 'mov',
    mimeType: 'video/quicktime',
    isDirectory: false,
    needsServer: false,
    video: ['avc', 'hevc'],
    audio: ['aac'],
    description: 'For Apple tools such as Final Cut and iMovie.',
  },
  mkv: {
    id: 'mkv',
    label: 'Matroska MKV',
    extension: 'mkv',
    mimeType: 'video/x-matroska',
    isDirectory: false,
    needsServer: false,
    video: ['avc', 'hevc', 'vp9', 'av1'],
    audio: ['aac', 'opus'],
    description: 'Holds any codec. Good for archiving; not every player supports it.',
  },
  webm: {
    id: 'webm',
    label: 'WebM',
    extension: 'webm',
    mimeType: 'video/webm',
    isDirectory: false,
    needsServer: false,
    video: ['vp9', 'av1'],
    audio: ['opus'],
    description:
      'Royalty-free VP9 or AV1 with Opus audio. Plays in browsers; smaller files for the same quality.',
  },
  hls: {
    id: 'hls',
    label: 'HLS (m3u8 + segments)',
    extension: 'm3u8',
    mimeType: 'application/vnd.apple.mpegurl',
    isDirectory: true,
    needsServer: true,
    video: ['avc', 'hevc'],
    audio: ['aac'],
    description:
      'A folder with an index.m3u8 playlist and short segments, ready for a web player or a streaming server.',
  },
  dash: {
    id: 'dash',
    label: 'MPEG-DASH (mpd + segments)',
    extension: 'mpd',
    mimeType: 'application/dash+xml',
    isDirectory: true,
    needsServer: true,
    video: ['avc', 'hevc', 'vp9', 'av1'],
    audio: ['aac', 'opus'],
    description: 'A folder with a manifest.mpd and segments for dash.js, Shaka Player or a CDN.',
  },
};

export const VIDEO_CODEC_INFO: Record<VideoCodecId, { label: string; serverCodec: ServerVideoCodec }> = {
  avc: { label: 'H.264 / AVC', serverCodec: 'h264' },
  hevc: { label: 'H.265 / HEVC', serverCodec: 'h265' },
  vp9: { label: 'VP9', serverCodec: 'vp9' },
  av1: { label: 'AV1', serverCodec: 'av1' },
};

export const AUDIO_CODEC_INFO: Record<AudioCodecId, { label: string; ffmpegEncoders: readonly string[] }> = {
  aac: { label: 'AAC', ffmpegEncoders: ['aac', 'aac_at', 'libfdk_aac'] },
  opus: { label: 'Opus', ffmpegEncoders: ['libopus'] },
};

/** ffmpeg encoders that can produce each server codec, in order of preference. */
export const SERVER_VIDEO_ENCODERS: Record<
  ServerVideoCodec,
  { software: readonly string[]; hardware: readonly string[] }
> = {
  h264: { software: ['libx264'], hardware: ['h264_videotoolbox', 'h264_nvenc', 'h264_qsv', 'h264_vaapi'] },
  h265: { software: ['libx265'], hardware: ['hevc_videotoolbox', 'hevc_nvenc', 'hevc_qsv', 'hevc_vaapi'] },
  vp9: { software: ['libvpx-vp9'], hardware: [] },
  av1: { software: ['libsvtav1', 'libaom-av1'], hardware: ['av1_nvenc', 'av1_qsv', 'av1_videotoolbox'] },
};

/** True for GPU encoders (`h264_videotoolbox`, `hevc_nvenc`, ...), false for the software ones. */
export function isHardwareEncoder(encoder: string): boolean {
  return Object.values(SERVER_VIDEO_ENCODERS).some((e) => e.hardware.includes(encoder));
}

/** Which server codecs are valid in which final container. */
export const SERVER_CODEC_CONTAINERS: Record<ServerVideoCodec, readonly Container[]> = {
  h264: ['mp4', 'fmp4', 'mov', 'mkv', 'hls', 'dash'],
  h265: ['mp4', 'fmp4', 'mov', 'mkv', 'hls', 'dash'],
  vp9: ['mp4', 'fmp4', 'mkv', 'webm', 'dash'],
  av1: ['mp4', 'fmp4', 'mkv', 'webm', 'dash'],
};

export const SERVER_AUDIO_CONTAINERS: Record<AudioCodecId, readonly Container[]> = {
  aac: ['mp4', 'fmp4', 'mov', 'mkv', 'hls', 'dash'],
  opus: ['mp4', 'fmp4', 'mkv', 'webm', 'dash'],
};

/** ffmpeg muxer name per container (used to check what the installed ffmpeg can write). */
export const CONTAINER_MUXER: Record<Container, string> = {
  mp4: 'mp4',
  fmp4: 'mp4',
  mov: 'mov',
  mkv: 'matroska',
  webm: 'webm',
  hls: 'hls',
  dash: 'dash',
};

export function isContainer(value: string): value is Container {
  return (CONTAINERS as readonly string[]).includes(value);
}

export function isBrowserContainer(value: string): value is BrowserContainer {
  return (BROWSER_CONTAINERS as readonly string[]).includes(value);
}

export function serverCodecForBrowserCodec(codec: VideoCodecId): ServerVideoCodec {
  return VIDEO_CODEC_INFO[codec].serverCodec;
}

export function browserCodecForServerCodec(codec: ServerVideoCodec): VideoCodecId {
  switch (codec) {
    case 'h264':
      return 'avc';
    case 'h265':
      return 'hevc';
    case 'vp9':
      return 'vp9';
    case 'av1':
      return 'av1';
  }
}
