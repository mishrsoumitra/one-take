import { describe, expect, it } from 'vitest';

import {
  alignKeyFrameInterval,
  buildLadder,
  defaultExportRequest,
  planExport,
  type BrowserCapabilities,
  type ExportRequest,
  type ServerCapabilities,
} from '../src/index.js';

const chrome: BrowserCapabilities = {
  videoCodecs: ['avc', 'vp9', 'av1'],
  audioCodecs: ['aac', 'opus'],
  fileSystemAccess: true,
};
const firefoxLike: BrowserCapabilities = {
  videoCodecs: ['avc'],
  audioCodecs: ['opus'],
  fileSystemAccess: false,
};

const serverWithFfmpeg: ServerCapabilities = {
  name: 'one-take-server',
  version: '1.0.0',
  platform: 'darwin',
  homeDirectory: '/Users/me',
  defaultDirectory: '/Users/me/Movies/One Take',
  ffmpeg: {
    path: '/opt/homebrew/bin/ffmpeg',
    version: '8.1',
    encoders: ['libx264', 'libx265', 'libvpx-vp9', 'libsvtav1', 'aac', 'libopus', 'h264_videotoolbox'],
    muxers: ['mp4', 'mov', 'matroska', 'webm', 'hls', 'dash'],
  },
  ffprobePath: '/opt/homebrew/bin/ffprobe',
  shortcuts: [],
};
const serverNoFfmpeg: ServerCapabilities = { ...serverWithFfmpeg, ffmpeg: null, ffprobePath: null };

function req(overrides: Partial<ExportRequest> = {}): ExportRequest {
  return { ...defaultExportRequest('/Users/me/Movies/One Take'), ...overrides };
}

describe('planExport', () => {
  it('writes MP4 as fragments and remuxes to faststart when the server has ffmpeg', () => {
    const plan = planExport(req(), serverWithFfmpeg, chrome);
    expect(plan.blockers).toEqual([]);
    expect(plan.browser.container).toBe('fmp4');
    expect(plan.browser.videoCodec).toBe('avc');
    expect(plan.browser.audioCodec).toBe('aac');
    expect(plan.processing).toMatchObject({
      container: 'mp4',
      video: { mode: 'copy' },
      audio: { mode: 'copy' },
    });
    expect(plan.browser.width).toBe(1920);
    expect(plan.browser.height).toBe(1080);
    expect(plan.browser.mezzanine).toBe(false);
  });

  it('writes MP4 directly when the server has no ffmpeg', () => {
    const plan = planExport(req(), serverNoFfmpeg, chrome);
    expect(plan.blockers).toEqual([]);
    expect(plan.browser.container).toBe('mp4');
    expect(plan.processing).toBeNull();
  });

  it('writes directly in the browser and warns when there is no File System Access API', () => {
    const plan = planExport(req({ destination: { kind: 'browser' } }), null, firefoxLike);
    expect(plan.blockers).toEqual([]);
    expect(plan.browser.container).toBe('mp4');
    expect(plan.browser.audioCodec).toBe('opus');
    expect(plan.warnings.some((w) => w.includes('in memory'))).toBe(true);
  });

  it('blocks HLS without a server', () => {
    const plan = planExport(req({ container: 'hls', destination: { kind: 'browser' } }), null, chrome);
    expect(plan.blockers.length).toBeGreaterThan(0);
  });

  it('blocks HLS and compression when the server has no ffmpeg', () => {
    expect(planExport(req({ container: 'hls' }), serverNoFfmpeg, chrome).blockers.length).toBeGreaterThan(0);
    const c = req();
    c.compression = { ...c.compression, enabled: true };
    expect(planExport(c, serverNoFfmpeg, chrome).blockers.some((b) => b.includes('ffmpeg'))).toBe(true);
  });

  it('packages HLS by copying, with key frames aligned to the segment length', () => {
    const r = req({ container: 'hls' });
    r.video.keyFrameIntervalSec = 3;
    r.streaming.segmentSeconds = 4;
    const plan = planExport(r, serverWithFfmpeg, chrome);
    expect(plan.blockers).toEqual([]);
    expect(plan.browser.container).toBe('fmp4');
    expect(plan.browser.keyFrameIntervalSec).toBe(2);
    expect(plan.processing?.container).toBe('hls');
    expect(plan.processing?.video.mode).toBe('copy');
    expect(plan.final.isDirectory).toBe(true);
  });

  it('re-encodes on the server at a mezzanine quality when compression is on', () => {
    const r = req();
    r.compression = { ...r.compression, enabled: true, codec: 'h265', crf: 28, outputFps: 10, height: 720 };
    const plan = planExport(r, serverWithFfmpeg, chrome);
    expect(plan.blockers).toEqual([]);
    expect(plan.browser.mezzanine).toBe(true);
    expect(plan.browser.videoBitrateKbps).toBeGreaterThan(5000);
    expect(plan.processing?.video).toMatchObject({
      mode: 'encode',
      codec: 'h265',
      crf: 28,
      fps: 10,
      height: 720,
      tune: null,
    });
    expect(plan.processing?.audio).toMatchObject({ mode: 'encode', codec: 'aac' });
  });

  it('keeps the stillimage tune for h264 only', () => {
    const r = req();
    r.compression = { ...r.compression, enabled: true, codec: 'h264', tune: 'stillimage' };
    expect(planExport(r, serverWithFfmpeg, chrome).processing?.video).toMatchObject({ tune: 'stillimage' });
  });

  it('builds an adaptive ladder for DASH', () => {
    const r = req({ container: 'dash' });
    r.streaming.ladder = true;
    const plan = planExport(r, serverWithFfmpeg, chrome);
    expect(plan.blockers).toEqual([]);
    expect(plan.processing?.ladder?.map((x) => x.height)).toEqual([1080, 720, 480, 360]);
    expect(plan.processing?.video.mode).toBe('encode');
  });

  it('encodes WebM directly in a browser with VP9, and transcodes on the server otherwise', () => {
    const direct = planExport(req({ container: 'webm' }), serverWithFfmpeg, chrome);
    expect(direct.blockers).toEqual([]);
    expect(direct.browser).toMatchObject({ container: 'webm', videoCodec: 'vp9', audioCodec: 'opus' });
    expect(direct.processing).toBeNull();

    const transcoded = planExport(req({ container: 'webm' }), serverWithFfmpeg, firefoxLike);
    expect(transcoded.blockers).toEqual([]);
    expect(transcoded.browser.container).toBe('fmp4');
    expect(transcoded.processing?.video).toMatchObject({ mode: 'encode', codec: 'vp9' });
    expect(transcoded.processing?.audio).toMatchObject({ mode: 'encode', codec: 'opus' });

    const blocked = planExport(
      req({ container: 'webm', destination: { kind: 'browser' } }),
      null,
      firefoxLike,
    );
    expect(blocked.blockers.length).toBeGreaterThan(0);
  });

  it('rejects a codec the browser cannot encode', () => {
    const r = req();
    r.video.codec = 'hevc';
    expect(planExport(r, serverNoFfmpeg, chrome).blockers.length).toBeGreaterThan(0);
  });

  it('rounds custom sizes to even numbers', () => {
    const plan = planExport(req({ resolution: { width: 1001, height: 563 } }), serverNoFfmpeg, chrome);
    expect(plan.browser.width).toBe(1000);
    expect(plan.browser.height).toBe(562);
  });

  it('reports a missing server as a blocker', () => {
    expect(planExport(req(), null, chrome).blockers[0]).toContain('server');
  });
});

describe('helpers', () => {
  it('aligns key frame intervals to segments', () => {
    expect(alignKeyFrameInterval(4, 4)).toBe(4);
    expect(alignKeyFrameInterval(10, 4)).toBe(4);
    expect(alignKeyFrameInterval(3, 4)).toBe(2);
    expect(alignKeyFrameInterval(1, 6)).toBe(1);
  });

  it('builds ladders that never exceed the source', () => {
    expect(buildLadder(720).map((r) => r.height)).toEqual([720, 480, 360]);
    expect(buildLadder(300).map((r) => r.height)).toEqual([300]);
  });
});
