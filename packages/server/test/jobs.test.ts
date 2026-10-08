import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import {
  type CreateExportJobRequest,
  type ExportJob,
  type FfmpegInfo,
  type ProcessingSpec,
  type SystemProfile,
} from '@one-take/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { detectFfmpeg } from '../src/services/ffmpeg.js';
import { JobManager } from '../src/services/jobs.js';

let tmp: string;
const ffmpeg: FfmpegInfo | null = await detectFfmpeg(process.env.FFMPEG_PATH ?? null);
let sample: Buffer;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'one-take-jobs-'));
  if (ffmpeg) {
    const src = path.join(tmp, 'sample.mp4');
    execFileSync(ffmpeg.path, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=10',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '3',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '20',
      '-c:a',
      'aac',
      '-ac',
      '1',
      '-movflags',
      '+frag_keyframe+empty_moov+default_base_moof',
      src,
    ]);
    sample = await fs.readFile(src);
  }
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function request(overrides: Partial<CreateExportJobRequest> = {}): CreateExportJobRequest {
  return {
    fileName: 'My lecture',
    directory: tmp,
    overwrite: false,
    upload: {
      container: 'fmp4',
      videoCodec: 'avc',
      audioCodec: 'aac',
      width: 320,
      height: 180,
      fps: 10,
      durationSec: 3,
      estimatedBytes: 1_000_000,
    },
    processing: null,
    ...overrides,
  };
}

/** A machine profile that allows `maxEncodeJobs` re-encodes at once and no hardware decoding. */
function slowSystem(maxEncodeJobs: number): SystemProfile {
  return {
    platform: process.platform,
    nodeVersion: process.version,
    cpu: { model: 'test', cores: 8, performanceCores: null, efficiencyCores: null, architecture: 'x64' },
    memory: { totalBytes: 16 * 1024 ** 3, availableBytes: null },
    gpu: { name: null, cores: null, vramBytes: null, source: null },
    disk: { path: tmp, freeBytes: null },
    ffmpeg: { encoders: [], brokenEncoders: [], hwaccels: [], benchmark: null, fastestEncoder: null },
    tier: 'cpu-fast',
    maxEncodeJobs,
    notes: [],
    detectedAt: new Date().toISOString(),
  };
}

/** A re-encode slow enough to still be running when the next job arrives. */
function slowSpec(): ProcessingSpec {
  return {
    container: 'mp4',
    video: {
      mode: 'encode',
      codec: 'h264',
      crf: 18,
      preset: 'veryslow',
      tune: null,
      fps: 60,
      height: 1080,
      maxBitrateKbps: null,
      keyFrameIntervalSec: 1,
      hardware: false,
    },
    audio: { mode: 'copy' },
    segmentSeconds: 4,
    hlsSegmentType: 'fmp4',
    ladder: null,
  };
}

function waitForEnd(jobs: JobManager, id: string): Promise<ExportJob> {
  return new Promise((resolve) => {
    const unsubscribe = jobs.subscribe(id, (event) => {
      if (event.type === 'job' && ['done', 'failed', 'cancelled'].includes(event.job.state)) {
        unsubscribe();
        resolve(event.job);
      }
    });
  });
}

async function upload(jobs: JobManager, id: string, data: Buffer, chunk = 64 * 1024): Promise<void> {
  const offsets: number[] = [];
  for (let o = 0; o < data.length; o += chunk) offsets.push(o);
  // Out of order plus one duplicate, as retries would do.
  const order = [...offsets].reverse();
  order.push(offsets[0] ?? 0);
  for (const o of order) {
    await jobs.write(id, o, Readable.from([data.subarray(o, Math.min(o + chunk, data.length))]));
  }
}

describe('JobManager', () => {
  it('rejects unwritable folders and unknown jobs', async () => {
    const jobs = new JobManager({ ffmpeg: null });
    await expect(jobs.create(request({ directory: path.join(tmp, 'does-not-exist') }))).rejects.toMatchObject(
      { code: 'directory_not_writable' },
    );
    await expect(jobs.create(request({ directory: 'relative/path' }))).rejects.toMatchObject({ status: 400 });
    expect(() => jobs.get('nope')).toThrow(/Unknown export job/);
  });

  it('refuses processing without ffmpeg', async () => {
    const jobs = new JobManager({ ffmpeg: null });
    await expect(
      jobs.create(
        request({
          processing: {
            container: 'mp4',
            video: { mode: 'copy' },
            audio: { mode: 'copy' },
            segmentSeconds: 4,
            hlsSegmentType: 'fmp4',
            ladder: null,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'ffmpeg_missing' });
  });

  it('stores a direct upload under a unique name', async () => {
    const jobs = new JobManager({ ffmpeg: null });
    const data = Buffer.from('x'.repeat(300_000));
    await fs.writeFile(path.join(tmp, 'My lecture.mp4'), 'already here');
    const job = await jobs.create(request());
    expect(job.fileName).toBe('My lecture (2).mp4');
    await upload(jobs, job.id, data);
    expect(jobs.get(job.id).bytesReceived).toBe(data.length);
    const done = waitForEnd(jobs, job.id);
    await jobs.finish(job.id, data.length);
    const final = await done;
    expect(final.state).toBe('done');
    expect(final.outputs[0]).toMatchObject({ kind: 'file', bytes: data.length });
    expect(await fs.readFile(path.join(tmp, 'My lecture (2).mp4'), 'utf8')).toBe(data.toString());
    expect((await fs.readdir(tmp)).filter((n) => n.includes('uploading'))).toEqual([]);
  });

  it('fails a short upload and cleans up', async () => {
    const jobs = new JobManager({ ffmpeg: null });
    const job = await jobs.create(request({ fileName: 'short' }));
    await jobs.write(job.id, 0, Readable.from([Buffer.from('abc')]));
    const done = waitForEnd(jobs, job.id);
    await jobs.finish(job.id, 10);
    expect((await done).state).toBe('failed');
    expect((await fs.readdir(tmp)).filter((n) => n.startsWith('short'))).toEqual([]);
  });

  it('cancels an upload and removes the partial file', async () => {
    const jobs = new JobManager({ ffmpeg: null });
    const job = await jobs.create(request({ fileName: 'cancelled' }));
    await jobs.write(job.id, 0, Readable.from([Buffer.from('abc')]));
    const cancelled = await jobs.cancel(job.id);
    expect(cancelled.state).toBe('cancelled');
    await expect(jobs.write(job.id, 3, Readable.from([Buffer.from('d')]))).rejects.toMatchObject({
      code: 'not_uploading',
    });
    expect((await fs.readdir(tmp)).filter((n) => n.startsWith('cancelled'))).toEqual([]);
  });

  it('refuses to replace a folder with foreign files', async () => {
    const dir = path.join(tmp, 'stream');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'notes.txt'), 'mine');
    const fake: FfmpegInfo = { path: 'ffmpeg', version: '0', encoders: [], muxers: ['hls'] };
    const jobs = new JobManager({ ffmpeg: fake });
    await expect(
      jobs.create(
        request({
          fileName: 'stream',
          overwrite: true,
          processing: {
            container: 'hls',
            video: { mode: 'copy' },
            audio: { mode: 'copy' },
            segmentSeconds: 4,
            hlsSegmentType: 'fmp4',
            ladder: null,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'folder_not_empty' });
  });
});

describe.skipIf(ffmpeg === null)('JobManager with ffmpeg', () => {
  it('remuxes to MP4 and packages HLS and DASH', async () => {
    if (!ffmpeg) return;
    const jobs = new JobManager({ ffmpeg });

    const mp4 = await jobs.create(
      request({
        fileName: 'remux',
        processing: {
          container: 'mp4',
          video: { mode: 'copy' },
          audio: { mode: 'copy' },
          segmentSeconds: 4,
          hlsSegmentType: 'fmp4',
          ladder: null,
        },
      }),
    );
    await upload(jobs, mp4.id, sample);
    const mp4Done = waitForEnd(jobs, mp4.id);
    await jobs.finish(mp4.id, sample.length);
    const mp4Final = await mp4Done;
    expect(mp4Final.state, mp4Final.error ?? '').toBe('done');
    expect(mp4Final.command).toContain('faststart');
    const st = await fs.stat(path.join(tmp, 'remux.mp4'));
    expect(st.size).toBeGreaterThan(1000);

    const hls = await jobs.create(
      request({
        fileName: 'stream-hls',
        processing: {
          container: 'hls',
          video: { mode: 'copy' },
          audio: { mode: 'copy' },
          segmentSeconds: 1,
          hlsSegmentType: 'fmp4',
          ladder: null,
        },
      }),
    );
    await upload(jobs, hls.id, sample);
    const hlsDone = waitForEnd(jobs, hls.id);
    await jobs.finish(hls.id, sample.length);
    const hlsFinal = await hlsDone;
    expect(hlsFinal.state, hlsFinal.error ?? '').toBe('done');
    const files = await fs.readdir(path.join(tmp, 'stream-hls'));
    expect(files).toContain('index.m3u8');
    expect(files).toContain('init.mp4');
    expect(files.filter((f) => f.endsWith('.m4s')).length).toBeGreaterThanOrEqual(2);

    const dash = await jobs.create(
      request({
        fileName: 'stream-dash',
        processing: {
          container: 'dash',
          video: {
            mode: 'encode',
            codec: 'h264',
            crf: 30,
            preset: 'ultrafast',
            tune: 'stillimage',
            fps: 5,
            height: 90,
            maxBitrateKbps: null,
            keyFrameIntervalSec: 1,
            hardware: false,
          },
          audio: { mode: 'encode', codec: 'aac', bitrateKbps: 48 },
          segmentSeconds: 1,
          hlsSegmentType: 'fmp4',
          ladder: null,
        },
      }),
    );
    await upload(jobs, dash.id, sample);
    const dashDone = waitForEnd(jobs, dash.id);
    await jobs.finish(dash.id, sample.length);
    const dashFinal = await dashDone;
    expect(dashFinal.state, dashFinal.error ?? '').toBe('done');
    const dashFiles = await fs.readdir(path.join(tmp, 'stream-dash'));
    expect(dashFiles).toContain('manifest.mpd');
    expect(dashFiles.some((f) => f.endsWith('.m4s'))).toBe(true);
    expect(
      (await fs.readdir(tmp)).filter((n) => n.includes('.processing') || n.includes('.uploading')),
    ).toEqual([]);
  }, 120_000);

  it('runs only as many re-encodes at once as the machine profile allows', async () => {
    if (!ffmpeg) return;
    const jobs = new JobManager({ ffmpeg, system: slowSystem(1) });
    expect(jobs.maxEncodeJobs).toBe(1);
    expect(new JobManager({ ffmpeg, system: slowSystem(2) }).maxEncodeJobs).toBe(2);
    const first = await jobs.create(request({ fileName: 'first', processing: slowSpec() }));
    const second = await jobs.create(request({ fileName: 'second', processing: slowSpec() }));
    await upload(jobs, first.id, sample);
    await upload(jobs, second.id, sample);
    const waiting = new Promise<string>((resolve) => {
      const unsub = jobs.subscribe(second.id, (e) => {
        if (e.type === 'job' && e.job.progress.message.startsWith('Waiting')) {
          unsub();
          resolve(e.job.progress.message);
        }
      });
    });
    const firstRunning = new Promise<void>((resolve) => {
      const unsub = jobs.subscribe(first.id, (e) => {
        if (e.type === 'job' && e.job.progress.message.startsWith('Compressing')) {
          unsub();
          resolve();
        }
      });
    });
    await jobs.finish(first.id, sample.length);
    await firstRunning;
    await jobs.finish(second.id, sample.length);
    expect(await waiting).toMatch(/Waiting for another export/);
    expect(jobs.get(second.id).command).toContain('libx264');
    await jobs.cancel(second.id);
    await jobs.cancel(first.id);
    await new Promise((r) => setTimeout(r, 300));
    expect((await fs.readdir(tmp)).filter((n) => n.startsWith('first') || n.startsWith('second'))).toEqual(
      [],
    );
  }, 60_000);

  it('cancels a running ffmpeg job', async () => {
    if (!ffmpeg) return;
    const jobs = new JobManager({ ffmpeg });
    const job = await jobs.create(
      request({
        fileName: 'slow',
        processing: {
          container: 'mp4',
          video: {
            mode: 'encode',
            codec: 'h264',
            crf: 18,
            preset: 'veryslow',
            tune: null,
            fps: 60,
            height: 1080,
            maxBitrateKbps: null,
            keyFrameIntervalSec: 1,
            hardware: false,
          },
          audio: { mode: 'copy' },
          segmentSeconds: 4,
          hlsSegmentType: 'fmp4',
          ladder: null,
        },
      }),
    );
    await upload(jobs, job.id, sample);
    const processing = new Promise<void>((resolve) => {
      const unsub = jobs.subscribe(job.id, (e) => {
        if (e.type === 'job' && e.job.state === 'processing') {
          unsub();
          resolve();
        }
      });
    });
    await jobs.finish(job.id, sample.length);
    await processing;
    const cancelled = await jobs.cancel(job.id);
    expect(cancelled.state).toBe('cancelled');
    await new Promise((r) => setTimeout(r, 300));
    expect((await fs.readdir(tmp)).filter((n) => n.startsWith('slow'))).toEqual([]);
  }, 60_000);
});
