/**
 * Turns what the user asked for into a concrete two-stage pipeline:
 *   1. the browser encodes the lecture with WebCodecs and writes a container,
 *   2. optionally the server repackages or re-encodes it with ffmpeg.
 *
 * The planner is pure so the same decisions can be unit-tested and shown in the UI before anything runs.
 */
import { type ExportRequest, type ProcessingSpec, type ServerCapabilities, type LadderRung } from './api.js';
import {
  type AudioCodecId,
  type BrowserContainer,
  CONTAINER_INFO,
  CONTAINER_MUXER,
  type Container,
  SERVER_AUDIO_CONTAINERS,
  SERVER_CODEC_CONTAINERS,
  SERVER_VIDEO_ENCODERS,
  AUDIO_CODEC_INFO,
  isBrowserContainer,
  type ServerVideoCodec,
  type VideoCodecId,
} from './containers.js';
import {
  evenDimension,
  LADDER_RUNGS,
  RESOLUTION_SIZES,
  videoBitrateKbps,
  type QualityLevel,
} from './presets.js';

export interface BrowserCapabilities {
  videoCodecs: VideoCodecId[];
  audioCodecs: AudioCodecId[];
  /** `showSaveFilePicker` exists, so large files can be streamed to disk without a server. */
  fileSystemAccess: boolean;
}

export interface BrowserEncodePlan {
  container: BrowserContainer;
  videoCodec: VideoCodecId;
  audioCodec: AudioCodecId;
  width: number;
  height: number;
  fps: number;
  videoBitrateKbps: number;
  audioBitrateKbps: number;
  keyFrameIntervalSec: number;
  /** True when the server re-encodes afterwards, so the browser encodes at a high "mezzanine" quality. */
  mezzanine: boolean;
}

export interface ExportPlan {
  destination: 'server' | 'browser';
  browser: BrowserEncodePlan;
  processing: ProcessingSpec | null;
  final: { container: Container; extension: string; isDirectory: boolean; label: string };
  warnings: string[];
  /** Non-empty means the export cannot run as requested. */
  blockers: string[];
}

const VIDEO_PREFERENCE: Record<'mp4family' | 'webm', readonly VideoCodecId[]> = {
  mp4family: ['avc', 'hevc', 'av1', 'vp9'],
  webm: ['vp9', 'av1'],
};

export function resolveResolution(resolution: ExportRequest['resolution']): {
  width: number;
  height: number;
} {
  if ('preset' in resolution) {
    const size = RESOLUTION_SIZES[resolution.preset];
    return { width: size.width, height: size.height };
  }
  return { width: evenDimension(resolution.width), height: evenDimension(resolution.height) };
}

export function ffmpegHasEncoder(caps: ServerCapabilities | null, encoder: string): boolean {
  return caps?.ffmpeg?.encoders.includes(encoder) ?? false;
}

export function ffmpegHasMuxer(caps: ServerCapabilities | null, container: Container): boolean {
  return caps?.ffmpeg?.muxers.includes(CONTAINER_MUXER[container]) ?? false;
}

/** The ffmpeg encoder the server will use for a codec, or null when none is installed. */
export function pickServerVideoEncoder(
  caps: ServerCapabilities | null,
  codec: ServerVideoCodec,
  preferHardware: boolean,
): string | null {
  const { software, hardware } = SERVER_VIDEO_ENCODERS[codec];
  const order = preferHardware ? [...hardware, ...software] : [...software, ...hardware];
  return order.find((encoder) => ffmpegHasEncoder(caps, encoder)) ?? null;
}

export function pickServerAudioEncoder(caps: ServerCapabilities | null, codec: AudioCodecId): string | null {
  return AUDIO_CODEC_INFO[codec].ffmpegEncoders.find((encoder) => ffmpegHasEncoder(caps, encoder)) ?? null;
}

function pickVideoCodec(
  allowed: readonly VideoCodecId[],
  requested: ExportRequest['video']['codec'],
  browser: BrowserCapabilities,
  family: 'mp4family' | 'webm',
): VideoCodecId | null {
  if (requested !== 'auto') {
    return allowed.includes(requested) && browser.videoCodecs.includes(requested) ? requested : null;
  }
  return VIDEO_PREFERENCE[family].find((c) => allowed.includes(c) && browser.videoCodecs.includes(c)) ?? null;
}

function pickAudioCodec(
  allowed: readonly AudioCodecId[],
  requested: ExportRequest['audio']['codec'],
  browser: BrowserCapabilities,
): AudioCodecId | null {
  if (requested !== 'auto') {
    return allowed.includes(requested) && browser.audioCodecs.includes(requested) ? requested : null;
  }
  return allowed.find((c) => browser.audioCodecs.includes(c)) ?? null;
}

function qualityToKbps(request: ExportRequest, width: number, height: number, fps: number): number {
  const q = request.video.quality;
  return q.kind === 'bitrate' ? q.kbps : videoBitrateKbps(q.level, width, height, fps);
}

/** Key frame spacing that divides the segment length evenly, so copied segments are exactly that long. */
export function alignKeyFrameInterval(requestedSec: number, segmentSec: number): number {
  if (requestedSec >= segmentSec) return segmentSec;
  const n = Math.ceil(segmentSec / requestedSec);
  return segmentSec / n;
}

export function buildLadder(sourceHeight: number): LadderRung[] {
  const rungs = LADDER_RUNGS.filter((r) => r.height <= sourceHeight);
  const list =
    rungs.length > 0
      ? rungs
      : [
          LADDER_RUNGS[LADDER_RUNGS.length - 1] ?? {
            height: 360,
            videoBitrateKbps: 700,
            audioBitrateKbps: 48,
          },
        ];
  return list.map((r) => ({
    name: `${r.height}p`,
    height: Math.min(r.height, evenDimension(sourceHeight)),
    videoBitrateKbps: r.videoBitrateKbps,
    audioBitrateKbps: r.audioBitrateKbps,
  }));
}

export function planExport(
  request: ExportRequest,
  server: ServerCapabilities | null,
  browser: BrowserCapabilities,
): ExportPlan {
  const warnings: string[] = [];
  const blockers: string[] = [];
  const info = CONTAINER_INFO[request.container];
  const { width, height } = resolveResolution(request.resolution);
  const fps = request.fps;
  const destination = request.destination.kind;
  const ffmpeg = server?.ffmpeg ?? null;
  const serverReady = destination === 'server' && server !== null;

  if (destination === 'server' && server === null) {
    blockers.push(
      'The One Take server is not reachable. Start it with "npm start" or choose "Save in browser".',
    );
  }
  if (destination === 'browser' && info.needsServer) {
    blockers.push(
      `${info.label} needs the server and ffmpeg. Choose "Save to folder" or a single-file format.`,
    );
  }
  if (info.needsServer && serverReady && ffmpeg === null) {
    blockers.push(
      `${info.label} needs ffmpeg on the server. Install ffmpeg or choose MP4, WebM, MKV or MOV.`,
    );
  }
  if (width * height > 4096 * 2304) {
    warnings.push('Above 4K many hardware encoders refuse to run; the software encoder will be slower.');
  }

  let needsFfmpeg = false;
  let reason = '';
  if (request.compression.enabled) {
    needsFfmpeg = true;
    reason = 'compression';
  }
  if (info.needsServer) {
    needsFfmpeg = true;
    reason = reason || 'packaging';
  }
  if (request.streaming.ladder && info.isDirectory) {
    needsFfmpeg = true;
    reason = 'adaptive ladder';
  }

  // Can the browser produce the final container's codecs directly?
  const family = request.container === 'webm' ? 'webm' : 'mp4family';
  const directVideo = pickVideoCodec(info.video, request.video.codec, browser, family);
  const directAudio = pickAudioCodec(info.audio, request.audio.codec, browser);
  const canDirect = directVideo !== null && directAudio !== null;

  if (!canDirect && !needsFfmpeg) {
    if (destination === 'server' && ffmpeg !== null) {
      needsFfmpeg = true;
      reason = 'transcoding';
      warnings.push(
        `This browser cannot encode ${info.label} directly, so the server will transcode it with ffmpeg (slower).`,
      );
    } else {
      const want = request.video.codec === 'auto' ? info.video.join('/') : request.video.codec;
      blockers.push(
        `This browser cannot encode ${want} with ${request.audio.codec === 'auto' ? info.audio.join('/') : request.audio.codec} for ${info.label}.`,
      );
    }
  }

  if (needsFfmpeg && destination === 'server' && ffmpeg === null && serverReady) {
    blockers.push(
      `${reason === 'compression' ? 'Compression' : 'This output'} needs ffmpeg on the server, which was not found.`,
    );
  }
  if (needsFfmpeg && destination === 'browser') {
    if (request.compression.enabled) {
      blockers.push('Compression runs on the server. Choose "Save to folder" or turn compression off.');
    }
  }

  // Stage 1: browser encode plan.
  let browserPlan: BrowserEncodePlan;
  let processing: ProcessingSpec | null = null;

  if (needsFfmpeg && destination === 'server') {
    // Mezzanine: fragmented MP4 with the best codec the browser has; ffmpeg does the rest.
    const mezzVideo = pickVideoCodec(CONTAINER_INFO.fmp4.video, 'auto', browser, 'mp4family');
    const mezzAudio = pickAudioCodec(CONTAINER_INFO.fmp4.audio, 'auto', browser);
    if (mezzVideo === null || mezzAudio === null) {
      blockers.push('This browser has no usable WebCodecs video/audio encoder.');
    }
    const reencode =
      request.compression.enabled ||
      (request.streaming.ladder && info.isDirectory) ||
      reason === 'transcoding';
    const baseKbps = qualityToKbps(request, width, height, fps);
    const mezzKbps = reencode
      ? Math.max(baseKbps, videoBitrateKbps('very-high', width, height, fps))
      : baseKbps;
    const segmentSec = request.streaming.segmentSeconds;
    const keyFrame =
      info.isDirectory && !reencode
        ? alignKeyFrameInterval(request.video.keyFrameIntervalSec, segmentSec)
        : request.video.keyFrameIntervalSec;
    if (info.isDirectory && !reencode && keyFrame !== request.video.keyFrameIntervalSec) {
      warnings.push(`Key frames every ${keyFrame} s so that segments are exactly ${segmentSec} s long.`);
    }
    browserPlan = {
      container: 'fmp4',
      videoCodec: mezzVideo ?? 'avc',
      audioCodec: mezzAudio ?? 'aac',
      width,
      height,
      fps,
      videoBitrateKbps: mezzKbps,
      audioBitrateKbps: reencode ? Math.max(request.audio.bitrateKbps, 128) : request.audio.bitrateKbps,
      keyFrameIntervalSec: keyFrame,
      mezzanine: reencode,
    };
    processing = buildProcessing(request, server, browserPlan, warnings, blockers, reencode);
  } else {
    const container: BrowserContainer = isBrowserContainer(request.container) ? request.container : 'fmp4';
    browserPlan = {
      container,
      videoCodec: directVideo ?? 'avc',
      audioCodec: directAudio ?? 'aac',
      width,
      height,
      fps,
      videoBitrateKbps: qualityToKbps(request, width, height, fps),
      audioBitrateKbps: request.audio.bitrateKbps,
      keyFrameIntervalSec: request.video.keyFrameIntervalSec,
      mezzanine: false,
    };
    if (
      destination === 'server' &&
      request.container === 'mp4' &&
      ffmpeg !== null &&
      ffmpegHasMuxer(server, 'mp4')
    ) {
      // Crash-safe fragments while uploading, then a quick remux puts the index at the front.
      browserPlan.container = 'fmp4';
      processing = {
        container: 'mp4',
        video: { mode: 'copy' },
        audio: { mode: 'copy' },
        segmentSeconds: request.streaming.segmentSeconds,
        hlsSegmentType: request.streaming.hlsSegmentType,
        ladder: null,
      };
    }
    if (request.compression.enabled && destination === 'server') {
      // Already reported as a blocker when ffmpeg is missing; nothing else to do.
    }
  }

  if (destination === 'browser' && !browser.fileSystemAccess) {
    warnings.push(
      'This browser cannot stream to disk, so the file is assembled in memory. Keep exports under about 2 GB here, or use the server.',
    );
  }

  return {
    destination,
    browser: browserPlan,
    processing,
    final: {
      container: request.container,
      extension: info.extension,
      isDirectory: info.isDirectory,
      label: info.label,
    },
    warnings,
    blockers,
  };
}

function buildProcessing(
  request: ExportRequest,
  server: ServerCapabilities | null,
  browserPlan: BrowserEncodePlan,
  warnings: string[],
  blockers: string[],
  reencode: boolean,
): ProcessingSpec {
  const container = request.container;
  const info = CONTAINER_INFO[container];
  const ladder = request.streaming.ladder && info.isDirectory ? buildLadder(browserPlan.height) : null;

  let video: ProcessingSpec['video'];
  let audio: ProcessingSpec['audio'];

  if (reencode) {
    const codec: ServerVideoCodec = request.compression.enabled
      ? request.compression.codec
      : container === 'webm'
        ? 'vp9'
        : 'h264';
    if (!SERVER_CODEC_CONTAINERS[codec].includes(container)) {
      blockers.push(`${codec.toUpperCase()} cannot be stored in ${info.label}.`);
    }
    const encoder = pickServerVideoEncoder(server, codec, request.compression.hardware);
    if (encoder === null && server?.ffmpeg) {
      blockers.push(
        `The server's ffmpeg has no ${codec.toUpperCase()} encoder (looked for ${[...SERVER_VIDEO_ENCODERS[codec].software, ...SERVER_VIDEO_ENCODERS[codec].hardware].join(', ')}).`,
      );
    } else if (
      encoder !== null &&
      request.compression.hardware &&
      !SERVER_VIDEO_ENCODERS[codec].hardware.includes(encoder)
    ) {
      warnings.push(`No hardware ${codec.toUpperCase()} encoder found; using ${encoder}.`);
    }
    const c = request.compression;
    video = {
      mode: 'encode',
      codec,
      crf: c.enabled ? c.crf : 23,
      preset: c.enabled ? c.preset : 'medium',
      tune: c.enabled && c.tune === 'stillimage' && codec === 'h264' ? 'stillimage' : null,
      fps: c.enabled ? c.outputFps : null,
      height: c.enabled ? c.height : null,
      maxBitrateKbps: c.enabled ? c.maxBitrateKbps : null,
      keyFrameIntervalSec: info.isDirectory
        ? alignKeyFrameInterval(request.video.keyFrameIntervalSec, request.streaming.segmentSeconds)
        : request.video.keyFrameIntervalSec,
      hardware: c.enabled ? c.hardware : false,
    };
    const audioCodec: AudioCodecId =
      container === 'webm'
        ? 'opus'
        : request.audio.codec === 'opus' && SERVER_AUDIO_CONTAINERS.opus.includes(container)
          ? 'opus'
          : 'aac';
    const audioEncoder = pickServerAudioEncoder(server, audioCodec);
    if (audioEncoder === null && server?.ffmpeg) {
      blockers.push(`The server's ffmpeg has no ${audioCodec.toUpperCase()} encoder.`);
    }
    audio = { mode: 'encode', codec: audioCodec, bitrateKbps: request.audio.bitrateKbps };
  } else {
    video = { mode: 'copy' };
    audio = { mode: 'copy' };
    if (!info.video.includes(browserPlan.videoCodec) || !info.audio.includes(browserPlan.audioCodec)) {
      blockers.push(
        `${browserPlan.videoCodec}/${browserPlan.audioCodec} cannot be copied into ${info.label}.`,
      );
    }
  }

  if (server?.ffmpeg && !ffmpegHasMuxer(server, container)) {
    blockers.push(
      `The server's ffmpeg cannot write ${info.label} (muxer "${CONTAINER_MUXER[container]}" missing).`,
    );
  }

  return {
    container,
    video,
    audio,
    segmentSeconds: request.streaming.segmentSeconds,
    hlsSegmentType: request.streaming.hlsSegmentType,
    ladder,
  };
}

/** Default request used by the UI; the file name and directory are filled in later. */
export function defaultExportRequest(serverDirectory: string | null): ExportRequest {
  return {
    fileName: 'lecture',
    destination: serverDirectory
      ? { kind: 'server', directory: serverDirectory, overwrite: false }
      : { kind: 'browser' },
    container: 'mp4',
    resolution: { preset: '1080p' },
    fps: 15,
    video: {
      codec: 'auto',
      quality: { kind: 'level', level: 'high' as QualityLevel },
      keyFrameIntervalSec: 4,
    },
    audio: { codec: 'auto', bitrateKbps: 96 },
    compression: {
      enabled: false,
      codec: 'h264',
      crf: 23,
      preset: 'medium',
      tune: 'stillimage',
      outputFps: null,
      maxBitrateKbps: null,
      height: null,
      hardware: false,
    },
    streaming: { segmentSeconds: 4, hlsSegmentType: 'fmp4', ladder: false },
    order: 'recorded',
  };
}
