import { describe, expect, it } from 'vitest';

import {
  applyPerformanceMode,
  browserCanEncode,
  browserTuning,
  codecPreference,
  defaultExportRequest,
  normalizeExportRequest,
  planExport,
  serverUsesHardware,
  softwareBeatsHardware,
  type BrowserCapabilities,
  type PerformanceSettings,
  type ServerCapabilities,
  type SystemProfile,
} from '../src/index.js';

const browser = (
  hardware: Partial<BrowserCapabilities['hardware']>,
  software: Partial<BrowserCapabilities['software']> = {},
): BrowserCapabilities => ({
  videoCodecs: ['avc', 'hevc', 'vp9', 'av1'],
  audioCodecs: ['aac', 'opus'],
  fileSystemAccess: true,
  hardware: { avc: 0, hevc: 0, vp9: 0, av1: 0, ...hardware },
  // Chrome: software H.264, VP9 and AV1; HEVC only through the hardware
  software: { avc: true, hevc: false, vp9: true, av1: true, ...software },
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
  ffmpeg: {
    encoders,
    brokenEncoders: [],
    hwaccels: [],
    decoders: [],
    brokenDecoders: [],
    benchmark: null,
    fastestEncoder: null,
    decodeBenchmark: null,
  },
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
  transcription: null,
});

const on: PerformanceSettings = { mode: 'fastest', hardware: true };
const off: PerformanceSettings = { mode: 'fastest', hardware: false };

describe('codecPreference', () => {
  it('moves hardware-encodable codecs first while the switch is on, in every mode', () => {
    const b = browser({ hevc: 2160 });
    for (const mode of ['fastest', 'balanced', 'quality'] as const) {
      expect(codecPreference(['avc', 'hevc', 'av1', 'vp9'], { mode, hardware: true }, b, 1080)).toEqual([
        'hevc',
        'avc',
        'av1',
        'vp9',
      ]);
    }
    expect(codecPreference(['avc', 'hevc', 'av1', 'vp9'], off, b, 1080)).toEqual([
      'avc',
      'hevc',
      'av1',
      'vp9',
    ]);
  });

  it('respects the probed size limit', () => {
    const b = browser({ hevc: 1080, avc: 2160 });
    expect(codecPreference(['avc', 'hevc'], on, b, 2160)).toEqual(['avc', 'hevc']);
    expect(codecPreference(['hevc', 'avc'], on, b, 1080)).toEqual(['hevc', 'avc']);
  });
});

describe('browserCanEncode', () => {
  it('needs a software encoder once the switch is off', () => {
    const b = browser({ avc: 2160, hevc: 2160 });
    expect(browserCanEncode(b, 'hevc', 1080, on)).toBe(true);
    expect(browserCanEncode(b, 'hevc', 1080, off)).toBe(false);
    expect(browserCanEncode(b, 'avc', 1080, off)).toBe(true);
    // a codec the browser only ever encodes in software is fine either way
    expect(browserCanEncode(b, 'vp9', 1080, off)).toBe(true);
    expect(browserCanEncode(b, 'vp9', 1080, on)).toBe(true);
  });
});

describe('browserTuning', () => {
  it('asks for the hardware encoder whenever the switch is on and the probe allows it', () => {
    for (const mode of ['fastest', 'balanced', 'quality'] as const) {
      expect(browserTuning({ mode, hardware: true }, 'avc', 1080, browser({ avc: 2160 }))).toEqual({
        hardwareAcceleration: 'prefer-hardware',
        latencyMode: 'quality',
        hardware: true,
        measuredFps: null,
      });
    }
  });

  it('falls back to the CPU, in realtime mode when fastest, when the GPU cannot take the codec', () => {
    expect(browserTuning(on, 'vp9', 1080, browser({ avc: 2160 }))).toEqual({
      hardwareAcceleration: 'no-preference',
      latencyMode: 'realtime',
      hardware: false,
      measuredFps: null,
    });
    expect(
      browserTuning({ mode: 'balanced', hardware: true }, 'vp9', 1080, browser({ avc: 2160 })),
    ).toMatchObject({
      hardwareAcceleration: 'no-preference',
      latencyMode: 'quality',
    });
  });

  it('never requests prefer-hardware above the probed size', () => {
    expect(browserTuning(on, 'avc', 2160, browser({ avc: 1080 })).hardwareAcceleration).toBe('no-preference');
  });

  it('asks for the software encoder when the user turned the switch off', () => {
    const b = browser({ avc: 2160, hevc: 2160 });
    b.benchmark = { avc: { hardwareFps: 390, softwareFps: 700 } };
    expect(browserTuning(off, 'avc', 1080, b)).toEqual({
      hardwareAcceleration: 'prefer-software',
      latencyMode: 'realtime',
      hardware: false,
      measuredFps: 700,
    });
    expect(browserTuning({ mode: 'quality', hardware: false }, 'avc', 1080, b).latencyMode).toBe('quality');
    // a codec without a software encoder cannot be forced onto the CPU; the browser keeps its say
    expect(browserTuning(off, 'hevc', 1080, b).hardwareAcceleration).toBe('no-preference');
  });

  it('carries the measured speed of whichever encoder will run', () => {
    const b = browser({ avc: 2160 });
    b.benchmark = { avc: { hardwareFps: 390, softwareFps: 700 } };
    expect(browserTuning(on, 'avc', 1080, b).measuredFps).toBe(390);
    expect(browserTuning(off, 'avc', 1080, b).measuredFps).toBe(700);
    // the race is reported, not obeyed
    expect(softwareBeatsHardware(b)).toBe(true);
    expect(browserTuning(on, 'avc', 1080, b).hardwareAcceleration).toBe('prefer-hardware');
    b.benchmark = { avc: { hardwareFps: 390, softwareFps: 420 } };
    expect(softwareBeatsHardware(b)).toBe(false);
  });
});

describe('serverUsesHardware', () => {
  it('follows the switch except in the smallest-file mode', () => {
    expect(serverUsesHardware({ mode: 'fastest', hardware: true })).toBe(true);
    expect(serverUsesHardware({ mode: 'balanced', hardware: true })).toBe(true);
    expect(serverUsesHardware({ mode: 'quality', hardware: true })).toBe(false);
    expect(serverUsesHardware({ mode: 'fastest', hardware: false })).toBe(false);
  });
});

describe('applyPerformanceMode', () => {
  it('sets the preset and tune for each mode and leaves the switch alone', () => {
    const r = defaultExportRequest('/out');
    r.compression.tune = 'none';
    applyPerformanceMode(r, 'quality');
    expect(r.performance).toEqual({ mode: 'quality', hardware: true });
    expect(r.compression).toMatchObject({ preset: 'slow', tune: 'stillimage' });
    applyPerformanceMode(r, 'balanced');
    expect(r.compression.preset).toBe('medium');
    r.performance.hardware = false;
    applyPerformanceMode(r, 'fastest');
    expect(r.performance).toEqual({ mode: 'fastest', hardware: false });
    expect(r.compression.preset).toBe('veryfast');
  });
});

describe('normalizeExportRequest', () => {
  it('fills in the performance block for requests saved by older versions', () => {
    const old = defaultExportRequest('/out') as Partial<ReturnType<typeof defaultExportRequest>>;
    delete old.performance;
    const fixed = normalizeExportRequest(old, '/out');
    expect(fixed.performance).toEqual({ mode: 'fastest', hardware: true });
    expect(normalizeExportRequest({ performance: { mode: 'nope' } }, null).performance).toEqual({
      mode: 'fastest',
      hardware: true,
    });
    expect(
      normalizeExportRequest({ performance: { mode: 'quality', hardware: false } }, null).performance,
    ).toEqual({ mode: 'quality', hardware: false });
    expect(normalizeExportRequest(undefined, null).destination).toEqual({ kind: 'browser' });
  });

  it('drops the per-export hardware tick older projects kept under compression', () => {
    const stored = { compression: { enabled: true, hardware: true, preset: 'slow' } };
    const fixed = normalizeExportRequest(stored, null);
    expect(fixed.compression).toMatchObject({ enabled: true, preset: 'slow' });
    expect('hardware' in fixed.compression).toBe(false);
  });
});

describe('planExport with the hardware switch', () => {
  it('prefers the codec the GPU can encode for auto and asks for the hardware encoder', () => {
    const r = defaultExportRequest('/out');
    const plan = planExport(r, server(['hevc_videotoolbox']), browser({ hevc: 2160 }));
    expect(plan.browser.videoCodec).toBe('hevc');
    expect(plan.browser).toMatchObject({
      hardwareAcceleration: 'prefer-hardware',
      latencyMode: 'quality',
      hardware: true,
    });
  });

  it('keeps to codecs with a software encoder once the switch is off', () => {
    const r = defaultExportRequest('/out');
    r.performance.hardware = false;
    const plan = planExport(r, server(['hevc_videotoolbox']), browser({ hevc: 2160, avc: 2160 }));
    expect(plan.browser.videoCodec).toBe('avc');
    expect(plan.browser).toMatchObject({ hardwareAcceleration: 'prefer-software', hardware: false });
    // HEVC asked for by name: with ffmpeg at hand the server transcodes to it on the CPU
    r.video.codec = 'hevc';
    const transcoded = planExport(r, server(['hevc_videotoolbox']), browser({ hevc: 2160, avc: 2160 }));
    expect(transcoded.blockers).toEqual([]);
    expect(transcoded.browser.videoCodec).toBe('avc');
    expect(transcoded.processing?.video).toMatchObject({ mode: 'encode', codec: 'h265', hardware: false });
    expect(transcoded.warnings[0]).toContain('transcode');
    // without ffmpeg it cannot be done, and the reason is spelled out
    const blocked = planExport(
      { ...r, destination: { kind: 'browser' } },
      null,
      browser({ hevc: 2160, avc: 2160 }),
    );
    expect(blocked.blockers[0]).toContain('no software encoder');
  });

  it('reports software encoding when the browser has no GPU encoder', () => {
    const r = defaultExportRequest('/out');
    r.performance.mode = 'balanced';
    const plan = planExport(r, server([]), browser({}));
    expect(plan.browser.videoCodec).toBe('avc');
    expect(plan.browser).toMatchObject({ hardwareAcceleration: 'no-preference', hardware: false });
  });

  it('uses realtime mode for software WebM in fastest mode', () => {
    const r = { ...defaultExportRequest('/out'), container: 'webm' as const };
    const plan = planExport(r, server([]), browser({ avc: 2160 }));
    expect(plan.browser.videoCodec).toBe('vp9');
    expect(plan.browser.latencyMode).toBe('realtime');
  });

  it('applies the switch to the mezzanine encode and to ffmpeg', () => {
    const r = defaultExportRequest('/out');
    r.compression.enabled = true;
    const gpu = planExport(r, server(['h264_videotoolbox']), browser({ avc: 2160 }));
    expect(gpu.browser.mezzanine).toBe(true);
    expect(gpu.browser.hardwareAcceleration).toBe('prefer-hardware');
    expect(gpu.processing?.video).toMatchObject({ mode: 'encode', hardware: true });
    expect(gpu.warnings).toEqual([]);

    r.performance.hardware = false;
    const cpu = planExport(r, server(['h264_videotoolbox']), browser({ avc: 2160 }));
    expect(cpu.browser.hardwareAcceleration).toBe('prefer-software');
    expect(cpu.processing?.video).toMatchObject({ mode: 'encode', hardware: false });
  });

  it('keeps ffmpeg on the CPU in the smallest-file mode and says so when no hardware encoder exists', () => {
    const r = defaultExportRequest('/out');
    r.compression.enabled = true;
    applyPerformanceMode(r, 'quality');
    const plan = planExport(r, server(['h264_videotoolbox']), browser({ avc: 2160 }));
    expect(plan.processing?.video).toMatchObject({ mode: 'encode', hardware: false, preset: 'slow' });
    expect(plan.browser.hardwareAcceleration).toBe('prefer-hardware');

    const noGpuServer = planExport(defaultExportRequest('/out'), server([]), browser({ avc: 2160 }));
    expect(noGpuServer.warnings).toEqual([]);
    const compressed = defaultExportRequest('/out');
    compressed.compression.enabled = true;
    expect(planExport(compressed, server([]), browser({ avc: 2160 })).warnings[0]).toContain(
      'no hardware H264 encoder',
    );
  });
});
