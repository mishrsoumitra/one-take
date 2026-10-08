import { type FfmpegInfo, type ProcessingSpec } from '@one-take/shared';
import { describe, expect, it } from 'vitest';

import {
  buildFfmpegArgs,
  formatCommand,
  parseCapabilityList,
  parseProgressLine,
  type FfmpegInputInfo,
} from '../src/services/ffmpeg.js';

const info: FfmpegInfo = {
  path: 'ffmpeg',
  version: '8.1',
  encoders: ['libx264', 'libx265', 'libvpx-vp9', 'libsvtav1', 'aac', 'libopus', 'h264_videotoolbox'],
  muxers: ['mp4', 'mov', 'matroska', 'webm', 'hls', 'dash'],
};
const input: FfmpegInputInfo = {
  path: '/tmp/in.mp4',
  videoCodec: 'avc',
  audioCodec: 'aac',
  fps: 15,
  height: 1080,
};

function spec(overrides: Partial<ProcessingSpec>): ProcessingSpec {
  return {
    container: 'mp4',
    video: { mode: 'copy' },
    audio: { mode: 'copy' },
    segmentSeconds: 4,
    hlsSegmentType: 'fmp4',
    ladder: null,
    ...overrides,
  };
}

describe('buildFfmpegArgs', () => {
  it('remuxes to faststart MP4', () => {
    const plan = buildFfmpegArgs(spec({}), input, '/out/lecture.tmp.mp4', info);
    expect(plan.cwd).toBe('/out');
    expect(plan.mainFile).toBe('/out/lecture.tmp.mp4');
    expect(plan.args).toEqual([
      '-hide_banner',
      '-nostdin',
      '-y',
      '-loglevel',
      'error',
      '-nostats',
      '-progress',
      'pipe:1',
      '-i',
      '/tmp/in.mp4',
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-c:v',
      'copy',
      '-c:a',
      'copy',
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      'lecture.tmp.mp4',
    ]);
  });

  it('packages HLS by copying with fmp4 segments', () => {
    const plan = buildFfmpegArgs(spec({ container: 'hls' }), input, '/out/lecture.tmp', info);
    expect(plan.cwd).toBe('/out/lecture.tmp');
    expect(plan.mainFile).toBe('/out/lecture.tmp/index.m3u8');
    const a = plan.args.join(' ');
    expect(a).toContain(
      '-f hls -hls_time 4 -hls_playlist_type vod -hls_flags independent_segments -hls_segment_type fmp4 -hls_segment_filename seg_%05d.m4s -hls_fmp4_init_filename init.mp4 index.m3u8',
    );
  });

  it('uses mpegts segments when asked', () => {
    const plan = buildFfmpegArgs(spec({ container: 'hls', hlsSegmentType: 'mpegts' }), input, '/out/x', info);
    expect(plan.args).toContain('mpegts');
    expect(plan.args).toContain('seg_%05d.ts');
    expect(plan.args).not.toContain('-hls_fmp4_init_filename');
  });

  it('refuses mpegts with copied Opus audio', () => {
    expect(() =>
      buildFfmpegArgs(
        spec({ container: 'hls', hlsSegmentType: 'mpegts' }),
        { ...input, audioCodec: 'opus' },
        '/out/x',
        info,
      ),
    ).toThrow(/AAC/);
  });

  it('re-encodes with x265, a new frame rate, scaling and a bitrate cap', () => {
    const plan = buildFfmpegArgs(
      spec({
        video: {
          mode: 'encode',
          codec: 'h265',
          crf: 28,
          preset: 'slow',
          tune: null,
          fps: 10,
          height: 720,
          maxBitrateKbps: 2000,
          keyFrameIntervalSec: 4,
          hardware: false,
        },
        audio: { mode: 'encode', codec: 'aac', bitrateKbps: 96 },
      }),
      input,
      '/out/lecture.tmp.mp4',
      info,
    );
    const a = plan.args.join(' ');
    expect(a).toContain('-vf fps=10,scale=-2:720');
    expect(a).toContain(
      '-c:v libx265 -preset slow -pix_fmt yuv420p -tag:v hvc1 -crf 28 -x265-params keyint=40:min-keyint=40:scenecut=0:vbv-maxrate=2000:vbv-bufsize=4000',
    );
    expect(a).toContain('-c:a aac -b:a 96k');
  });

  it('uses the stillimage tune and GOP for x264', () => {
    const plan = buildFfmpegArgs(
      spec({
        video: {
          mode: 'encode',
          codec: 'h264',
          crf: 23,
          preset: 'medium',
          tune: 'stillimage',
          fps: null,
          height: null,
          maxBitrateKbps: null,
          keyFrameIntervalSec: 2,
          hardware: false,
        },
      }),
      input,
      '/out/l.mp4',
      info,
    );
    const a = plan.args.join(' ');
    expect(a).toContain(
      '-c:v libx264 -preset medium -pix_fmt yuv420p -profile:v high -tune stillimage -crf 23 -g 30 -keyint_min 30 -sc_threshold 0',
    );
    expect(a).not.toContain('-vf');
  });

  it('prefers a hardware encoder when asked and it exists', () => {
    const plan = buildFfmpegArgs(
      spec({
        video: {
          mode: 'encode',
          codec: 'h264',
          crf: 23,
          preset: 'medium',
          tune: null,
          fps: null,
          height: null,
          maxBitrateKbps: null,
          keyFrameIntervalSec: 2,
          hardware: true,
        },
      }),
      input,
      '/out/l.mp4',
      info,
    );
    expect(plan.args).toContain('h264_videotoolbox');
    expect(plan.args.join(' ')).toContain('-q:v 55');
  });

  it('encodes WebM with VP9 and Opus', () => {
    const plan = buildFfmpegArgs(
      spec({
        container: 'webm',
        video: {
          mode: 'encode',
          codec: 'vp9',
          crf: 32,
          preset: 'medium',
          tune: null,
          fps: null,
          height: null,
          maxBitrateKbps: null,
          keyFrameIntervalSec: 4,
          hardware: false,
        },
        audio: { mode: 'encode', codec: 'opus', bitrateKbps: 64 },
      }),
      input,
      '/out/l.webm',
      info,
    );
    const a = plan.args.join(' ');
    expect(a).toContain('-c:v libvpx-vp9');
    expect(a).toContain('-crf 32 -b:v 0');
    expect(a).toContain('-c:a libopus -b:a 64k -ar 48000');
    expect(a).toContain('-f webm l.webm');
  });

  it('builds an adaptive DASH ladder', () => {
    const plan = buildFfmpegArgs(
      spec({
        container: 'dash',
        video: {
          mode: 'encode',
          codec: 'h264',
          crf: 23,
          preset: 'fast',
          tune: 'stillimage',
          fps: null,
          height: null,
          maxBitrateKbps: null,
          keyFrameIntervalSec: 4,
          hardware: false,
        },
        audio: { mode: 'encode', codec: 'aac', bitrateKbps: 96 },
        ladder: [
          { name: '1080p', height: 1080, videoBitrateKbps: 4500, audioBitrateKbps: 128 },
          { name: '720p', height: 720, videoBitrateKbps: 2500, audioBitrateKbps: 96 },
        ],
      }),
      input,
      '/out/l',
      info,
    );
    const a = plan.args.join(' ');
    expect(a).toContain('-filter_complex [0:v]split=2[v0][v1];[v0]scale=-2:1080[o0];[v1]scale=-2:720[o1]');
    expect(a).toContain('-map [o0] -map 0:a:0 -c:v:0 libx264');
    expect(a).toContain('-b:v:0 4500k');
    expect(a).toContain('-c:a:1 aac -b:a:1 96k');
    expect(a).toContain('-f dash -seg_duration 4');
    expect(plan.mainFile).toBe('/out/l/manifest.mpd');
  });

  it('builds an HLS ladder with a master playlist', () => {
    const plan = buildFfmpegArgs(
      spec({
        container: 'hls',
        video: {
          mode: 'encode',
          codec: 'h264',
          crf: 23,
          preset: 'fast',
          tune: null,
          fps: 10,
          height: null,
          maxBitrateKbps: null,
          keyFrameIntervalSec: 4,
          hardware: false,
        },
        audio: { mode: 'encode', codec: 'aac', bitrateKbps: 96 },
        ladder: [{ name: '720p', height: 720, videoBitrateKbps: 2500, audioBitrateKbps: 96 }],
      }),
      input,
      '/out/l',
      info,
    );
    const a = plan.args.join(' ');
    expect(a).toContain('[0:v]fps=10,split=1[v0]');
    expect(a).toContain('-var_stream_map v:0,a:0,name:720p');
    expect(a).toContain('-master_pl_name master.m3u8 %v/index.m3u8');
    expect(plan.mainFile).toBe('/out/l/master.m3u8');
  });

  it('throws when the encoder is missing', () => {
    const noAv1 = { ...info, encoders: ['libx264', 'aac'] };
    expect(() =>
      buildFfmpegArgs(
        spec({
          video: {
            mode: 'encode',
            codec: 'av1',
            crf: 35,
            preset: 'medium',
            tune: null,
            fps: null,
            height: null,
            maxBitrateKbps: null,
            keyFrameIntervalSec: 4,
            hardware: false,
          },
        }),
        input,
        '/out/l.mp4',
        noAv1,
      ),
    ).toThrow(/av1/);
  });
});

describe('parsers', () => {
  it('reads ffmpeg capability lists', () => {
    const out = `Encoders:\n V..... = Video\n ------\n V....D libx264              libx264 H.264\n A....D aac                  AAC (Advanced Audio Coding)\n`;
    expect(parseCapabilityList(out)).toEqual(['libx264', 'aac']);
    const muxers = `Formats:\n D.. = Demuxing supported\n .E. = Muxing supported\n ---\n  E  mp4             MP4 (MPEG-4 Part 14)\n  E  hls             Apple HTTP Live Streaming\n  E  dash            DASH Muxer\n`;
    expect(parseCapabilityList(muxers)).toEqual(['mp4', 'hls', 'dash']);
  });

  it('reads progress lines', () => {
    expect(parseProgressLine('out_time_us=1500000')).toEqual({ outTimeSec: 1.5 });
    expect(parseProgressLine('out_time_ms=1500000')).toEqual({ outTimeSec: 1.5 });
    expect(parseProgressLine('speed=12.3x')).toEqual({ speed: 12.3 });
    expect(parseProgressLine('out_time_us=N/A')).toEqual({});
    expect(parseProgressLine('progress=end')).toEqual({});
  });

  it('formats commands for humans', () => {
    expect(formatCommand('ffmpeg', ['-i', 'my file.mp4', '-c:v', 'copy'])).toBe(
      "ffmpeg -i 'my file.mp4' -c:v copy",
    );
  });
});
