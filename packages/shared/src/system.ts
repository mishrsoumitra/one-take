/**
 * What the machine running the server can do: CPU, memory, GPU, which ffmpeg hardware encoders really
 * work, and the performance tier that follows from it. The server detects this once at start-up
 * (services/system.ts), prints it, and hands it to the browser through /api/capabilities so the export
 * planner can pick the fastest route on this particular computer.
 */

export interface CpuInfo {
  model: string;
  /** Logical cores the operating system exposes. */
  cores: number;
  /** Performance cores on hybrid CPUs (Apple silicon, recent Intel); null when the split is unknown. */
  performanceCores: number | null;
  efficiencyCores: number | null;
  /** `arm64`, `x64`, ... */
  architecture: string;
}

export interface MemoryInfo {
  totalBytes: number;
  /** Memory the OS could hand out right now (free plus reclaimable cache); null when unknown. */
  availableBytes: number | null;
}

export interface GpuInfo {
  name: string | null;
  cores: number | null;
  /** Dedicated video memory; null for unified-memory machines (Apple silicon) and when unknown. */
  vramBytes: number | null;
  /** Which probe answered (system_profiler, nvidia-smi, lspci, wmic); null when none did. */
  source: string | null;
}

export interface FfmpegAcceleration {
  /** Hardware encoders ffmpeg lists that also passed a short self-test, e.g. `h264_videotoolbox`. */
  encoders: string[];
  /** Listed hardware encoders that failed the self-test (no device, missing driver). */
  brokenEncoders: string[];
  /** Output of `ffmpeg -hwaccels`, for information. Decoding stays in software: a slide video decodes at thousands of frames per second there, and a GPU decoder was measured 20× slower on it. */
  hwaccels: string[];
  /**
   * Frames per second each candidate encoder managed on six seconds of slide-like 1080p video, measured
   * shortly after start-up (`libx264` means its `veryfast` preset). Null until the benchmark has run.
   */
  benchmark: Record<string, number> | null;
  /** The H.264 encoder that won the benchmark; null until it has run. Decides "hardware" in the fastest mode. */
  fastestEncoder: string | null;
}

export const PERFORMANCE_TIERS = ['gpu', 'cpu-fast', 'cpu', 'constrained'] as const;
export type PerformanceTier = (typeof PERFORMANCE_TIERS)[number];

export const TIER_LABELS: Record<PerformanceTier, string> = {
  gpu: 'GPU encoding available',
  'cpu-fast': 'many CPU cores, no hardware encoder',
  cpu: 'CPU encoding',
  constrained: 'small machine: keep resolutions and frame rates low',
};

export interface SystemProfile {
  platform: string;
  nodeVersion: string;
  cpu: CpuInfo;
  memory: MemoryInfo;
  gpu: GpuInfo;
  /** Free space where exports go by default. */
  disk: { path: string; freeBytes: number | null };
  ffmpeg: FfmpegAcceleration | null;
  tier: PerformanceTier;
  /** ffmpeg re-encodes allowed at the same time; more would only share the same cores. */
  maxEncodeJobs: number;
  /** Plain-language findings worth telling the user. */
  notes: string[];
  detectedAt: string;
}

export const GB = 1024 ** 3;

/** The tier is decided by what can encode video and how much room there is to do it. */
export function deriveTier(input: {
  cores: number;
  totalBytes: number;
  hardwareEncoders: number;
}): PerformanceTier {
  if (input.cores < 4 || input.totalBytes < 8 * GB) return 'constrained';
  if (input.hardwareEncoders > 0) return 'gpu';
  if (input.cores >= 8) return 'cpu-fast';
  return 'cpu';
}

/**
 * How many ffmpeg re-encodes to run at once. Software encoders already use every core, so a second
 * job would only slow both down; a hardware encoder leaves the CPU free for one more.
 */
export function maxEncodeJobsFor(tier: PerformanceTier, cores: number): number {
  if (tier === 'gpu') return cores >= 8 ? 2 : 1;
  return 1;
}

/** Findings the user should see, from the raw numbers. */
export function systemNotes(profile: Omit<SystemProfile, 'notes' | 'detectedAt'>): string[] {
  const notes: string[] = [];
  const { cpu, memory, gpu, ffmpeg, disk } = profile;
  if (memory.totalBytes < 8 * GB) {
    notes.push(
      `Only ${formatGb(memory.totalBytes)} of memory: export at 720p or lower, and avoid "Save in browser" for long lectures.`,
    );
  } else if (memory.totalBytes < 16 * GB) {
    notes.push(
      `${formatGb(memory.totalBytes)} of memory: 4K exports and big PowerPoint decks will be tight.`,
    );
  }
  if (cpu.cores < 4) {
    notes.push(`${cpu.cores} CPU cores: software compression will be slow; prefer plain MP4 exports.`);
  }
  if (ffmpeg === null) {
    notes.push(
      'ffmpeg not found: HLS, DASH, compression and faststart MP4 are off. Install ffmpeg to enable them.',
    );
  } else {
    if (ffmpeg.encoders.length === 0) {
      notes.push(
        'No working hardware video encoder in ffmpeg: compression runs on the CPU (libx264/libx265).',
      );
    }
    if (ffmpeg.brokenEncoders.length > 0) {
      notes.push(
        `ffmpeg lists ${ffmpeg.brokenEncoders.join(', ')} but ${ffmpeg.brokenEncoders.length === 1 ? 'it' : 'they'} failed a test encode; ${ffmpeg.brokenEncoders.length === 1 ? 'it is' : 'they are'} not offered.`,
      );
    }
  }
  if (gpu.name === null) notes.push('GPU not identified; hardware encoders are still used when they work.');
  if (disk.freeBytes !== null && disk.freeBytes < 10 * GB) {
    notes.push(`Only ${formatGb(disk.freeBytes)} free in ${disk.path}: long exports may not fit.`);
  }
  return notes;
}

export function formatGb(bytes: number): string {
  const gb = bytes / GB;
  return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
}

/** One line for logs, tooltips and the export dialog. */
export function describeSystem(profile: SystemProfile): string {
  const { cpu, memory, gpu, ffmpeg } = profile;
  const coreText =
    cpu.performanceCores !== null && cpu.efficiencyCores !== null
      ? `${cpu.cores} cores (${cpu.performanceCores} performance + ${cpu.efficiencyCores} efficiency)`
      : `${cpu.cores} cores`;
  const gpuText = gpu.name
    ? `${gpu.name}${gpu.cores !== null ? ` (${gpu.cores} GPU cores)` : ''}${gpu.vramBytes !== null ? `, ${formatGb(gpu.vramBytes)} VRAM` : ''}`
    : 'GPU unknown';
  const encText = ffmpeg
    ? ffmpeg.encoders.length > 0
      ? `hardware encoders ${ffmpeg.encoders.join(', ')}`
      : 'software encoders only'
    : 'no ffmpeg';
  const fastest = ffmpeg?.fastestEncoder
    ? `; fastest for slides at 1080p: ${ffmpeg.fastestEncoder}${ffmpeg.benchmark?.[ffmpeg.fastestEncoder] ? ` (${Math.round(ffmpeg.benchmark[ffmpeg.fastestEncoder] ?? 0)} fps)` : ''}`
    : '';
  return `${cpu.model}, ${coreText}, ${formatGb(memory.totalBytes)} RAM, ${gpuText}; ${encText}${fastest}`;
}
