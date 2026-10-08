import { describe, expect, it } from 'vitest';

import {
  browserExportMemoryBytes,
  conversionMemoryBytes,
  defaultExportRequest,
  deriveTier,
  describeSystem,
  estimateExport,
  estimateResources,
  maxEncodeJobsFor,
  peakMemoryBytes,
  performanceWarnings,
  planExport,
  systemNotes,
  totalSeconds,
  type BrowserCapabilities,
  type ExportRequest,
  type ResourceInput,
  type ServerCapabilities,
  type SystemProfile,
} from '../src/index.js';

const GB = 1024 ** 3;

function profile(overrides: Partial<SystemProfile> = {}): SystemProfile {
  const base: SystemProfile = {
    platform: 'darwin',
    nodeVersion: 'v24',
    cpu: { model: 'Apple M2 Max', cores: 12, performanceCores: 8, efficiencyCores: 4, architecture: 'arm64' },
    memory: { totalBytes: 96 * GB, availableBytes: 60 * GB },
    gpu: { name: 'Apple M2 Max', cores: 38, vramBytes: null, source: 'system_profiler' },
    disk: { path: '/out', freeBytes: 500 * GB },
    ffmpeg: {
      encoders: ['h264_videotoolbox', 'hevc_videotoolbox'],
      brokenEncoders: [],
      hwaccels: ['videotoolbox'],
      benchmark: null,
      fastestEncoder: null,
    },
    tier: 'gpu',
    maxEncodeJobs: 2,
    notes: [],
    detectedAt: '2026-10-08T00:00:00.000Z',
  };
  return { ...base, ...overrides };
}

function server(system: SystemProfile | null): ServerCapabilities {
  return {
    name: 'one-take-server',
    version: '1',
    platform: 'darwin',
    homeDirectory: '/',
    defaultDirectory: '/out',
    ffmpeg: {
      path: 'ffmpeg',
      version: '8',
      encoders: ['libx264', 'libx265', 'aac', ...(system?.ffmpeg?.encoders ?? [])],
      muxers: ['mp4', 'hls', 'dash', 'webm', 'matroska', 'mov'],
    },
    ffprobePath: null,
    shortcuts: [],
    presentations: { extensions: ['pptx'], renderer: 'test' },
    system,
  };
}

const chrome: BrowserCapabilities = {
  videoCodecs: ['avc', 'hevc', 'vp9', 'av1'],
  audioCodecs: ['aac', 'opus'],
  fileSystemAccess: true,
  hardware: { avc: 2160, hevc: 2160, vp9: 0, av1: 0 },
  benchmark: null,
  hardwareConcurrency: 12,
  deviceMemoryGb: 8,
  gpu: 'Apple M2 Max',
  browser: 'Chrome 141',
};

function input(
  request: ExportRequest,
  caps: ServerCapabilities | null,
  browser = chrome,
  durationSec = 3600,
): ResourceInput {
  const plan = planExport(request, caps, browser);
  return {
    plan,
    estimate: estimateExport(plan, durationSec),
    durationSec,
    slides: { count: 40, width: 2560, height: 1440 },
    audioBytes: 96_000 * durationSec,
    server: caps,
    browser,
  };
}

describe('estimateResources', () => {
  it('describes a plain MP4 export as GPU encode, upload and a light remux', () => {
    const lines = estimateResources(input(defaultExportRequest('/out'), server(profile())));
    expect(lines.map((l) => [l.stage, l.unit])).toEqual([
      ['Browser encodes', 'gpu'],
      ['Server receives', 'disk'],
      ['Server packages', 'light'],
    ]);
    expect(lines[0]?.detail).toContain('AVC hardware encoder');
    expect(totalSeconds(lines)).toBeGreaterThan(60);
    expect(totalSeconds(lines)).toBeLessThan(15 * 60);
  });

  it('charges the CPU when the browser has no GPU encoder and takes longer', () => {
    const cpuBrowser = { ...chrome, hardware: { avc: 0, hevc: 0, vp9: 0, av1: 0 } };
    const gpu = estimateResources(input(defaultExportRequest('/out'), server(profile())));
    const cpu = estimateResources(input(defaultExportRequest('/out'), server(profile()), cpuBrowser));
    expect(cpu[0]?.unit).toBe('cpu');
    expect(cpu[0]?.seconds ?? 0).toBeGreaterThan(gpu[0]?.seconds ?? 0);
  });

  it('shows the server re-encode on the GPU or CPU as asked', () => {
    const r = defaultExportRequest('/out');
    r.compression.enabled = true;
    r.compression.hardware = true;
    const gpu = estimateResources(input(r, server(profile())));
    expect(gpu[2]).toMatchObject({ stage: 'Server re-encodes', unit: 'gpu' });
    expect(gpu[2]?.detail).toContain('h264_videotoolbox');
    r.compression.hardware = false;
    r.compression.preset = 'veryslow';
    const cpu = estimateResources(input(r, server(profile())));
    expect(cpu[2]).toMatchObject({ unit: 'cpu' });
    expect(cpu[2]?.detail).toContain('libx264 veryslow on 12 cores');
    expect(cpu[2]?.seconds ?? 0).toBeGreaterThan(gpu[2]?.seconds ?? 0);
  });

  it('stops after the browser stage for browser-side exports', () => {
    const r = { ...defaultExportRequest(null) };
    const lines = estimateResources(input(r, null));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.diskBytes).toBeGreaterThan(0);
  });

  it('needs more memory at 4K than at 720p', () => {
    const small = input(
      { ...defaultExportRequest('/out'), resolution: { preset: '720p' } },
      server(profile()),
    );
    const big = input(
      { ...defaultExportRequest('/out'), resolution: { preset: '2160p' } },
      server(profile()),
    );
    expect(browserExportMemoryBytes(big.plan, big.slides, big.audioBytes)).toBeGreaterThan(
      browserExportMemoryBytes(small.plan, small.slides, small.audioBytes),
    );
    expect(peakMemoryBytes(estimateResources(big))).toBeGreaterThan(
      peakMemoryBytes(estimateResources(small)),
    );
  });

  it('scales the conversion memory with the deck size', () => {
    expect(conversionMemoryBytes(100 * 1024 ** 2)).toBeGreaterThan(conversionMemoryBytes(10 * 1024 ** 2));
  });
});

describe('performanceWarnings', () => {
  it('warns when a software codec was chosen although the GPU could do H.264', () => {
    const r = { ...defaultExportRequest('/out'), container: 'webm' as const };
    const i = input(r, server(profile()));
    const w = performanceWarnings(i, estimateResources(i));
    expect(w.some((x) => x.includes('VP9 is encoded in software'))).toBe(true);
  });

  it("warns when the export would take most of a small machine's memory", () => {
    const tiny = profile({ memory: { totalBytes: 2 * GB, availableBytes: 1 * GB } });
    const r = { ...defaultExportRequest('/out'), resolution: { preset: '2160p' as const } };
    const i = input(r, server(tiny));
    const w = performanceWarnings(i, estimateResources(i));
    expect(w.some((x) => x.includes('of memory and the machine has'))).toBe(true);
  });

  it('says nothing for a comfortable export', () => {
    const i = input(defaultExportRequest('/out'), server(profile()));
    expect(performanceWarnings(i, estimateResources(i))).toEqual([]);
  });
});

describe('system helpers', () => {
  it('derives tiers from cores, memory and encoders', () => {
    expect(deriveTier({ cores: 12, totalBytes: 96 * GB, hardwareEncoders: 2 })).toBe('gpu');
    expect(deriveTier({ cores: 12, totalBytes: 32 * GB, hardwareEncoders: 0 })).toBe('cpu-fast');
    expect(deriveTier({ cores: 6, totalBytes: 16 * GB, hardwareEncoders: 0 })).toBe('cpu');
    expect(deriveTier({ cores: 2, totalBytes: 16 * GB, hardwareEncoders: 1 })).toBe('constrained');
    expect(deriveTier({ cores: 8, totalBytes: 4 * GB, hardwareEncoders: 1 })).toBe('constrained');
    expect(maxEncodeJobsFor('gpu', 12)).toBe(2);
    expect(maxEncodeJobsFor('gpu', 4)).toBe(1);
    expect(maxEncodeJobsFor('cpu-fast', 16)).toBe(1);
  });

  it('writes notes for small memory, missing ffmpeg and broken encoders', () => {
    const small = profile({
      memory: { totalBytes: 4 * GB, availableBytes: null },
      ffmpeg: null,
      gpu: { name: null, cores: null, vramBytes: null, source: null },
    });
    const notes = systemNotes(small);
    expect(notes.join('\n')).toMatch(/Only 4.0 GB of memory/);
    expect(notes.join('\n')).toMatch(/ffmpeg not found/);
    expect(notes.join('\n')).toMatch(/GPU not identified/);
    const broken = profile({
      ffmpeg: {
        encoders: [],
        brokenEncoders: ['h264_nvenc'],
        hwaccels: [],
        benchmark: null,
        fastestEncoder: null,
      },
    });
    expect(systemNotes(broken).join('\n')).toMatch(/h264_nvenc but it failed/);
    expect(systemNotes(profile())).toEqual([]);
  });

  it('describes the machine in one line', () => {
    const line = describeSystem(profile());
    expect(line).toContain('Apple M2 Max, 12 cores (8 performance + 4 efficiency), 96 GB RAM');
    expect(line).toContain('38 GPU cores');
    expect(line).toContain('h264_videotoolbox');
  });
});
