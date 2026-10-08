import { describe, expect, it } from 'vitest';

import {
  estimateExport,
  evenDimension,
  formatBytes,
  formatDuration,
  planExport,
  defaultExportRequest,
  sanitizeFileName,
  videoBitrateKbps,
} from '../src/index.js';

describe('util', () => {
  it('formats bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1_500_000)).toBe('1.50 MB');
    expect(formatBytes(12_345_678_901)).toBe('12.3 GB');
  });

  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3600 + 125)).toBe('1:02:05');
  });

  it('sanitizes file names', () => {
    expect(sanitizeFileName('My: lecture / part 1?')).toBe('My- lecture - part 1-');
    expect(sanitizeFileName('   ')).toBe('lecture');
    expect(sanitizeFileName('CON')).toBe('lecture');
    expect(sanitizeFileName('..hidden..')).toBe('hidden');
  });

  it('rounds dimensions to even values inside the range', () => {
    expect(evenDimension(1079)).toBe(1078);
    expect(evenDimension(3)).toBe(16);
    expect(evenDimension(100000)).toBe(7680);
  });

  it('scales bitrates with size and frame rate', () => {
    const base = videoBitrateKbps('high', 1920, 1080, 30);
    expect(base).toBe(5000);
    expect(videoBitrateKbps('high', 1280, 720, 30)).toBeLessThan(base);
    expect(videoBitrateKbps('high', 1920, 1080, 60)).toBeGreaterThan(base);
    expect(videoBitrateKbps('low', 640, 360, 1)).toBeGreaterThanOrEqual(150);
  });
});

describe('estimateExport', () => {
  it('counts frames and sizes for a three hour lecture', () => {
    const plan = planExport(defaultExportRequest(null), null, {
      videoCodecs: ['avc'],
      audioCodecs: ['aac'],
      fileSystemAccess: true,
      hardware: { avc: 0, hevc: 0, vp9: 0, av1: 0 },
      benchmark: null,
      hardwareConcurrency: null,
      deviceMemoryGb: null,
      gpu: null,
      browser: null,
    });
    const est = estimateExport(plan, 3 * 3600);
    expect(est.frames).toBe(3 * 3600 * 15 + 4);
    expect(est.uploadBytes).toBeGreaterThan(1e9);
    expect(est.tempBytes).toBe(0);
  });
});
