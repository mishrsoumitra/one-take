/**
 * The pre-flight check: what this computer has (CPU, memory, GPU, disk) and which ffmpeg hardware
 * encoders really work here, boiled down to a performance tier. Runs once when the server starts (and
 * on demand through `npm run doctor`); the result goes into /api/capabilities so the browser can plan
 * exports for this machine instead of a generic one.
 *
 * Every probe is best effort with a timeout: a missing tool means "unknown", never a failed start.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  deriveTier,
  formatGb,
  maxEncodeJobsFor,
  SERVER_VIDEO_ENCODERS,
  systemNotes,
  TIER_LABELS,
  type CpuInfo,
  type FfmpegAcceleration,
  type FfmpegInfo,
  type GpuInfo,
  type MemoryInfo,
  type SystemProfile,
} from '@one-take/shared';

import {
  benchmarkDecoder,
  benchmarkEncoder,
  detectHwaccels,
  makeTestClip,
  preferredHwaccels,
  selfTestDecoder,
  selfTestEncoder,
} from './ffmpeg.js';

const execFileAsync = promisify(execFile);

/** Runs a command and returns stdout, or null when it is missing, fails or takes too long. */
export type Exec = (command: string, args: string[], timeoutMs: number) => Promise<string | null>;

export const defaultExec: Exec = async (command, args, timeoutMs) => {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
};

export interface DetectSystemOptions {
  ffmpeg: FfmpegInfo | null;
  /** Where exports go by default; free space is measured here. */
  outputDirectory: string;
  /** Run a short test encode with every listed hardware encoder (about 0.2 s each). Default true. */
  verify?: boolean;
  platform?: NodeJS.Platform;
  exec?: Exec;
  timeoutMs?: number;
}

/* ------------------------------------------------------------------ */
/* CPU                                                                 */
/* ------------------------------------------------------------------ */

export async function detectCpu(platform: NodeJS.Platform, exec: Exec, timeoutMs: number): Promise<CpuInfo> {
  const cpus = os.cpus();
  const cores = os.availableParallelism();
  let model = (cpus[0]?.model ?? '').replace(/\s+/g, ' ').trim();
  let performanceCores: number | null = null;
  let efficiencyCores: number | null = null;
  if (platform === 'darwin') {
    const out = await exec(
      'sysctl',
      ['-n', 'machdep.cpu.brand_string', 'hw.perflevel0.physicalcpu', 'hw.perflevel1.physicalcpu'],
      timeoutMs,
    );
    const lines = (out ?? '').split('\n').map((l) => l.trim());
    if (lines[0]) model = lines[0];
    const p = Number(lines[1]);
    const e = Number(lines[2]);
    if (Number.isInteger(p) && p > 0) {
      performanceCores = p;
      efficiencyCores = Number.isInteger(e) && e >= 0 ? e : 0;
    }
  }
  if (!model) model = `${os.arch()} CPU`;
  return { model, cores, performanceCores, efficiencyCores, architecture: os.arch() };
}

/* ------------------------------------------------------------------ */
/* Memory                                                              */
/* ------------------------------------------------------------------ */

/** macOS `vm_stat`: free + inactive + speculative pages are what the OS would hand to a new process. */
export function parseVmStat(output: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1] ?? '');
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
  const read = (label: string) => {
    const m = new RegExp(`${label}:\\s+(\\d+)`).exec(output);
    return m ? Number(m[1]) : 0;
  };
  const pages = read('Pages free') + read('Pages inactive') + read('Pages speculative');
  return pages > 0 ? pages * pageSize : null;
}

/** Linux `/proc/meminfo`: MemAvailable already counts reclaimable cache. */
export function parseMeminfo(output: string): number | null {
  const m = /MemAvailable:\s+(\d+)\s*kB/.exec(output);
  return m ? Number(m[1]) * 1024 : null;
}

export async function detectMemory(
  platform: NodeJS.Platform,
  exec: Exec,
  timeoutMs: number,
): Promise<MemoryInfo> {
  const totalBytes = os.totalmem();
  let availableBytes: number | null = null;
  if (platform === 'darwin') {
    availableBytes = parseVmStat((await exec('vm_stat', [], timeoutMs)) ?? '');
  } else if (platform === 'linux') {
    try {
      availableBytes = parseMeminfo(await fs.readFile('/proc/meminfo', 'utf8'));
    } catch {
      availableBytes = null;
    }
  }
  availableBytes ??= os.freemem();
  return { totalBytes, availableBytes };
}

/* ------------------------------------------------------------------ */
/* GPU                                                                 */
/* ------------------------------------------------------------------ */

interface SpDisplays {
  SPDisplaysDataType?: {
    _name?: string;
    sppci_model?: string;
    sppci_cores?: string;
    spdisplays_vram?: string;
    spdisplays_vram_shared?: string;
  }[];
}

/** Reads `system_profiler SPDisplaysDataType -json` (macOS). */
export function parseSystemProfiler(json: string): GpuInfo | null {
  let parsed: SpDisplays;
  try {
    parsed = JSON.parse(json) as SpDisplays;
  } catch {
    return null;
  }
  const gpu = parsed.SPDisplaysDataType?.[0];
  if (!gpu) return null;
  const name = gpu.sppci_model ?? gpu._name ?? null;
  const cores = Number(gpu.sppci_cores);
  const vram = parseSizeText(gpu.spdisplays_vram ?? gpu.spdisplays_vram_shared ?? '');
  return {
    name,
    cores: Number.isInteger(cores) && cores > 0 ? cores : null,
    vramBytes: vram,
    source: 'system_profiler',
  };
}

/** `8 GB`, `10240 MiB`, `1536 MB` to bytes; null when there is no number. */
export function parseSizeText(text: string): number | null {
  const m = /([\d.]+)\s*([KMGT]i?B)?/i.exec(text);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? 'MB').toUpperCase().replace('IB', 'B');
  const mult = unit.startsWith('K')
    ? 1024
    : unit.startsWith('M')
      ? 1024 ** 2
      : unit.startsWith('G')
        ? 1024 ** 3
        : unit.startsWith('T')
          ? 1024 ** 4
          : 1;
  return Math.round(n * mult);
}

/** `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` gives `name, MiB`. */
export function parseNvidiaSmi(output: string): GpuInfo | null {
  const line = output.split('\n').find((l) => l.trim().length > 0);
  if (!line) return null;
  const [name, mib] = line.split(',').map((s) => s.trim());
  if (!name) return null;
  const n = Number(mib);
  return {
    name,
    cores: null,
    vramBytes: Number.isFinite(n) && n > 0 ? n * 1024 ** 2 : null,
    source: 'nvidia-smi',
  };
}

/** The first VGA/3D controller line of `lspci`. */
export function parseLspci(output: string): GpuInfo | null {
  const line = output
    .split('\n')
    .find((l) => /VGA compatible controller|3D controller|Display controller/i.test(l));
  if (!line) return null;
  const name = line.replace(/^.*?controller:\s*/i, '').trim();
  return name ? { name, cores: null, vramBytes: null, source: 'lspci' } : null;
}

export async function detectGpu(platform: NodeJS.Platform, exec: Exec, timeoutMs: number): Promise<GpuInfo> {
  const none: GpuInfo = { name: null, cores: null, vramBytes: null, source: null };
  if (platform === 'darwin') {
    const out = await exec('system_profiler', ['SPDisplaysDataType', '-json'], timeoutMs);
    const gpu = out ? parseSystemProfiler(out) : null;
    if (gpu) {
      if (gpu.cores === null) {
        const ioreg = await exec('ioreg', ['-rd1', '-c', 'AGXAccelerator'], timeoutMs);
        const m = /"gpu-core-count"\s*=\s*(\d+)/.exec(ioreg ?? '');
        if (m) gpu.cores = Number(m[1]);
      }
      return gpu;
    }
    return none;
  }
  if (platform === 'linux') {
    const nv = await exec(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      timeoutMs,
    );
    const gpu = nv ? parseNvidiaSmi(nv) : null;
    if (gpu) return gpu;
    const pci = await exec('lspci', [], timeoutMs);
    return (pci ? parseLspci(pci) : null) ?? none;
  }
  if (platform === 'win32') {
    const nv = await exec(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      timeoutMs,
    );
    const gpu = nv ? parseNvidiaSmi(nv) : null;
    if (gpu) return gpu;
    const ps = await exec(
      'powershell',
      ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController | Select-Object -First 1).Name'],
      timeoutMs,
    );
    const name = ps?.trim();
    return name ? { name, cores: null, vramBytes: null, source: 'powershell' } : none;
  }
  return none;
}

/* ------------------------------------------------------------------ */
/* Disk and ffmpeg                                                     */
/* ------------------------------------------------------------------ */

/** Free space on the volume holding `directory`, measured at the nearest folder that exists. */
export async function freeDisk(directory: string): Promise<number | null> {
  let dir = path.resolve(directory);
  for (let i = 0; i < 64; i++) {
    try {
      const st = await fs.statfs(dir);
      return st.bavail * st.bsize;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
  return null;
}

/** Hardware video encoders ffmpeg lists, in the order the planner prefers them. */
export function listedHardwareEncoders(info: FfmpegInfo): string[] {
  const out: string[] = [];
  for (const { hardware } of Object.values(SERVER_VIDEO_ENCODERS)) {
    for (const e of hardware) if (info.encoders.includes(e) && !out.includes(e)) out.push(e);
  }
  return out;
}

/**
 * Which hardware encoders and decoders really work: every listed one is tried on a third of a second
 * of synthetic video (the decoders on an H.264 clip made for the purpose, since ffmpeg falls back to
 * the CPU with only a warning when a method has no device behind it).
 */
export async function detectFfmpegAcceleration(
  info: FfmpegInfo,
  verify: boolean,
  timeoutMs: number,
): Promise<FfmpegAcceleration> {
  const listed = listedHardwareEncoders(info);
  const [hwaccels, results] = await Promise.all([
    detectHwaccels(info.path),
    Promise.all(
      listed.map((e) => (verify ? selfTestEncoder(info.path, e, timeoutMs) : Promise.resolve(true))),
    ),
  ]);
  const encoders = listed.filter((_, i) => results[i] === true);
  const brokenEncoders = listed.filter((_, i) => results[i] !== true);
  const candidates = preferredHwaccels(hwaccels);
  let decoders = candidates;
  let brokenDecoders: string[] = [];
  if (verify && candidates.length > 0) {
    const clip = await makeTestClip(info.path, info.encoders, {
      height: 144,
      fps: 10,
      seconds: 0.3,
      timeoutMs,
    });
    // without an H.264 encoder there is nothing to test with: the list stands, ffmpeg falls back on its own
    if (clip) {
      try {
        const ok = await Promise.all(
          candidates.map((h) => selfTestDecoder(info.path, h, clip.path, timeoutMs)),
        );
        decoders = candidates.filter((_, i) => ok[i] === true);
        brokenDecoders = candidates.filter((_, i) => ok[i] !== true);
      } finally {
        await fs.rm(clip.path, { force: true }).catch(() => undefined);
      }
    }
  }
  return {
    encoders,
    brokenEncoders,
    hwaccels,
    decoders,
    brokenDecoders,
    benchmark: null,
    fastestEncoder: null,
    decodeBenchmark: null,
  };
}

export interface EncoderBenchmark {
  /** Frames per second per candidate; software encoders are keyed by name and run at `veryfast`. */
  results: Record<string, number>;
  /** The H.264 encoder that was fastest, or null when nothing could be measured. */
  fastestEncoder: string | null;
}

export interface DecoderBenchmark {
  /** Frames per second for `software` and each verified hardware decoder; a failed one is left out. */
  results: Record<string, number>;
}

/**
 * Races the CPU decoder against each verified hardware decoder on the same slide-like clip the encoder
 * race uses. The figures are information for the user: decoding follows the hardware switch whatever
 * they say (see buildFfmpegArgs for why the hardware decoder is worth it next to a hardware encoder).
 */
export async function benchmarkDecoders(
  ffmpeg: FfmpegInfo,
  profile: Pick<SystemProfile, 'ffmpeg'>,
  options: { height?: number; seconds?: number; log?: (message: string) => void } = {},
): Promise<DecoderBenchmark> {
  const results: Record<string, number> = {};
  const clip = await makeTestClip(ffmpeg.path, ffmpeg.encoders, {
    height: options.height ?? 1080,
    seconds: options.seconds ?? 6,
  });
  if (!clip) return { results };
  try {
    for (const method of [null, ...(profile.ffmpeg?.decoders ?? [])]) {
      const fps = await benchmarkDecoder(ffmpeg.path, clip, method);
      const key = method ?? 'software';
      if (fps !== null) results[key] = Math.round(fps);
      options.log?.(`decode ${key}: ${fps !== null ? `${Math.round(fps)} fps` : 'failed'}`);
    }
  } finally {
    await fs.rm(clip.path, { force: true }).catch(() => undefined);
  }
  return { results };
}

/** The two races' results, as kept in the data folder between starts. */
export interface RememberedBenchmark {
  /** The ffmpeg the figures are for; another binary or version runs the races again. */
  ffmpeg: { path: string; version: string };
  /** When they were measured. */
  at: string;
  encoders: Record<string, number>;
  fastestEncoder: string | null;
  decoders: Record<string, number>;
}

/** Figures older than this are measured again (a driver or a macOS update can change them). */
export const BENCHMARK_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/** The remembered races for this ffmpeg, or null when there are none, they are for another one, or they are stale. */
export async function readRememberedBenchmark(
  file: string,
  ffmpeg: FfmpegInfo,
): Promise<RememberedBenchmark | null> {
  const isFigures = (v: unknown): v is Record<string, number> =>
    typeof v === 'object' && v !== null && Object.values(v).every((n) => typeof n === 'number');
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as {
      ffmpeg?: { path?: unknown; version?: unknown };
      at?: unknown;
      encoders?: unknown;
      fastestEncoder?: unknown;
      decoders?: unknown;
    };
    if (
      parsed.ffmpeg?.path !== ffmpeg.path ||
      parsed.ffmpeg.version !== ffmpeg.version ||
      typeof parsed.at !== 'string' ||
      !isFigures(parsed.encoders) ||
      !isFigures(parsed.decoders)
    ) {
      return null;
    }
    const age = Date.now() - Date.parse(parsed.at);
    if (!Number.isFinite(age) || age < 0 || age > BENCHMARK_MAX_AGE_MS) return null;
    return {
      ffmpeg: { path: ffmpeg.path, version: ffmpeg.version },
      at: parsed.at,
      encoders: parsed.encoders,
      fastestEncoder: typeof parsed.fastestEncoder === 'string' ? parsed.fastestEncoder : null,
      decoders: parsed.decoders,
    };
  } catch {
    return null;
  }
}

/** Writes the races' results whole and renames them into place. */
export async function rememberBenchmark(file: string, data: RememberedBenchmark): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const partial = `${file}.${process.pid}.tmp`;
  await fs.writeFile(partial, JSON.stringify(data, null, 2));
  await fs.rename(partial, file);
}

/** Puts the races' results into the profile the browser is served. */
export function applyBenchmark(
  profile: SystemProfile,
  data: Pick<RememberedBenchmark, 'encoders' | 'fastestEncoder' | 'decoders'>,
): void {
  if (!profile.ffmpeg) return;
  profile.ffmpeg.benchmark = data.encoders;
  profile.ffmpeg.fastestEncoder = data.fastestEncoder;
  profile.ffmpeg.decodeBenchmark = data.decoders;
}

/** The races' figures in one line, or null when they have not run. */
export function formatRaces(accel: FfmpegAcceleration): string | null {
  const parts: string[] = [];
  if (accel.benchmark && Object.keys(accel.benchmark).length > 0) {
    parts.push(
      `encode ${Object.entries(accel.benchmark)
        .map(([e, fps]) => `${e} ${fps} fps`)
        .join(', ')}`,
    );
  }
  if (accel.decodeBenchmark && Object.keys(accel.decodeBenchmark).length > 0) {
    parts.push(
      `decode ${Object.entries(accel.decodeBenchmark)
        .map(([d, fps]) => `${d} ${fps} fps`)
        .join(', ')}`,
    );
  }
  return parts.length ? `races at 1080p on slide-like video: ${parts.join('; ')}` : null;
}

/**
 * Races the H.264 encoders this machine has (the verified hardware ones against `libx264 veryfast`) on a
 * few seconds of slide-like video. About a second per encoder; runs in the background after the server
 * is up, and on demand through the doctor. The winner decides whether the fastest mode ticks "hardware
 * encoder": on an M2 Max x264 won two to one at 1080p because slide video is mostly skipped blocks.
 */
export async function benchmarkEncoders(
  ffmpeg: FfmpegInfo,
  profile: Pick<SystemProfile, 'ffmpeg'>,
  options: { height?: number; seconds?: number; log?: (message: string) => void } = {},
): Promise<EncoderBenchmark> {
  const candidates = (profile.ffmpeg?.encoders ?? []).filter((e) => e.startsWith('h264_'));
  if (ffmpeg.encoders.includes('libx264')) candidates.push('libx264');
  const results: Record<string, number> = {};
  for (const encoder of candidates) {
    const r = await benchmarkEncoder(ffmpeg.path, encoder, {
      height: options.height ?? 1080,
      seconds: options.seconds ?? 6,
      preset: 'veryfast',
    });
    if (r) results[encoder] = Math.round(r.fps);
    options.log?.(`benchmark ${encoder}: ${r ? `${Math.round(r.fps)} fps` : 'failed'}`);
  }
  const fastestEncoder = Object.entries(results).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { results, fastestEncoder };
}

/** A copy of the ffmpeg info without the hardware encoders that failed their self-test. */
export function withoutBrokenEncoders(info: FfmpegInfo, profile: SystemProfile): FfmpegInfo {
  const broken = new Set(profile.ffmpeg?.brokenEncoders ?? []);
  if (broken.size === 0) return info;
  return { ...info, encoders: info.encoders.filter((e) => !broken.has(e)) };
}

/* ------------------------------------------------------------------ */
/* The profile                                                         */
/* ------------------------------------------------------------------ */

export async function detectSystem(options: DetectSystemOptions): Promise<SystemProfile> {
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? defaultExec;
  const timeoutMs = options.timeoutMs ?? 8000;
  const [cpu, memory, gpu, freeBytes, ffmpeg] = await Promise.all([
    detectCpu(platform, exec, timeoutMs),
    detectMemory(platform, exec, timeoutMs),
    detectGpu(platform, exec, timeoutMs),
    freeDisk(options.outputDirectory),
    options.ffmpeg
      ? detectFfmpegAcceleration(options.ffmpeg, options.verify ?? true, timeoutMs)
      : Promise.resolve(null),
  ]);
  const tier = deriveTier({
    cores: cpu.cores,
    totalBytes: memory.totalBytes,
    hardwareEncoders: ffmpeg?.encoders.length ?? 0,
  });
  const partial = {
    platform,
    nodeVersion: process.version,
    cpu,
    memory,
    gpu,
    disk: { path: options.outputDirectory, freeBytes },
    ffmpeg,
    tier,
    maxEncodeJobs: maxEncodeJobsFor(tier, cpu.cores),
  };
  return { ...partial, notes: systemNotes(partial), detectedAt: new Date().toISOString() };
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

export interface ReportOptions {
  /**
   * What is to become of the races when the profile holds no figures yet: the server runs them
   * shortly after start-up (`pending`), was told not to (`off`), or this is the doctor, which runs
   * them only with `--bench` (`doctor`).
   */
  races?: 'pending' | 'off' | 'doctor';
  /** When the figures in the profile were measured, if they were read back from an earlier start. */
  rememberedAt?: string | null;
}

/** The pre-flight report as lines for the console. */
export function formatSystemReport(
  profile: SystemProfile,
  ffmpeg: FfmpegInfo | null,
  options: ReportOptions = {},
): string[] {
  const { cpu, memory, gpu, disk } = profile;
  const lines: string[] = [];
  const cores =
    cpu.performanceCores !== null
      ? `${cpu.cores} cores (${cpu.performanceCores} performance, ${cpu.efficiencyCores ?? 0} efficiency)`
      : `${cpu.cores} cores`;
  lines.push(`CPU      ${cpu.model}, ${cores}, ${cpu.architecture}`);
  lines.push(
    `Memory   ${formatGb(memory.totalBytes)} total${memory.availableBytes !== null ? `, ${formatGb(memory.availableBytes)} available now` : ''}`,
  );
  lines.push(
    `GPU      ${gpu.name ?? 'not identified'}${gpu.cores !== null ? `, ${gpu.cores} cores` : ''}${gpu.vramBytes !== null ? `, ${formatGb(gpu.vramBytes)} VRAM` : gpu.name ? ', shared memory' : ''}`,
  );
  lines.push(
    `Disk     ${disk.freeBytes !== null ? `${formatGb(disk.freeBytes)} free` : 'free space unknown'} in ${disk.path}`,
  );
  if (ffmpeg && profile.ffmpeg) {
    const f = profile.ffmpeg;
    lines.push(`ffmpeg   ${ffmpeg.version} at ${ffmpeg.path}`);
    lines.push(
      `         hardware encoders: ${f.encoders.length ? f.encoders.join(', ') : 'none'}${f.brokenEncoders.length ? ` (failed self-test: ${f.brokenEncoders.join(', ')})` : ''}`,
    );
    const decoding = f.decoders.length
      ? `${f.decoders.join(', ')} (decodes the upload whenever the hardware switch is on; a codec it cannot take falls back to the CPU)`
      : f.brokenDecoders.length
        ? `none: ${f.brokenDecoders.join(', ')} listed but failed a test decode, so the CPU decodes`
        : `none listed by ffmpeg, so the CPU decodes${f.hwaccels.length ? ` (${f.hwaccels.join(', ')} are not video decoders)` : ''}`;
    lines.push(`         hardware decoders: ${decoding}`);
    const races = formatRaces(f);
    const when = options.rememberedAt
      ? ` (measured ${new Date(options.rememberedAt).toLocaleDateString()}, kept in the data folder for a week)`
      : '';
    lines.push(
      `         ${
        races
          ? `${races}${when}`
          : options.races === 'off'
            ? 'races: off (--no-benchmark); encoding and decoding follow the hardware switch all the same'
            : options.races === 'doctor'
              ? 'races: not run (npm run bench runs them; the server runs them 3 s after it starts and keeps the figures)'
              : 'races: start 3 s after the server is up (each encoder and decoder on six seconds of 1080p slide-like video, about a second apiece); the figures are printed when they are in and kept for a week'
      }`,
    );
  } else {
    lines.push('ffmpeg   not found (HLS, DASH, compression and faststart MP4 are off)');
  }
  lines.push(`Node     ${profile.nodeVersion}`);
  lines.push(
    `Mode     ${profile.tier}: ${TIER_LABELS[profile.tier]}; up to ${profile.maxEncodeJobs} ffmpeg re-encode${profile.maxEncodeJobs === 1 ? '' : 's'} at a time`,
  );
  for (const note of profile.notes) lines.push(`Note     ${note}`);
  return lines;
}
