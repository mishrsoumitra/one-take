import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type FfmpegInfo } from '@one-take/shared';
import { describe, expect, it } from 'vitest';

import { detectFfmpeg, parseHwaccels } from '../src/services/ffmpeg.js';
import {
  applyBenchmark,
  BENCHMARK_MAX_AGE_MS,
  benchmarkDecoders,
  benchmarkEncoders,
  detectFfmpegAcceleration,
  detectSystem,
  formatSystemReport,
  freeDisk,
  readRememberedBenchmark,
  rememberBenchmark,
  listedHardwareEncoders,
  parseLspci,
  parseMeminfo,
  parseNvidiaSmi,
  parseSizeText,
  parseSystemProfiler,
  parseVmStat,
  withoutBrokenEncoders,
  type Exec,
} from '../src/services/system.js';

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                  3021887.
Pages active:                                1484173.
Pages inactive:                              1398255.
Pages speculative:                             85648.
Pages throttled:                                   0.
`;

describe('parsers', () => {
  it('reads vm_stat and /proc/meminfo', () => {
    expect(parseVmStat(VM_STAT)).toBe((3021887 + 1398255 + 85648) * 16384);
    expect(parseVmStat('garbage')).toBeNull();
    expect(parseMeminfo('MemTotal:       16000000 kB\nMemAvailable:    8000000 kB\n')).toBe(8000000 * 1024);
    expect(parseMeminfo('')).toBeNull();
  });

  it('reads system_profiler for Apple silicon and Intel Macs', () => {
    const apple = JSON.stringify({ SPDisplaysDataType: [{ _name: 'Apple M2 Max', sppci_cores: '38' }] });
    expect(parseSystemProfiler(apple)).toEqual({
      name: 'Apple M2 Max',
      cores: 38,
      vramBytes: null,
      source: 'system_profiler',
    });
    const intel = JSON.stringify({
      SPDisplaysDataType: [
        { _name: 'kHW_AMDRadeonPro5500MItem', sppci_model: 'AMD Radeon Pro 5500M', spdisplays_vram: '8 GB' },
      ],
    });
    expect(parseSystemProfiler(intel)).toEqual({
      name: 'AMD Radeon Pro 5500M',
      cores: null,
      vramBytes: 8 * 1024 ** 3,
      source: 'system_profiler',
    });
    expect(parseSystemProfiler('{')).toBeNull();
    expect(parseSystemProfiler('{}')).toBeNull();
  });

  it('reads nvidia-smi, lspci and size strings', () => {
    expect(parseNvidiaSmi('NVIDIA GeForce RTX 3080, 10240\n')).toEqual({
      name: 'NVIDIA GeForce RTX 3080',
      cores: null,
      vramBytes: 10240 * 1024 ** 2,
      source: 'nvidia-smi',
    });
    expect(parseNvidiaSmi('')).toBeNull();
    expect(
      parseLspci('00:02.0 VGA compatible controller: Intel Corporation UHD Graphics 620 (rev 07)\n'),
    ).toEqual({
      name: 'Intel Corporation UHD Graphics 620 (rev 07)',
      cores: null,
      vramBytes: null,
      source: 'lspci',
    });
    expect(parseLspci('00:1f.0 ISA bridge: Intel')).toBeNull();
    expect(parseSizeText('1536 MB')).toBe(1536 * 1024 ** 2);
    expect(parseSizeText('10240 MiB')).toBe(10240 * 1024 ** 2);
    expect(parseSizeText('')).toBeNull();
  });

  it('reads hwaccels', () => {
    expect(parseHwaccels('Hardware acceleration methods:\nvideotoolbox\n')).toEqual(['videotoolbox']);
    expect(parseHwaccels('Hardware acceleration methods:\ncuda\nvaapi\nqsv\n')).toEqual([
      'cuda',
      'vaapi',
      'qsv',
    ]);
  });
});

const info: FfmpegInfo = {
  path: 'ffmpeg',
  version: '8',
  encoders: ['libx264', 'h264_nvenc', 'hevc_nvenc', 'aac', 'h264_videotoolbox'],
  muxers: ['mp4'],
};

describe('hardware encoders', () => {
  it('lists the hardware encoders ffmpeg has in planner order', () => {
    expect(listedHardwareEncoders(info)).toEqual(['h264_videotoolbox', 'h264_nvenc', 'hevc_nvenc']);
  });

  it('drops encoders that failed their self-test from the capabilities', async () => {
    const profile = await detectSystem({
      ffmpeg: info,
      outputDirectory: os.tmpdir(),
      verify: false,
      platform: 'linux',
      exec: () => Promise.resolve(null),
    });
    const broken = {
      ...profile,
      ffmpeg: {
        ...profile.ffmpeg!,
        encoders: ['h264_nvenc'],
        brokenEncoders: ['hevc_nvenc', 'h264_videotoolbox'],
        decoders: [],
        brokenDecoders: [],
        benchmark: null,
        fastestEncoder: null,
        decodeBenchmark: null,
      },
    };
    expect(withoutBrokenEncoders(info, broken).encoders).toEqual(['libx264', 'h264_nvenc', 'aac']);
    expect(withoutBrokenEncoders(info, profile)).toBe(info);
  });
});

describe('detectSystem', () => {
  it('builds a profile from fake probes without touching ffmpeg', async () => {
    const calls: string[] = [];
    const fakeProbe = (command: string): string | null => {
      calls.push(command);
      if (command === 'sysctl') return 'Apple M9 Ultra\n16\n8\n';
      if (command === 'vm_stat') return VM_STAT;
      if (command === 'system_profiler')
        return JSON.stringify({ SPDisplaysDataType: [{ _name: 'Apple M9 Ultra', sppci_cores: '80' }] });
      if (command === 'ioreg') return '';
      return null;
    };
    const exec: Exec = (command) => Promise.resolve(fakeProbe(command));
    const profile = await detectSystem({
      ffmpeg: null,
      outputDirectory: os.tmpdir(),
      platform: 'darwin',
      exec,
    });
    expect(profile.cpu).toMatchObject({
      model: 'Apple M9 Ultra',
      performanceCores: 16,
      efficiencyCores: 8,
      cores: os.availableParallelism(),
    });
    expect(profile.memory.availableBytes).toBe(parseVmStat(VM_STAT));
    expect(profile.gpu).toMatchObject({ name: 'Apple M9 Ultra', cores: 80 });
    expect(profile.ffmpeg).toBeNull();
    expect(profile.disk.freeBytes).not.toBeNull();
    expect(profile.notes.join('\n')).toMatch(/ffmpeg not found/);
    expect(['gpu', 'cpu-fast', 'cpu', 'constrained']).toContain(profile.tier);
    expect(calls).toContain('system_profiler');
    const report = formatSystemReport(profile, null);
    expect(report.some((l) => l.startsWith('CPU') && l.includes('Apple M9 Ultra'))).toBe(true);
    expect(report.some((l) => l.includes('not found'))).toBe(true);
  });

  it('measures free space at the nearest existing folder', async () => {
    expect(await freeDisk(os.tmpdir())).toBeGreaterThan(0);
    expect(await freeDisk(`${os.tmpdir()}/one-take-does-not-exist/deeper`)).toBeGreaterThan(0);
  });
});

describe('remembered races', () => {
  const ffmpegInfo: FfmpegInfo = { path: '/usr/bin/ffmpeg', version: '9.0', encoders: [], muxers: [] };

  it('keeps the figures for the same ffmpeg for a week and forgets them otherwise', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'one-take-bench-'));
    const file = path.join(dir, 'benchmark.json');
    expect(await readRememberedBenchmark(file, ffmpegInfo)).toBeNull();
    const data = {
      ffmpeg: { path: ffmpegInfo.path, version: ffmpegInfo.version },
      at: new Date().toISOString(),
      encoders: { libx264: 910, h264_videotoolbox: 400 },
      fastestEncoder: 'libx264',
      decoders: { software: 2000, videotoolbox: 300 },
    };
    await rememberBenchmark(file, data);
    expect(await readRememberedBenchmark(file, ffmpegInfo)).toEqual(data);
    expect(await fs.readdir(dir)).toEqual(['benchmark.json']);
    // another ffmpeg: measured again
    expect(await readRememberedBenchmark(file, { ...ffmpegInfo, version: '9.1' })).toBeNull();
    // stale: measured again
    await rememberBenchmark(file, {
      ...data,
      at: new Date(Date.now() - BENCHMARK_MAX_AGE_MS - 1000).toISOString(),
    });
    expect(await readRememberedBenchmark(file, ffmpegInfo)).toBeNull();
    // damaged: measured again
    await fs.writeFile(file, '{not json');
    expect(await readRememberedBenchmark(file, ffmpegInfo)).toBeNull();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('puts the figures into the profile and the report', async () => {
    const profile = await detectSystem({
      ffmpeg: info,
      outputDirectory: os.tmpdir(),
      verify: false,
      platform: 'linux',
      exec: () => Promise.resolve(null),
    });
    expect(profile.ffmpeg?.decodeBenchmark).toBeNull();
    const pending = formatSystemReport(profile, info, { races: 'pending' }).join('\n');
    expect(pending).toMatch(/races: start 3 s after the server is up/);
    expect(pending).not.toMatch(/not run yet/);
    expect(formatSystemReport(profile, info, { races: 'off' }).join('\n')).toMatch(/--no-benchmark/);
    applyBenchmark(profile, {
      encoders: { libx264: 910, h264_nvenc: 400 },
      fastestEncoder: 'libx264',
      decoders: { software: 2000, cuda: 300 },
    });
    expect(profile.ffmpeg?.benchmark).toEqual({ libx264: 910, h264_nvenc: 400 });
    expect(profile.ffmpeg?.decodeBenchmark).toEqual({ software: 2000, cuda: 300 });
    const report = formatSystemReport(profile, info, { rememberedAt: new Date().toISOString() }).join('\n');
    expect(report).toMatch(
      /encode libx264 910 fps, h264_nvenc 400 fps; decode software 2000 fps, cuda 300 fps/,
    );
    expect(report).toMatch(/kept in the data folder for a week/);
    expect(report).toMatch(/hardware decoders: /);
  });
});

const ffmpeg = await detectFfmpeg(process.env.FFMPEG_PATH ?? null);

describe.skipIf(ffmpeg === null)('with the real ffmpeg', () => {
  it('self-tests the hardware decoders it lists and races them against the CPU', async () => {
    if (!ffmpeg) return;
    const accel = await detectFfmpegAcceleration(ffmpeg, true, 20_000);
    expect(accel.decodeBenchmark).toBeNull();
    for (const d of accel.decoders) expect(accel.hwaccels).toContain(d);
    expect(accel.decoders.some((d) => accel.brokenDecoders.includes(d))).toBe(false);
    if (process.platform === 'darwin' && accel.hwaccels.includes('videotoolbox')) {
      expect(accel.decoders).toContain('videotoolbox');
    }
    const result = await benchmarkDecoders(ffmpeg, { ffmpeg: accel }, { height: 360, seconds: 2 });
    if (!ffmpeg.encoders.some((e) => e.startsWith('h264_') || e === 'libx264' || e === 'libopenh264')) {
      expect(result.results).toEqual({});
      return;
    }
    expect(result.results.software).toBeGreaterThan(0);
    for (const d of accel.decoders) expect(result.results[d]).toBeGreaterThan(0);
  }, 90_000);

  it('self-tests the hardware encoders it lists', async () => {
    if (!ffmpeg) return;
    const accel = await detectFfmpegAcceleration(ffmpeg, true, 20_000);
    expect(
      accel.hwaccels.length + accel.encoders.length + accel.brokenEncoders.length,
    ).toBeGreaterThanOrEqual(0);
    for (const e of accel.encoders) expect(ffmpeg.encoders).toContain(e);
    if (process.platform === 'darwin' && ffmpeg.encoders.includes('h264_videotoolbox')) {
      expect(accel.encoders).toContain('h264_videotoolbox');
    }
    expect(accel.benchmark).toBeNull();
    expect(accel.fastestEncoder).toBeNull();
  }, 60_000);

  it('races the H.264 encoders on slide-like video and names a winner', async () => {
    if (!ffmpeg) return;
    const accel = await detectFfmpegAcceleration(ffmpeg, false, 20_000);
    const result = await benchmarkEncoders(ffmpeg, { ffmpeg: accel }, { height: 360, seconds: 2 });
    if (!ffmpeg.encoders.includes('libx264') && accel.encoders.length === 0) {
      expect(result.fastestEncoder).toBeNull();
      return;
    }
    expect(result.fastestEncoder).not.toBeNull();
    for (const fps of Object.values(result.results)) expect(fps).toBeGreaterThan(0);
    expect(Object.keys(result.results)).toContain(result.fastestEncoder ?? '');
  }, 120_000);
});
