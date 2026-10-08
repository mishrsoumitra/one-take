import { describe, expect, it } from 'vitest';

import {
  applyPerformanceMode,
  browserTuning,
  codecPreference,
  defaultExportRequest,
  normalizeExportRequest,
  planExport,
  softwareBeatsHardware,
  type BrowserCapabilities,
  type ServerCapabilities,
  type SystemProfile,
} from '../src/index.js';

const browser = (hardware: Partial<BrowserCapabilities['hardware']>): BrowserCapabilities => ({
  videoCodecs: ['avc', 'hevc', 'vp9', 'av1'],
  audioCodecs: ['aac', 'opus'],
  fileSystemAccess: true,
  hardware: { avc: 0, hevc: 0, vp9: 0, av1: 0, ...hardware },
  benchmark: null,
  hardwareConcurrency: 8,
  deviceMemoryGb: 8,
  gpu: 'Test GPU',
  browser: 'Chrome 141',
});

const system = (encoders: string[]): SystemProfile => ({
  platform: 'darwin',
  nodeVersion: 'v24',
  cpu: { model: 'Test', cores: 12, performanceCores: 8, efficiencyCores: 4, architecture: 'arm64' },
  memory: { totalBytes: 32 * 1024 ** 3, availableBytes: null },
  gpu: { name: 'Test GPU', cores: null, vramBytes: null, source: null },
  disk: { path: '/tmp', freeBytes: null },
  ffmpeg: { encoders, brokenEncoders: [], hwaccels: [], benchmark: null, fastestEncoder: null },
  tier: encoders.length ? 'gpu' : 'cpu-fast',
  maxEncodeJobs: 1,
  notes: [],
  detectedAt: '2026-10-08T00:00:00.000Z',
});

const server = (encoders: string[]): ServerCapabilities => ({
  name: 'one-take-server',
  version: '1',
  platform: 'darwin',
  homeDirectory: '/',
  defaultDirectory: '/out',
  ffmpeg: {
    path: 'ffmpeg',
    version: '8',
    encoders: ['libx264', 'libx265', 'aac', ...encoders],
    muxers: ['mp4', 'hls', 'dash', 'webm', 'matroska', 'mov'],
  },
  ffprobePath: null,
  shortcuts: [],
  presentations: { extensions: ['pptx'], renderer: 'test' },
  system: system(encoders),
});

describe('codecPreference', () => {
  it('moves hardware-encodable codecs first only in fastest mode', () => {
    const b = browser({ hevc: 2160 });
    expect(codecPreference(['avc', 'hevc', 'av1', 'vp9'], 'fastest', b, 1080)).toEqual([
      'hevc',
      'avc',
      'av1',
      'vp9',
    ]);
    expect(codecPreference(['avc', 'hevc', 'av1', 'vp9'], 'balanced', b, 1080)).toEqual([
      'avc',
      'hevc',
      'av1',
      'vp9',
    ]);
  });

  it('respects the probed size limit', () => {
    const b = browser({ hevc: 1080, avc: 2160 });
    expect(codecPreference(['avc', 'hevc'], 'fastest', b, 2160)).toEqual(['avc', 'hevc']);
    expect(codecPreference(['hevc', 'avc'], 'fastest', b, 1080)).toEqual(['hevc', 'avc']);
  });
});

describe('browserTuning', () => {
  it('asks for the GPU encoder when it works, realtime for software in fastest mode', () => {
    expect(browserTuning('fastest', 'avc', 1080, browser({ avc: 2160 }))).toEqual({
      hardwareAcceleration: 'prefer-hardware',
      latencyMode: 'quality',
      hardware: true,
      measuredFps: null,
    });
    expect(browserTuning('fastest', 'vp9', 1080, browser({ avc: 2160 }))).toEqual({
      hardwareAcceleration: 'no-preference',
      latencyMode: 'realtime',
      hardware: false,
      measuredFps: null,
    });
  });

  it('prefers the software encoder when the start-up test showed it clearly faster', () => {
    const b = browser({ avc: 2160 });
    b.benchmark = { avc: { hardwareFps: 390, softwareFps: 700 } };
    expect(softwareBeatsHardware(b, 'avc')).toBe(true);
    expect(softwareBeatsHardware(b, 'hevc')).toBe(false);
    expect(browserTuning('fastest', 'avc', 1080, b)).toEqual({
      hardwareAcceleration: 'prefer-software',
      latencyMode: 'quality',
      hardware: false,
      measuredFps: 700,
    });
    // within the 15 % margin the GPU keeps the job
    b.benchmark = { avc: { hardwareFps: 390, softwareFps: 420 } };
    expect(browserTuning('fastest', 'avc', 1080, b)).toMatchObject({
      hardwareAcceleration: 'prefer-hardware',
      measuredFps: 390,
    });
    // no GPU encoder at all: software wins by default, with its measured speed
    const noGpu = browser({});
    noGpu.benchmark = { avc: { hardwareFps: null, softwareFps: 250 } };
    expect(browserTuning('fastest', 'avc', 1080, noGpu)).toMatchObject({
      hardwareAcceleration: 'prefer-software',
      measuredFps: 250,
    });
    // other modes never force software
    expect(browserTuning('balanced', 'avc', 1080, b).hardwareAcceleration).toBe('no-preference');
  });

  it('never requests prefer-hardware above the probed size', () => {
    expect(browserTuning('fastest', 'avc', 2160, browser({ avc: 1080 })).hardwareAcceleration).toBe(
      'no-preference',
    );
  });

  it('leaves balanced and quality modes to the browser defaults', () => {
    for (const mode of ['balanced', 'quality'] as const) {
      expect(browserTuning(mode, 'avc', 1080, browser({ avc: 2160 }))).toEqual({
        hardwareAcceleration: 'no-preference',
        latencyMode: 'quality',
        hardware: true,
        measuredFps: null,
      });
    }
  });
});

describe('applyPerformanceMode', () => {
  it('fastest ticks the server GPU encoder only when it won the start-up race', () => {
    const r = defaultExportRequest('/out');
    const gpuWins = server(['h264_videotoolbox']);
    gpuWins.system!.ffmpeg!.benchmark = { h264_videotoolbox: 420, libx264: 300 };
    gpuWins.system!.ffmpeg!.fastestEncoder = 'h264_videotoolbox';
    applyPerformanceMode(r, 'fastest', gpuWins);
    expect(r.performance.mode).toBe('fastest');
    expect(r.compression).toMatchObject({ hardware: true, preset: 'veryfast' });
    const x264Wins = server(['h264_videotoolbox']);
    x264Wins.system!.ffmpeg!.benchmark = { h264_videotoolbox: 400, libx264: 910 };
    x264Wins.system!.ffmpeg!.fastestEncoder = 'libx264';
    applyPerformanceMode(r, 'fastest', x264Wins);
    expect(r.compression.hardware).toBe(false);
    // Before the race has run, and without any GPU encoder, software is the safe default.
    applyPerformanceMode(r, 'fastest', server(['h264_videotoolbox']));
    expect(r.compression.hardware).toBe(false);
    applyPerformanceMode(r, 'fastest', server([]));
    expect(r.compression.hardware).toBe(false);
  });

  it('quality uses slow software presets with the stillimage tune', () => {
    const r = defaultExportRequest('/out');
    r.compression.tune = 'none';
    applyPerformanceMode(r, 'quality', server(['h264_videotoolbox']));
    expect(r.compression).toMatchObject({ hardware: false, preset: 'slow', tune: 'stillimage' });
    applyPerformanceMode(r, 'balanced', null);
    expect(r.compression).toMatchObject({ hardware: false, preset: 'medium' });
  });
});

describe('normalizeExportRequest', () => {
  it('fills in the performance block for requests saved by older versions', () => {
    const old = defaultExportRequest('/out') as Partial<ReturnType<typeof defaultExportRequest>>;
    delete old.performance;
    const fixed = normalizeExportRequest(old, '/out');
    expect(fixed.performance).toEqual({ mode: 'fastest' });
    expect(normalizeExportRequest({ performance: { mode: 'nope' } }, null).performance.mode).toBe('fastest');
    expect(normalizeExportRequest({ performance: { mode: 'quality' } }, null).performance.mode).toBe(
      'quality',
    );
    expect(normalizeExportRequest(undefined, null).destination).toEqual({ kind: 'browser' });
  });
});

describe('planExport with performance modes', () => {
  it('prefers the codec the GPU can encode for auto in fastest mode', () => {
    const r = defaultExportRequest('/out');
    const plan = planExport(r, server(['hevc_videotoolbox']), browser({ hevc: 2160 }));
    expect(plan.browser.videoCodec).toBe('hevc');
    expect(plan.browser).toMatchObject({
      hardwareAcceleration: 'prefer-hardware',
      latencyMode: 'quality',
      hardware: true,
    });
  });

  it('keeps the family order in balanced mode and reports software encoding', () => {
    const r = defaultExportRequest('/out');
    r.performance.mode = 'balanced';
    const plan = planExport(r, server([]), browser({ hevc: 2160 }));
    expect(plan.browser.videoCodec).toBe('avc');
    expect(plan.browser).toMatchObject({ hardwareAcceleration: 'no-preference', hardware: false });
  });

  it('uses realtime mode for software WebM in fastest mode', () => {
    const r = { ...defaultExportRequest('/out'), container: 'webm' as const };
    const plan = planExport(r, server([]), browser({ avc: 2160 }));
    expect(plan.browser.videoCodec).toBe('vp9');
    expect(plan.browser.latencyMode).toBe('realtime');
  });

  it('applies the tuning to the mezzanine encode too', () => {
    const r = defaultExportRequest('/out');
    r.compression.enabled = true;
    const plan = planExport(r, server(['h264_videotoolbox']), browser({ avc: 2160 }));
    expect(plan.browser.mezzanine).toBe(true);
    expect(plan.browser.hardwareAcceleration).toBe('prefer-hardware');
  });
});
