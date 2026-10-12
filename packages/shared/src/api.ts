/**
 * Wire types between the One Take client and server. Everything the server accepts is validated with the
 * zod schemas here; the TypeScript types are inferred from them so client and server cannot drift apart.
 */
import { z } from 'zod';

import {
  AUDIO_CODECS,
  BROWSER_CONTAINERS,
  CONTAINERS,
  SERVER_VIDEO_CODECS,
  VIDEO_CODECS,
  type AudioCodecId,
  type Container,
  type VideoCodecId,
} from './containers.js';
import { PERFORMANCE_MODES } from './performance.js';
import { type PresentationSupport } from './presentations.js';
import {
  COMPRESSION_PRESETS,
  FILLER_SENSITIVITIES,
  MAX_DIMENSION,
  MIN_DIMENSION,
  QUALITY_LEVELS,
  RESOLUTION_PRESETS,
  SPEED_MAX,
  SPEED_MIN,
} from './presets.js';
import { type SystemProfile } from './system.js';

export const ContainerSchema = z.enum(CONTAINERS);
export const BrowserContainerSchema = z.enum(BROWSER_CONTAINERS);
export const VideoCodecSchema = z.enum(VIDEO_CODECS);
export const AudioCodecSchema = z.enum(AUDIO_CODECS);
export const ServerVideoCodecSchema = z.enum(SERVER_VIDEO_CODECS);

const dimension = z.int().min(MIN_DIMENSION).max(MAX_DIMENSION);
const fpsSchema = z.number().min(1).max(120);

/* ------------------------------------------------------------------ */
/* What the user asks for (client side)                                */
/* ------------------------------------------------------------------ */

export const ResolutionSchema = z.union([
  z.object({ preset: z.enum(RESOLUTION_PRESETS) }),
  z.object({ width: dimension, height: dimension }),
]);
export type Resolution = z.infer<typeof ResolutionSchema>;

export const VideoQualitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('level'), level: z.enum(QUALITY_LEVELS) }),
  z.object({ kind: z.literal('bitrate'), kbps: z.int().min(100).max(200_000) }),
]);
export type VideoQuality = z.infer<typeof VideoQualitySchema>;

export const CompressionSchema = z.object({
  enabled: z.boolean(),
  codec: ServerVideoCodecSchema,
  crf: z.int().min(0).max(63),
  preset: z.enum(COMPRESSION_PRESETS),
  tune: z.enum(['none', 'stillimage']),
  /** Change the frame rate while re-encoding; null keeps the recorded rate. */
  outputFps: fpsSchema.nullable(),
  /** Cap the bitrate (kbit/s) for streaming-friendly output; null means CRF only. */
  maxBitrateKbps: z.int().min(100).max(200_000).nullable(),
  /** Scale to this height while re-encoding; null keeps the recorded size. */
  height: dimension.nullable(),
});
export type Compression = z.infer<typeof CompressionSchema>;

export const StreamingSchema = z.object({
  segmentSeconds: z.number().min(1).max(60),
  hlsSegmentType: z.enum(['fmp4', 'mpegts']),
  /** Produce several renditions (adaptive bitrate) instead of one. */
  ladder: z.boolean(),
});
export type Streaming = z.infer<typeof StreamingSchema>;

/**
 * What is done to the recording on the way out: played faster, fillers cut, the volume evened out, a
 * transcript made and subtitles added. All of it happens in the browser, except the transcription,
 * which the server does with whisper when it has it.
 */
export const EnhanceSchema = z.object({
  /** Playback speed; 1 leaves the pace alone. Pitch is kept. */
  speed: z.number().min(SPEED_MIN).max(SPEED_MAX),
  /** Bring every phrase to the same level, with a safety margin against clipping. */
  evenLoudness: z.boolean(),
  fillers: z.object({
    remove: z.boolean(),
    sensitivity: z.enum(FILLER_SENSITIVITIES),
  }),
  captions: z.object({
    /** Transcribe the speech on the server. Everything below needs this. */
    enabled: z.boolean(),
    /** A language code for the recogniser, or `auto`. */
    language: z.string().min(2).max(8),
    /** Draw the subtitles into the picture. */
    burnIn: z.boolean(),
    /** Save `.srt` and `.vtt` files next to the video. */
    sidecar: z.boolean(),
    /** Save the transcript as a `.txt` file next to the video. */
    transcript: z.boolean(),
  }),
});
export type Enhance = z.infer<typeof EnhanceSchema>;

export const DestinationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('server'), directory: z.string().min(1), overwrite: z.boolean() }),
  z.object({ kind: z.literal('browser') }),
]);
export type Destination = z.infer<typeof DestinationSchema>;

export const ExportRequestSchema = z.object({
  fileName: z.string().min(1).max(200),
  destination: DestinationSchema,
  container: ContainerSchema,
  resolution: ResolutionSchema,
  fps: fpsSchema,
  video: z.object({
    codec: z.enum(['auto', ...VIDEO_CODECS]),
    quality: VideoQualitySchema,
    keyFrameIntervalSec: z.number().min(0.5).max(60),
  }),
  audio: z.object({
    codec: z.enum(['auto', ...AUDIO_CODECS]),
    bitrateKbps: z.int().min(32).max(320),
  }),
  compression: CompressionSchema,
  streaming: StreamingSchema,
  order: z.enum(['recorded', 'slide']),
  /**
   * The hardware switch (use the dedicated encoder wherever this computer has one) and how hard to push
   * for speed versus file size; see performance.ts.
   */
  performance: z.object({ mode: z.enum(PERFORMANCE_MODES), hardware: z.boolean() }),
  enhance: EnhanceSchema,
});
export type ExportRequest = z.infer<typeof ExportRequestSchema>;

/* ------------------------------------------------------------------ */
/* What the server executes                                            */
/* ------------------------------------------------------------------ */

export const ProcessingVideoSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('copy') }),
  z.object({
    mode: z.literal('encode'),
    codec: ServerVideoCodecSchema,
    crf: z.int().min(0).max(63),
    preset: z.enum(COMPRESSION_PRESETS),
    tune: z.enum(['stillimage']).nullable(),
    fps: fpsSchema.nullable(),
    height: dimension.nullable(),
    maxBitrateKbps: z.int().min(100).max(200_000).nullable(),
    keyFrameIntervalSec: z.number().min(0.5).max(60),
    hardware: z.boolean(),
  }),
]);
export type ProcessingVideo = z.infer<typeof ProcessingVideoSchema>;

export const ProcessingAudioSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('copy') }),
  z.object({ mode: z.literal('encode'), codec: AudioCodecSchema, bitrateKbps: z.int().min(32).max(320) }),
]);
export type ProcessingAudio = z.infer<typeof ProcessingAudioSchema>;

export const LadderRungSchema = z.object({
  name: z.string().min(1).max(20),
  height: dimension,
  videoBitrateKbps: z.int().min(100).max(200_000),
  audioBitrateKbps: z.int().min(32).max(320),
});
export type LadderRung = z.infer<typeof LadderRungSchema>;

export const ProcessingSpecSchema = z.object({
  container: ContainerSchema,
  video: ProcessingVideoSchema,
  audio: ProcessingAudioSchema,
  segmentSeconds: z.number().min(1).max(60),
  hlsSegmentType: z.enum(['fmp4', 'mpegts']),
  ladder: z.array(LadderRungSchema).min(1).max(6).nullable(),
});
export type ProcessingSpec = z.infer<typeof ProcessingSpecSchema>;

export const UploadSpecSchema = z.object({
  container: BrowserContainerSchema,
  videoCodec: VideoCodecSchema,
  audioCodec: AudioCodecSchema,
  width: dimension,
  height: dimension,
  fps: fpsSchema,
  durationSec: z.number().min(0),
  /** Upper bound of the upload size, used for the free-space check. */
  estimatedBytes: z.number().min(0),
});
export type UploadSpec = z.infer<typeof UploadSpecSchema>;

/** A small text file written next to the video when it is done: subtitles or the transcript. */
export const SIDECAR_EXTENSIONS = ['srt', 'vtt', 'txt'] as const;
export type SidecarExtension = (typeof SIDECAR_EXTENSIONS)[number];
export const SidecarSchema = z.object({
  extension: z.enum(SIDECAR_EXTENSIONS),
  content: z.string().max(4_000_000),
});
export type Sidecar = z.infer<typeof SidecarSchema>;

export const CreateExportJobSchema = z.object({
  fileName: z.string().min(1).max(200),
  directory: z.string().min(1),
  overwrite: z.boolean(),
  upload: UploadSpecSchema,
  processing: ProcessingSpecSchema.nullable(),
  /** Written next to the result (inside the folder for HLS and DASH) once it is done. */
  sidecars: z.array(SidecarSchema).max(SIDECAR_EXTENSIONS.length).optional(),
});
export type CreateExportJobRequest = z.infer<typeof CreateExportJobSchema>;

/* ------------------------------------------------------------------ */
/* Transcription                                                       */
/* ------------------------------------------------------------------ */

/** One word as the recogniser heard it, in seconds into the audio that was sent. */
export interface TranscriptWord {
  text: string;
  start: number;
  end: number;
}

export type TranscriptionState = 'running' | 'done' | 'failed' | 'cancelled';

export interface TranscriptionJob {
  id: string;
  state: TranscriptionState;
  /** 0..1 of the audio transcribed so far; null before the recogniser reports. */
  progress: number | null;
  message: string;
  /** Seconds of audio that were sent. */
  durationSec: number;
  /** The words, once done. */
  words: TranscriptWord[] | null;
  /** The language the recogniser settled on (a code such as `en`), once done. */
  language: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptionEvent {
  type: 'job';
  job: TranscriptionJob;
}

/** Which speech recogniser the server found, from `/api/capabilities`. */
export interface TranscriptionInfo {
  /** `whisper-cpp` is whisper.cpp's `whisper-cli`; `openai-whisper` is the Python `whisper` command. */
  engine: 'whisper-cpp' | 'openai-whisper';
  path: string;
  version: string | null;
  /** A model name (`base.en`) for openai-whisper, a file for whisper.cpp. */
  model: string;
  /** Whether the model is already on disk; openai-whisper downloads it on first use. */
  modelReady: boolean;
  /** One line for the dialog. */
  note: string;
}

export const FinishExportJobSchema = z.object({ totalBytes: z.int().min(0) });
export type FinishExportJobRequest = z.infer<typeof FinishExportJobSchema>;

export const ListDirectoryQuerySchema = z.object({
  path: z.string().optional(),
  files: z
    .string()
    .optional()
    .transform((value) => value === '1' || value === 'true'),
});

export const MakeDirectorySchema = z.object({ path: z.string().min(1) });

/* ------------------------------------------------------------------ */
/* Server responses                                                    */
/* ------------------------------------------------------------------ */

export type JobState = 'uploading' | 'processing' | 'done' | 'failed' | 'cancelled';

/** One process as the operating system sees it, sampled while it runs. */
export interface ProcessLoad {
  pid: number;
  /**
   * CPU use as a percentage of one core, so 800 means eight cores busy. On macOS and Linux this is
   * what `ps` reports; null on platforms where it cannot be read.
   */
  cpuPercent: number | null;
  /** Resident memory; null when unknown. */
  rssBytes: number | null;
}

export interface JobProgress {
  stage: 'upload' | 'process' | 'finalize' | 'done';
  /** 0..100, or null when unknown. */
  percent: number | null;
  message: string;
  /** Processing speed relative to real time, when ffmpeg reports it. */
  speed: number | null;
  /** Seconds of output ffmpeg has produced so far; null outside the ffmpeg stage. */
  outTimeSec: number | null;
  /** Frames per second ffmpeg is managing right now, as it reports them. */
  fps: number | null;
  /** Bytes ffmpeg has written so far, as it reports them. */
  outputBytes: number | null;
  /** The ffmpeg process, sampled about once a second while it runs; null otherwise. */
  process: ProcessLoad | null;
}

/**
 * How busy the computer running the server is right now (`GET /api/system/load`). The browser polls
 * this during an export, so the user sees what the export costs while it runs.
 */
export interface SystemLoad {
  at: string;
  cpu: {
    /** Whole-machine CPU use, 0..100, averaged since the previous sample; null on the very first one. */
    percent: number | null;
    cores: number;
  };
  memory: {
    totalBytes: number;
    /** What the OS could hand out right now (free plus reclaimable cache); null when unknown. */
    availableBytes: number | null;
  };
  /** The One Take server process itself. */
  server: ProcessLoad;
}

export interface JobOutput {
  path: string;
  kind: 'file' | 'directory';
  bytes: number;
}

export interface ExportJob {
  id: string;
  createdAt: string;
  updatedAt: string;
  fileName: string;
  directory: string;
  state: JobState;
  bytesReceived: number;
  progress: JobProgress;
  outputs: JobOutput[];
  error: string | null;
  upload: UploadSpec;
  processing: ProcessingSpec | null;
  /** The ffmpeg command that was run, for transparency and bug reports. */
  command: string | null;
  /** Subtitle and transcript files written next to the result, once it is done. */
  sidecars: string[];
}

export type JobEvent = { type: 'job'; job: ExportJob } | { type: 'log'; line: string };

/**
 * A finished export the server remembers across restarts (`GET /api/library`): what was written where,
 * so the app can list, play, reveal and delete the videos it made. Exports saved through the browser
 * never pass through the server and are not recorded.
 */
export interface ExportRecord {
  /** The id of the job that made it. */
  id: string;
  /** When the file was finished. */
  createdAt: string;
  /** The file, or the folder for HLS and DASH. */
  path: string;
  directory: string;
  /** `lecture.mp4`, or `lecture` for a folder. */
  fileName: string;
  kind: 'file' | 'directory';
  container: Container;
  /** Size on disk now (the whole folder for HLS and DASH); the size at export time when it is gone. */
  bytes: number;
  /** False when the file has been moved or deleted outside One Take since. */
  exists: boolean;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: VideoCodecId;
  audioCodec: AudioCodecId;
  /** The ffmpeg encoder that produced the video (`h264_videotoolbox`, `libx264`), null for a stream copy. */
  encoder: string | null;
  /** The ffmpeg command that ran, when one did. */
  command: string | null;
  /** Subtitle and transcript files written next to the video, as paths. */
  sidecars: string[];
}

export interface FfmpegInfo {
  path: string;
  version: string;
  encoders: string[];
  muxers: string[];
}

export interface ServerCapabilities {
  name: 'one-take-server';
  version: string;
  platform: string;
  homeDirectory: string;
  defaultDirectory: string;
  ffmpeg: FfmpegInfo | null;
  ffprobePath: string | null;
  /** Handy folders for the folder picker (home, Desktop, Movies, ...). Only existing ones are listed. */
  shortcuts: { label: string; path: string }[];
  /** Which deck formats the server turns into PDF with its built-in JavaScript renderer. */
  presentations: PresentationSupport;
  /** CPU, memory, GPU and working hardware encoders of the machine the server runs on. */
  system: SystemProfile | null;
  /** The speech recogniser for transcripts and subtitles, when one is installed. */
  transcription: TranscriptionInfo | null;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  bytes: number | null;
  modifiedAt: string | null;
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  exists: boolean;
  writable: boolean;
  freeBytes: number | null;
  entries: DirectoryEntry[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface ExtensionInfo {
  container: Container;
  extension: string;
}
