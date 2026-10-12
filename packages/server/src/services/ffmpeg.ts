/**
 * Everything that talks to ffmpeg: finding it, asking what it can do, building argument lists for a
 * processing spec, and running it with progress reporting.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  AUDIO_CODEC_INFO,
  SERVER_VIDEO_ENCODERS,
  type AudioCodecId,
  type FfmpegInfo,
  type ProcessingSpec,
  type ServerVideoCodec,
  type VideoCodecId,
} from '@one-take/shared';

const execFileAsync = promisify(execFile);

const COMMON_LOCATIONS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  'C:\\ffmpeg\\bin',
  'C:\\Program Files\\ffmpeg\\bin',
];

async function tryVersion(binary: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binary, ['-version'], { timeout: 10_000 });
    const first = stdout.split('\n')[0] ?? '';
    const m = /version\s+(\S+)/.exec(first);
    return m?.[1] ?? first.trim();
  } catch {
    return null;
  }
}

async function locate(
  name: string,
  explicit: string | null,
): Promise<{ path: string; version: string } | null> {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates = [explicit, name, ...COMMON_LOCATIONS.map((dir) => path.join(dir, exe))].filter(
    (c): c is string => typeof c === 'string' && c.length > 0,
  );
  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && !existsSync(candidate)) continue;
    const version = await tryVersion(candidate);
    if (version !== null) return { path: candidate, version };
  }
  return null;
}

/** Parses `ffmpeg -encoders` / `-muxers` output: one name per line after the header. */
export function parseCapabilityList(output: string): string[] {
  const names: string[] = [];
  let pastHeader = false;
  for (const raw of output.split('\n')) {
    const line = raw.trimEnd();
    if (!pastHeader) {
      if (/^\s*-+\s*$/.test(line)) pastHeader = true;
      continue;
    }
    // encoders: " V....D libx264 ..."; muxers: "  E  mp4 ..." (the flag column is 1 to 6 characters wide)
    const m = /^\s*[A-Za-z.]{1,6}\s+(\S+)/.exec(line);
    if (m?.[1]) names.push(m[1]);
  }
  return names;
}

export async function detectFfmpeg(explicitPath: string | null): Promise<FfmpegInfo | null> {
  const found = await locate('ffmpeg', explicitPath);
  if (!found) return null;
  const [enc, mux] = await Promise.all([
    execFileAsync(found.path, ['-hide_banner', '-encoders'], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }),
    execFileAsync(found.path, ['-hide_banner', '-muxers'], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }),
  ]);
  return {
    path: found.path,
    version: found.version,
    encoders: parseCapabilityList(enc.stdout),
    muxers: parseCapabilityList(mux.stdout),
  };
}

export async function detectFfprobe(explicitPath: string | null): Promise<string | null> {
  return (await locate('ffprobe', explicitPath))?.path ?? null;
}

/** Parses `ffmpeg -hwaccels`: one method per line after the heading. */
export function parseHwaccels(output: string): string[] {
  return output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^hardware acceleration methods/i.test(l));
}

export async function detectHwaccels(ffmpegPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(ffmpegPath, ['-hide_banner', '-hwaccels'], { timeout: 10_000 });
    return parseHwaccels(stdout);
  } catch {
    return [];
  }
}

/**
 * Encodes a third of a second of a synthetic picture with `encoder` and throws the result away. An
 * encoder that is compiled in but has no device or driver behind it fails here instead of failing the
 * user's export later.
 */
export async function selfTestEncoder(
  ffmpegPath: string,
  encoder: string,
  timeoutMs = 8000,
): Promise<boolean> {
  try {
    await execFileAsync(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=256x144:rate=10',
        '-t',
        '0.3',
        '-pix_fmt',
        'yuv420p',
        '-c:v',
        encoder,
        '-f',
        'null',
        '-',
      ],
      { timeout: timeoutMs, windowsHide: true },
    );
    return true;
  } catch {
    return false;
  }
}

export interface BenchmarkResult {
  encoder: string;
  frames: number;
  seconds: number;
  /** Frames per second of wall time, start-up included. */
  fps: number;
}

/**
 * Times an encode of `seconds` of synthetic 16:9 video at `height` with one encoder; null when it fails.
 * Used by `npm run doctor --bench` to show which encoder is really the fastest on this machine.
 */
export async function benchmarkEncoder(
  ffmpegPath: string,
  encoder: string,
  options: { height?: number; fps?: number; seconds?: number; preset?: string; timeoutMs?: number } = {},
): Promise<BenchmarkResult | null> {
  const height = options.height ?? 1080;
  const width = Math.round((height * 16) / 9 / 2) * 2;
  const fps = options.fps ?? 30;
  const seconds = options.seconds ?? 6;
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-f',
    'lavfi',
    '-i',
    // One new picture a second, repeated to `fps`: slide video as an encoder sees it (real slides change
    // far less often), so software encoders get credit for skipping unchanged blocks as they will later.
    `testsrc2=size=${width}x${height}:rate=1`,
    '-t',
    String(seconds),
    '-vf',
    `fps=${fps}`,
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    encoder,
    '-g',
    String(fps * 4),
  ];
  if (options.preset && (encoder === 'libx264' || encoder === 'libx265'))
    args.push('-preset', options.preset);
  if (encoder === 'libx264') args.push('-tune', 'stillimage');
  args.push('-f', 'null', '-');
  const started = performance.now();
  try {
    await execFileAsync(ffmpegPath, args, { timeout: options.timeoutMs ?? 120_000, windowsHide: true });
  } catch {
    return null;
  }
  const wall = (performance.now() - started) / 1000;
  const frames = fps * seconds;
  return { encoder, frames, seconds: wall, fps: wall > 0 ? frames / wall : 0 };
}

/* ------------------------------------------------------------------ */
/* Argument builder                                                    */
/* ------------------------------------------------------------------ */

export interface FfmpegInputInfo {
  path: string;
  videoCodec: VideoCodecId;
  audioCodec: AudioCodecId;
  fps: number;
  height: number;
}

export interface FfmpegPlan {
  args: string[];
  /** ffmpeg runs here so playlist entries stay relative. */
  cwd: string;
  /** Path of the playable result (a file, or the manifest inside the output folder). */
  mainFile: string;
  /** The video encoder that does the work (`libx264`, `h264_videotoolbox`), null for a stream copy. */
  videoEncoder: string | null;
}

export function pickVideoEncoder(
  info: FfmpegInfo,
  codec: ServerVideoCodec,
  preferHardware: boolean,
): string | null {
  const { software, hardware } = SERVER_VIDEO_ENCODERS[codec];
  const order = preferHardware ? [...hardware, ...software] : [...software, ...hardware];
  return order.find((e) => info.encoders.includes(e)) ?? null;
}

export function pickAudioEncoder(info: FfmpegInfo, codec: AudioCodecId): string | null {
  return AUDIO_CODEC_INFO[codec].ffmpegEncoders.find((e) => info.encoders.includes(e)) ?? null;
}

const PRESET_TO_VPX_CPU: Record<string, number> = {
  ultrafast: 5,
  veryfast: 4,
  fast: 3,
  medium: 2,
  slow: 1,
  slower: 0,
  veryslow: 0,
};
const PRESET_TO_SVT: Record<string, number> = {
  ultrafast: 12,
  veryfast: 10,
  fast: 8,
  medium: 6,
  slow: 4,
  slower: 3,
  veryslow: 2,
};
const PRESET_TO_AOM_CPU: Record<string, number> = {
  ultrafast: 8,
  veryfast: 7,
  fast: 6,
  medium: 5,
  slow: 4,
  slower: 3,
  veryslow: 2,
};
const PRESET_TO_NVENC: Record<string, string> = {
  ultrafast: 'p1',
  veryfast: 'p2',
  fast: 'p3',
  medium: 'p4',
  slow: 'p5',
  slower: 'p6',
  veryslow: 'p7',
};

/** Rate-control and key frame arguments for one encoder. `streamIndex` is set for ladder outputs. */
function videoEncoderArgs(
  encoder: string,
  v: Extract<ProcessingSpec['video'], { mode: 'encode' }>,
  gop: number,
  streamIndex: number | null,
  bitrateKbps: number | null,
): string[] {
  const s = streamIndex === null ? '' : `:${streamIndex}`;
  const args: string[] = [`-c:v${s}`, encoder];
  const maxrate = bitrateKbps ?? v.maxBitrateKbps;
  switch (encoder) {
    case 'libx264':
      args.push(`-preset${s}`, v.preset, '-pix_fmt', 'yuv420p', `-profile:v${s}`, 'high');
      if (v.tune === 'stillimage') args.push(`-tune${s}`, 'stillimage');
      if (bitrateKbps !== null) args.push(`-b:v${s}`, `${bitrateKbps}k`);
      else args.push(`-crf${s}`, String(v.crf));
      if (maxrate !== null) args.push(`-maxrate${s}`, `${maxrate}k`, `-bufsize${s}`, `${maxrate * 2}k`);
      args.push(`-g${s}`, String(gop), `-keyint_min${s}`, String(gop), `-sc_threshold${s}`, '0');
      break;
    case 'libx265': {
      const params = [`keyint=${gop}`, `min-keyint=${gop}`, 'scenecut=0'];
      if (maxrate !== null) params.push(`vbv-maxrate=${maxrate}`, `vbv-bufsize=${maxrate * 2}`);
      args.push(`-preset${s}`, v.preset, '-pix_fmt', 'yuv420p', `-tag:v${s}`, 'hvc1');
      if (bitrateKbps !== null) args.push(`-b:v${s}`, `${bitrateKbps}k`);
      else args.push(`-crf${s}`, String(v.crf));
      args.push(`-x265-params${s}`, params.join(':'));
      break;
    }
    case 'libvpx-vp9':
      args.push(
        '-pix_fmt',
        'yuv420p',
        `-row-mt${s}`,
        '1',
        `-deadline${s}`,
        'good',
        `-cpu-used${s}`,
        String(PRESET_TO_VPX_CPU[v.preset] ?? 2),
      );
      if (bitrateKbps !== null) args.push(`-b:v${s}`, `${bitrateKbps}k`);
      else args.push(`-crf${s}`, String(v.crf), `-b:v${s}`, maxrate !== null ? `${maxrate}k` : '0');
      args.push(`-g${s}`, String(gop));
      break;
    case 'libsvtav1':
      args.push('-pix_fmt', 'yuv420p', `-preset${s}`, String(PRESET_TO_SVT[v.preset] ?? 6));
      if (bitrateKbps !== null) args.push(`-b:v${s}`, `${bitrateKbps}k`);
      else args.push(`-crf${s}`, String(v.crf));
      if (maxrate !== null) args.push(`-maxrate${s}`, `${maxrate}k`, `-bufsize${s}`, `${maxrate * 2}k`);
      args.push(`-g${s}`, String(gop));
      break;
    case 'libaom-av1':
      args.push(
        '-pix_fmt',
        'yuv420p',
        `-cpu-used${s}`,
        String(PRESET_TO_AOM_CPU[v.preset] ?? 5),
        `-row-mt${s}`,
        '1',
      );
      if (bitrateKbps !== null) args.push(`-b:v${s}`, `${bitrateKbps}k`);
      else args.push(`-crf${s}`, String(v.crf), `-b:v${s}`, '0');
      args.push(`-g${s}`, String(gop));
      break;
    default:
      if (encoder.endsWith('_videotoolbox')) {
        // Apple hardware: constant quality is 1..100 (higher is better); map CRF onto it.
        const q = Math.round(100 - (v.crf / 51) * 100);
        args.push('-pix_fmt', 'yuv420p', `-allow_sw${s}`, '1', `-realtime${s}`, '0');
        if (bitrateKbps !== null) args.push(`-b:v${s}`, `${bitrateKbps}k`);
        else args.push(`-q:v${s}`, String(Math.max(1, Math.min(100, q))));
        if (encoder.startsWith('hevc')) args.push(`-tag:v${s}`, 'hvc1');
      } else if (encoder.endsWith('_nvenc')) {
        args.push('-pix_fmt', 'yuv420p', `-preset${s}`, PRESET_TO_NVENC[v.preset] ?? 'p4', `-rc${s}`, 'vbr');
        if (bitrateKbps !== null) args.push(`-b:v${s}`, `${bitrateKbps}k`);
        else args.push(`-cq${s}`, String(v.crf), `-b:v${s}`, '0');
      } else if (encoder.endsWith('_qsv')) {
        args.push(`-global_quality${s}`, String(v.crf));
        if (bitrateKbps !== null) args.push(`-b:v${s}`, `${bitrateKbps}k`);
      } else {
        if (bitrateKbps !== null) args.push(`-b:v${s}`, `${bitrateKbps}k`);
      }
      if (maxrate !== null) args.push(`-maxrate${s}`, `${maxrate}k`, `-bufsize${s}`, `${maxrate * 2}k`);
      args.push(`-g${s}`, String(gop));
  }
  return args;
}

function containerArgs(spec: ProcessingSpec, outputName: string): { args: string[]; mainFile: string } {
  const seg = spec.segmentSeconds;
  switch (spec.container) {
    case 'mp4':
      return { args: ['-movflags', '+faststart', '-f', 'mp4', outputName], mainFile: outputName };
    case 'fmp4':
      return {
        args: ['-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', outputName],
        mainFile: outputName,
      };
    case 'mov':
      return { args: ['-movflags', '+faststart', '-f', 'mov', outputName], mainFile: outputName };
    case 'mkv':
      return { args: ['-f', 'matroska', outputName], mainFile: outputName };
    case 'webm':
      return { args: ['-f', 'webm', outputName], mainFile: outputName };
    case 'hls': {
      const fmp4 = spec.hlsSegmentType === 'fmp4';
      const ladder = spec.ladder !== null;
      const segName = ladder
        ? fmp4
          ? '%v/seg_%05d.m4s'
          : '%v/seg_%05d.ts'
        : fmp4
          ? 'seg_%05d.m4s'
          : 'seg_%05d.ts';
      const args = [
        '-f',
        'hls',
        '-hls_time',
        String(seg),
        '-hls_playlist_type',
        'vod',
        '-hls_flags',
        'independent_segments',
        '-hls_segment_type',
        fmp4 ? 'fmp4' : 'mpegts',
        '-hls_segment_filename',
        segName,
      ];
      if (fmp4) args.push('-hls_fmp4_init_filename', 'init.mp4');
      if (ladder) args.push('-master_pl_name', 'master.m3u8', '%v/index.m3u8');
      else args.push('index.m3u8');
      return { args, mainFile: ladder ? 'master.m3u8' : 'index.m3u8' };
    }
    case 'dash':
      return {
        args: [
          '-f',
          'dash',
          '-seg_duration',
          String(seg),
          '-use_timeline',
          '1',
          '-use_template',
          '1',
          '-init_seg_name',
          'init-$RepresentationID$.m4s',
          '-media_seg_name',
          'chunk-$RepresentationID$-$Number%05d$.m4s',
          '-adaptation_sets',
          'id=0,streams=v id=1,streams=a',
          'manifest.mpd',
        ],
        mainFile: 'manifest.mpd',
      };
  }
}

/**
 * Builds the ffmpeg command for a processing spec. `outputPath` is the temporary file (single-file
 * containers) or the temporary folder (HLS/DASH) the result is written into.
 *
 * Decoding is left to the CPU on purpose: the upload is slide video, whose P-frames are nearly empty,
 * and software decoding ran at thousands of frames per second where `-hwaccel videotoolbox` managed a
 * few hundred (measured on an M2 Max: 1.5 s against 33 s for eleven minutes of 1080p).
 */
export function buildFfmpegArgs(
  spec: ProcessingSpec,
  input: FfmpegInputInfo,
  outputPath: string,
  info: FfmpegInfo,
): FfmpegPlan {
  const isDir = spec.container === 'hls' || spec.container === 'dash';
  const cwd = isDir ? outputPath : path.dirname(outputPath);
  const outputName = isDir ? '' : path.basename(outputPath);
  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    '-nostats',
    '-progress',
    'pipe:1',
    '-i',
    input.path,
  ];
  const v = spec.video;
  const outFps = v.mode === 'encode' && v.fps !== null ? v.fps : input.fps;
  const gop = Math.max(
    1,
    Math.round((v.mode === 'encode' ? v.keyFrameIntervalSec : spec.segmentSeconds) * outFps),
  );
  let videoEncoder: string | null = null;

  if (spec.ladder && v.mode === 'encode') {
    const encoder = pickVideoEncoder(info, v.codec, v.hardware);
    if (!encoder) throw new Error(`ffmpeg has no ${v.codec} encoder`);
    videoEncoder = encoder;
    const audioCodec = spec.audio.mode === 'encode' ? spec.audio.codec : 'aac';
    const audioEncoder = pickAudioEncoder(info, audioCodec);
    if (!audioEncoder) throw new Error(`ffmpeg has no ${audioCodec} encoder`);
    const rungs = spec.ladder;
    const n = rungs.length;
    const split = `[0:v]${v.fps !== null ? `fps=${v.fps},` : ''}split=${n}${rungs.map((_, i) => `[v${i}]`).join('')}`;
    const scales = rungs.map((r, i) => `[v${i}]scale=-2:${r.height}[o${i}]`);
    args.push('-filter_complex', [split, ...scales].join(';'));
    rungs.forEach((r, i) => {
      args.push('-map', `[o${i}]`, '-map', '0:a:0');
      args.push(...videoEncoderArgs(encoder, v, gop, i, r.videoBitrateKbps));
      args.push(`-c:a:${i}`, audioEncoder, `-b:a:${i}`, `${r.audioBitrateKbps}k`);
    });
    if (spec.container === 'hls') {
      args.push('-var_stream_map', rungs.map((r, i) => `v:${i},a:${i},name:${r.name}`).join(' '));
    }
  } else {
    args.push('-map', '0:v:0', '-map', '0:a:0?');
    if (v.mode === 'copy') {
      args.push('-c:v', 'copy');
    } else {
      const encoder = pickVideoEncoder(info, v.codec, v.hardware);
      if (!encoder) throw new Error(`ffmpeg has no ${v.codec} encoder`);
      videoEncoder = encoder;
      const filters: string[] = [];
      if (v.fps !== null) filters.push(`fps=${v.fps}`);
      if (v.height !== null && v.height !== input.height) filters.push(`scale=-2:${v.height}`);
      if (filters.length) args.push('-vf', filters.join(','));
      args.push(...videoEncoderArgs(encoder, v, gop, null, null));
    }
    if (spec.audio.mode === 'copy') {
      args.push('-c:a', 'copy');
    } else {
      const audioEncoder = pickAudioEncoder(info, spec.audio.codec);
      if (!audioEncoder) throw new Error(`ffmpeg has no ${spec.audio.codec} encoder`);
      args.push('-c:a', audioEncoder, '-b:a', `${spec.audio.bitrateKbps}k`);
      if (spec.audio.codec === 'opus') args.push('-ar', '48000');
    }
  }
  if (
    spec.container === 'hls' &&
    spec.hlsSegmentType === 'mpegts' &&
    spec.audio.mode === 'copy' &&
    input.audioCodec !== 'aac'
  ) {
    throw new Error('MPEG-TS segments need AAC audio');
  }

  const container = containerArgs(spec, outputName);
  args.push(...container.args);
  return {
    args,
    cwd,
    mainFile: isDir ? path.join(outputPath, container.mainFile) : outputPath,
    videoEncoder,
  };
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

/** What ffmpeg's `-progress` output says about the encode so far. */
export interface FfmpegProgress {
  /** Seconds of output written. */
  outTimeSec: number | null;
  /** Encoding speed relative to real time. */
  speed: number | null;
  /** Frames per second being encoded. */
  fps: number | null;
  /** Bytes written to the output so far. */
  outputBytes: number | null;
  /** Output bitrate in kbit/s. */
  bitrateKbps: number | null;
}

export interface RunOptions {
  cwd: string;
  signal: AbortSignal;
  /** Called once per progress block (every half second or so) with everything the block carried. */
  onProgress?: (progress: FfmpegProgress) => void;
  onLog?: (line: string) => void;
  /** Called with the child's process id once it is running, for load sampling. */
  onSpawn?: (pid: number) => void;
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderrTail: string,
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

/**
 * Parses one `-progress` line. A block is a run of `key=value` lines ended by `progress=continue` or
 * `progress=end`; the values the UI uses come back under their names, `end: true` marks the end of a
 * block, and anything else (or `N/A`) is `{}`.
 */
export function parseProgressLine(line: string): Partial<FfmpegProgress> & { end?: boolean } {
  const eq = line.indexOf('=');
  if (eq < 0) return {};
  const key = line.slice(0, eq).trim();
  const value = line.slice(eq + 1).trim();
  if (key === 'progress') return { end: true };
  if (key === 'out_time_us' || key === 'out_time_ms') {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? { outTimeSec: n / 1e6 } : {};
  }
  if (key === 'speed') {
    const n = Number(value.replace('x', ''));
    return Number.isFinite(n) ? { speed: n } : {};
  }
  if (key === 'fps') {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? { fps: n } : {};
  }
  if (key === 'total_size') {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? { outputBytes: n } : {};
  }
  if (key === 'bitrate') {
    const n = Number(value.replace(/k?bits\/s$/, ''));
    return Number.isFinite(n) && n >= 0 ? { bitrateKbps: n } : {};
  }
  return {};
}

export function runFfmpeg(ffmpegPath: string, args: string[], options: RunOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new FfmpegError('cancelled', null, ''));
      return;
    }
    const child = spawn(ffmpegPath, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stderrLines: string[] = [];
    let stdoutBuffer = '';
    // Values carry over between blocks: ffmpeg prints `speed=N/A` on the first block, for instance.
    const progress: FfmpegProgress = {
      outTimeSec: null,
      speed: null,
      fps: null,
      outputBytes: null,
      bitrateKbps: null,
    };

    const onAbort = () => {
      child.kill('SIGKILL');
    };
    options.signal.addEventListener('abort', onAbort, { once: true });
    if (child.pid !== undefined) options.onSpawn?.(child.pid);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      let nl = stdoutBuffer.indexOf('\n');
      while (nl >= 0) {
        const line = stdoutBuffer.slice(0, nl);
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        const { end, ...p } = parseProgressLine(line);
        Object.assign(progress, p);
        if (end && progress.outTimeSec !== null) options.onProgress?.({ ...progress });
        nl = stdoutBuffer.indexOf('\n');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue;
        stderrLines.push(line);
        if (stderrLines.length > 50) stderrLines.shift();
        options.onLog?.(line);
      }
    });
    child.on('error', (error) => {
      options.signal.removeEventListener('abort', onAbort);
      reject(new FfmpegError(`Could not start ffmpeg: ${error.message}`, null, ''));
    });
    child.on('close', (code) => {
      options.signal.removeEventListener('abort', onAbort);
      if (options.signal.aborted) {
        reject(new FfmpegError('cancelled', code, stderrLines.join('\n')));
      } else if (code === 0) {
        resolve();
      } else {
        const tail = stderrLines.slice(-6).join('\n');
        reject(
          new FfmpegError(
            `ffmpeg exited with code ${code ?? 'unknown'}${tail ? `: ${tail}` : ''}`,
            code,
            stderrLines.join('\n'),
          ),
        );
      }
    });
  });
}

/** Quote arguments the way a shell user would type them, for logs and the UI. */
export function formatCommand(binary: string, args: string[]): string {
  const q = (s: string) => (/^[\w./:=+%@$,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  return [binary, ...args].map(q).join(' ');
}
