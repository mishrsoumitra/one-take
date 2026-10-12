#!/usr/bin/env node
/**
 * `npm run doctor`: the pre-flight check on its own. Prints what this computer has, which ffmpeg
 * hardware encoders really work, the mode the server will run in, and which process needs which
 * resource for a one-hour lecture. `--bench` times every candidate encoder on synthetic 1080p video so
 * the choice between GPU and CPU compression rests on a measurement, not a guess.
 *
 *   npm run doctor
 *   npm run doctor -- --bench            (adds about 30 s of encoding)
 *   npm run doctor -- --json             (machine-readable profile)
 */
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  conversionMemoryBytes,
  defaultExportRequest,
  estimateExport,
  estimateResources,
  formatBytes,
  isHardwareEncoder,
  NO_HARDWARE,
  planExport,
  recordingBytesPerSecond,
  type BrowserCapabilities,
  type ExportRequest,
  type FfmpegInfo,
  type ResourceLine,
  type ServerCapabilities,
  type SystemProfile,
} from '@one-take/shared';

import { SERVER_VERSION } from './config.js';
import { defaultRendererMemoryMb, presentationSupport } from './services/convert.js';
import { benchmarkEncoder, detectFfmpeg, type BenchmarkResult } from './services/ffmpeg.js';
import {
  benchmarkEncoders,
  detectSystem,
  formatSystemReport,
  withoutBrokenEncoders,
  type EncoderBenchmark,
} from './services/system.js';

const { values } = parseArgs({
  options: {
    dir: { type: 'string', short: 'd' },
    ffmpeg: { type: 'string' },
    bench: { type: 'boolean' },
    json: { type: 'boolean' },
    height: { type: 'string' },
    'no-self-test': { type: 'boolean' },
  },
  strict: true,
});

const MIN_NODE_MAJOR = 22;
const REFERENCE_HOURS = 1;

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function minutes(seconds: number | null): string {
  if (seconds === null) return '-';
  if (seconds < 90) return `${seconds} s`;
  return `${Math.round(seconds / 60)} min`;
}

/** The export plans worth showing for a one-hour 1080p lecture at 15 fps. */
function referenceLines(
  caps: ServerCapabilities,
  browser: BrowserCapabilities,
): { name: string; lines: ResourceLine[] }[] {
  const durationSec = REFERENCE_HOURS * 3600;
  const slides = { count: 40, width: 2560, height: 1440 };
  const audioBytes = recordingBytesPerSecond(48_000) * durationSec * 0.9;
  const base = defaultExportRequest(caps.defaultDirectory);
  const run = (name: string, overrides: Partial<ExportRequest>) => {
    const request: ExportRequest = { ...base, ...overrides };
    const plan = planExport(request, caps, browser);
    const estimate = estimateExport(plan, durationSec);
    return {
      name,
      lines: estimateResources({ plan, estimate, durationSec, slides, audioBytes, server: caps, browser }),
    };
  };
  const hw = (caps.system?.ffmpeg?.encoders.length ?? 0) > 0;
  const out = [
    run('MP4 (faststart remux)', { container: 'mp4' }),
    run('HLS (packaged by copying)', { container: 'hls' }),
  ];
  if (hw) {
    out.push(
      run('MP4 compressed, hardware encoder', {
        container: 'mp4',
        compression: { ...base.compression, enabled: true, preset: 'veryfast' },
        performance: { mode: 'fastest', hardware: true },
      }),
    );
  }
  out.push(
    run('MP4 compressed, libx264 veryfast (hardware switch off)', {
      container: 'mp4',
      compression: { ...base.compression, enabled: true, preset: 'veryfast' },
      performance: { mode: 'fastest', hardware: false },
    }),
    run('MP4 compressed, libx264 medium (hardware switch off)', {
      container: 'mp4',
      compression: { ...base.compression, enabled: true, preset: 'medium' },
      performance: { mode: 'balanced', hardware: false },
    }),
  );
  return out;
}

/** The start-up race (verified hardware encoders against libx264 veryfast) plus a few for comparison. */
async function bench(
  ffmpeg: FfmpegInfo,
  system: SystemProfile,
  height: number,
): Promise<{ race: EncoderBenchmark; extra: BenchmarkResult[] }> {
  const race = await benchmarkEncoders(ffmpeg, system, {
    height,
    log: (m) => console.info(`  ${m}`),
  });
  const extra: BenchmarkResult[] = [];
  const more: { encoder: string; preset: string }[] = [];
  if (ffmpeg.encoders.includes('libx264')) more.push({ encoder: 'libx264', preset: 'medium' });
  if (ffmpeg.encoders.includes('libx265')) more.push({ encoder: 'libx265', preset: 'veryfast' });
  for (const e of system.ffmpeg?.encoders.filter((x) => x.startsWith('hevc_')) ?? [])
    more.push({ encoder: e, preset: '' });
  for (const c of more) {
    const label = c.preset ? `${c.encoder} ${c.preset}` : c.encoder;
    const r = await benchmarkEncoder(ffmpeg.path, c.encoder, { height, preset: c.preset || undefined });
    console.info(`  benchmark ${label}: ${r ? `${Math.round(r.fps)} fps` : 'failed'}`);
    if (r) extra.push({ ...r, encoder: label });
  }
  return { race, extra };
}

async function main(): Promise<number> {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const directory = path.resolve(
    values.dir ?? process.env.ONE_TAKE_DIR ?? path.join(os.homedir(), 'Movies', 'One Take'),
  );
  const ffmpegFound = await detectFfmpeg(values.ffmpeg ?? process.env.FFMPEG_PATH ?? null);
  const system = await detectSystem({
    ffmpeg: ffmpegFound,
    outputDirectory: directory,
    verify: !(values['no-self-test'] ?? false),
  });
  const ffmpeg = ffmpegFound ? withoutBrokenEncoders(ffmpegFound, system) : null;

  if (values.json) {
    console.info(JSON.stringify({ version: SERVER_VERSION, ffmpeg, system }, null, 2));
    return nodeMajor >= MIN_NODE_MAJOR ? 0 : 1;
  }

  console.info(`One Take ${SERVER_VERSION}: system check\n`);
  for (const line of formatSystemReport(system, ffmpeg)) console.info(`  ${line}`);
  console.info(
    `  Renderer ${(defaultRendererMemoryMb() / 1024).toFixed(1)} GB heap for PowerPoint conversion`,
  );
  if (nodeMajor < MIN_NODE_MAJOR) {
    console.info(`\n  PROBLEM  Node ${MIN_NODE_MAJOR} or newer is required; this is ${process.version}.`);
  }

  // Which process needs what.
  const caps: ServerCapabilities = {
    name: 'one-take-server',
    version: SERVER_VERSION,
    platform: process.platform,
    homeDirectory: os.homedir(),
    defaultDirectory: directory,
    ffmpeg,
    ffprobePath: null,
    shortcuts: [],
    presentations: presentationSupport,
    system,
  };
  const gpuBrowser: BrowserCapabilities = {
    videoCodecs: ['avc', 'hevc', 'vp9', 'av1'],
    audioCodecs: ['aac', 'opus'],
    fileSystemAccess: true,
    hardware: { ...NO_HARDWARE, avc: 2160, hevc: 2160 },
    software: { avc: true, hevc: false, vp9: true, av1: true },
    benchmark: null,
    hardwareConcurrency: system.cpu.cores,
    deviceMemoryGb: null,
    gpu: system.gpu.name,
    browser: 'Chrome (assumed)',
  };
  const cpuBrowser: BrowserCapabilities = { ...gpuBrowser, hardware: { ...NO_HARDWARE } };

  console.info(
    `\n  What needs what, for a ${REFERENCE_HOURS} h lecture at 1080p, 15 fps, 40 slides (rough figures):\n`,
  );
  const row = (process: string, unit: string, memory: string, time: string, detail: string) =>
    console.info(`    ${pad(process, 20)} ${pad(unit, 6)} ${pad(memory, 9)} ${pad(time, 8)} ${detail}`);
  console.info('  Always:');
  row(
    'Recording',
    'CPU',
    formatBytes(recordingBytesPerSecond(48_000) * 3600),
    'live',
    'browser; 10 ms blocks, light; this much per hour of speech in RAM and IndexedDB',
  );
  row(
    'Slide rendering',
    'CPU',
    '300 MB',
    '0.3 s/pg',
    'browser (pdf.js worker), one page at a time, up to 2560×1440 each',
  );
  row(
    'PowerPoint to PDF',
    'CPU',
    formatBytes(conversionMemoryBytes(50 * 1024 ** 2)),
    '1 s/slide',
    'server worker thread, one core; figures for a 50 MB deck',
  );
  for (const [label, browser] of [
    ['browser with a GPU H.264 encoder (Chrome, Edge on most machines)', gpuBrowser],
    ['browser without a GPU encoder', cpuBrowser],
  ] as const) {
    console.info(`\n  Exports, ${label}:`);
    for (const { name, lines } of referenceLines(caps, browser)) {
      console.info(`  ${name}`);
      for (const l of lines) {
        row(l.stage, l.unit.toUpperCase(), formatBytes(l.memoryBytes), minutes(l.seconds), l.detail);
      }
    }
  }

  if (values.bench) {
    if (!ffmpeg) {
      console.info('\n  --bench needs ffmpeg.');
    } else {
      const height = Number(values.height ?? 1080);
      console.info(
        `\n  Encoder race, ${height}p slide-like video, 6 s at 30 fps, start-up included (the server runs the same race after it starts):\n`,
      );
      const { race } = await bench(ffmpeg, system, height);
      if (race.fastestEncoder) {
        const hardware = isHardwareEncoder(race.fastestEncoder);
        console.info(
          `\n  Fastest H.264 encoder here: ${race.fastestEncoder} at ${race.results[race.fastestEncoder] ?? 0} fps (${((race.results[race.fastestEncoder] ?? 0) / 15).toFixed(0)}× real time at 15 fps). ${
            hardware
              ? 'The hardware encoder is used by default.'
              : 'The hardware encoder is still used by default, because it leaves the CPU free; untick "Use the hardware encoder" in the export dialog to use the faster software encoder instead.'
          }`,
        );
      } else {
        console.info('\n  No encoder could be measured.');
      }
    }
  }
  console.info('');
  return nodeMajor >= MIN_NODE_MAJOR ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
