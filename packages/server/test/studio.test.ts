/**
 * The studio's job bookkeeping with a stand-in worker: uploads are cut into clips, the deep clean
 * goes over the clips that asked for it as one recording and comes back cut into clips, each voice
 * is done from the cleaned audio, results are fetchable as they land, and a cancel keeps what was
 * finished. The real worker (`py/studio.py`) is driven by the end-to-end run when it is installed.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { type StudioInfo, type StudioJob } from '@one-take/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { detectStudio, StudioManager, venvPython } from '../src/services/studio.js';

let tmp: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'one-take-studio-'));
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const READY: StudioInfo = {
  python: '/usr/bin/python3',
  device: 'cpu',
  models: { denoise: true, separate: true, extract: true },
  speaker: true,
  denoise: true,
  voice: true,
  note: 'ready',
};

/** 16-bit PCM whose every sample is `value`. */
function pcm(samples: number, value: number): Buffer {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(value, i * 2);
  return buf;
}

/**
 * A worker that halves every sample for the deep clean and negates it for the voice, reporting
 * progress twice, and records what it was asked.
 */
function fakeWorker(options: { fail?: string; gateFrom?: number } = {}) {
  const calls: { op: string; body: Record<string, unknown> }[] = [];
  let stopped = 0;
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    calls,
    get stopped() {
      return stopped;
    },
    /** Lets the gated requests go on. */
    open: () => open(),
    stop: () => {
      stopped++;
    },
    request: async (op: string, body: Record<string, unknown>, onProgress: (f: number) => void) => {
      calls.push({ op, body });
      // from the `gateFrom`th request on, wait until the test opens the gate
      if (options.gateFrom !== undefined && calls.length > options.gateFrom) await gate;
      if (options.fail && String(body.audio).includes(options.fail)) throw new Error('model said no');
      onProgress(0.5);
      const input = await fs.readFile(String(body.audio));
      const out = Buffer.alloc(input.length);
      for (let i = 0; i < input.length; i += 2) {
        const v = input.readInt16LE(i);
        out.writeInt16LE(op === 'denoise' ? Math.trunc(v / 2) : -v, i);
      }
      onProgress(1);
      if (body.measure === true)
        return {
          event: 'done',
          method: 'profile',
          similarity: [0.9, 0.1],
          overlap: 0.2,
          otherShare: 0.3,
          otherLevelDb: -5,
        };
      await fs.writeFile(String(body.out), out);
      return {
        event: 'done',
        samples: out.length / 2,
        ...(op === 'voice' ? { method: body.faces ? 'faces' : 'profile', similarity: [0.9, 0.1] } : {}),
      };
    },
  };
}

async function finished(manager: StudioManager, id: string): Promise<StudioJob> {
  for (let i = 0; i < 200; i++) {
    const job = manager.get(id);
    if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('the job never finished');
}

describe('StudioManager', () => {
  it('cuts the uploads into clips, cleans them as one recording, keeps each voice from the cleaned audio', async () => {
    const worker = fakeWorker();
    const manager = new StudioManager({ info: READY, dataDir: path.join(tmp, 'a'), staticDir: null, worker });
    const job = await manager.create({
      clips: [
        { id: 'p1', rate: 48000, samples: 100, denoise: true, voice: 'profile', faceBytes: 0 },
        { id: 'p2', rate: 48000, samples: 50, denoise: true, voice: 'off', faceBytes: 0 },
        { id: 'p3', rate: 48000, samples: 80, denoise: false, voice: 'faces', faceBytes: 6 },
      ],
      profile: new Array<number>(256).fill(0.0625),
    });
    expect(job.state).toBe('uploading');
    expect(job.durationSec).toBeCloseTo(230 / 48000);
    expect(job.denoiseSec).toBeCloseTo(150 / 48000);
    expect(job.voiceSec).toBeCloseTo(180 / 48000);
    const audio = Buffer.concat([pcm(100, 1000), pcm(50, 2000), pcm(80, 3000)]);
    await manager.writeAudio(job.id, Readable.from([audio]));
    await manager.writeFaces(job.id, Readable.from([Buffer.from([2, 0, 0, 0, 7, 8])]));
    const events: StudioJob[] = [];
    manager.subscribe(job.id, (e) => events.push(e.job));
    await manager.start(job.id);
    const final = await finished(manager, job.id);
    expect(final.state).toBe('done');
    expect(final.error).toBeNull();
    // one denoise over p1+p2 joined, then two voices, p1 from its cleaned audio and p3 by its faces
    expect(worker.calls.map((c) => c.op)).toEqual(['denoise', 'voice', 'voice']);
    const denoiseIn = await fs.readFile(String(worker.calls[0]?.body.audio)).catch(() => null);
    expect(denoiseIn).toBeNull(); // the joined input is removed once it is cut back into clips
    expect(String(worker.calls[1]?.body.audio)).toContain('clip-0.deep.pcm');
    expect(worker.calls[1]?.body.faces).toBeNull();
    expect(String(worker.calls[2]?.body.audio)).toContain('clip-2.pcm');
    expect(String(worker.calls[2]?.body.faces)).toContain('faces-2.bin');
    expect(Array.isArray(worker.calls[1]?.body.profile)).toBe(true);
    // the results: p1 has deep (halved) and voice (negated halved), p2 deep, p3 voice only
    const results = Object.fromEntries(final.clips.map((c) => [c.id, c]));
    expect(results.p1?.deep).toBe(true);
    expect(results.p1?.voice).toBe(true);
    expect(results.p1?.method).toBe('profile');
    expect(results.p2?.deep).toBe(true);
    expect(results.p2?.voice).toBe(false);
    expect(results.p3?.deep).toBe(false);
    expect(results.p3?.voice).toBe(true);
    expect(results.p3?.method).toBe('faces');
    const deep1 = await fs.readFile(manager.resultPath(job.id, 'p1', 'deep'));
    expect(deep1.length).toBe(200);
    expect(deep1.readInt16LE(0)).toBe(500);
    expect(deep1.readInt16LE(198)).toBe(500);
    const deep2 = await fs.readFile(manager.resultPath(job.id, 'p2', 'deep'));
    expect(deep2.length).toBe(100);
    expect(deep2.readInt16LE(0)).toBe(1000);
    const voice1 = await fs.readFile(manager.resultPath(job.id, 'p1', 'voice'));
    expect(voice1.readInt16LE(0)).toBe(-500);
    const voice3 = await fs.readFile(manager.resultPath(job.id, 'p3', 'voice'));
    expect(voice3.readInt16LE(0)).toBe(-3000);
    expect(() => manager.resultPath(job.id, 'p2', 'voice')).toThrow(/not there/);
    // the faces file was cut out of the upload for p3 alone
    const faces3 = worker.calls[2]?.body.faces;
    await expect(fs.readFile(String(faces3))).rejects.toThrow(); // inputs are removed once the job is done
    // progress went through the stages in order
    const stages = events.map((e) => e.progress.stage);
    expect(stages.indexOf('denoise')).toBeLessThan(stages.indexOf('voice'));
    expect(stages[stages.length - 1]).toBe('done');
  });

  it('refuses uploads that do not add up, and a job that asks for nothing', async () => {
    const manager = new StudioManager({
      info: READY,
      dataDir: path.join(tmp, 'b'),
      staticDir: null,
      worker: fakeWorker(),
    });
    await expect(
      manager.create({
        clips: [{ id: 'x', rate: 48000, samples: 10, denoise: false, voice: 'off', faceBytes: 0 }],
        profile: null,
      }),
    ).rejects.toThrow(/asks for anything/);
    const job = await manager.create({
      clips: [{ id: 'x', rate: 48000, samples: 10, denoise: true, voice: 'off', faceBytes: 0 }],
      profile: null,
    });
    await manager.writeAudio(job.id, Readable.from([pcm(9, 1)]));
    await expect(manager.start(job.id)).rejects.toThrow(/18 bytes/);
  });

  it('refuses what the studio cannot do here', async () => {
    const manager = new StudioManager({
      info: { ...READY, voice: false, models: { ...READY.models, extract: false } },
      dataDir: path.join(tmp, 'c'),
      staticDir: null,
      worker: fakeWorker(),
    });
    await expect(
      manager.create({
        clips: [{ id: 'x', rate: 48000, samples: 10, denoise: false, voice: 'profile', faceBytes: 0 }],
        profile: null,
      }),
    ).rejects.toThrow(/ready|studio/);
    const ok = await manager.create({
      clips: [{ id: 'x', rate: 48000, samples: 10, denoise: true, voice: 'off', faceBytes: 0 }],
      profile: null,
    });
    expect(ok.state).toBe('uploading');
  });

  it('keeps the other clips when one voice fails, and reports the failure on that clip', async () => {
    const worker = fakeWorker({ fail: 'clip-1' });
    const manager = new StudioManager({ info: READY, dataDir: path.join(tmp, 'd'), staticDir: null, worker });
    const job = await manager.create({
      clips: [
        { id: 'a', rate: 16000, samples: 10, denoise: false, voice: 'profile', faceBytes: 0 },
        { id: 'b', rate: 16000, samples: 10, denoise: false, voice: 'profile', faceBytes: 0 },
      ],
      profile: null,
    });
    await manager.writeAudio(job.id, Readable.from([Buffer.concat([pcm(10, 5), pcm(10, 6)])]));
    await manager.start(job.id);
    const final = await finished(manager, job.id);
    expect(final.state).toBe('done');
    expect(final.clips[0]?.voice).toBe(true);
    expect(final.clips[1]?.voice).toBe(false);
    expect(final.clips[1]?.error).toMatch(/model said no/);
  });

  it('measures without writing a result', async () => {
    const worker = fakeWorker();
    const manager = new StudioManager({ info: READY, dataDir: path.join(tmp, 'e'), staticDir: null, worker });
    const job = await manager.create({
      clips: [{ id: 'a', rate: 16000, samples: 10, denoise: false, voice: 'measure', faceBytes: 0 }],
      profile: null,
    });
    await manager.writeAudio(job.id, Readable.from([pcm(10, 5)]));
    await manager.start(job.id);
    const final = await finished(manager, job.id);
    expect(final.clips[0]?.voice).toBe(false);
    expect(final.clips[0]?.otherShare).toBeCloseTo(0.3);
    expect(final.clips[0]?.otherLevelDb).toBeCloseTo(-5);
    expect(worker.calls[0]?.body.measure).toBe(true);
  });

  it('cancels a running job, stopping the worker and keeping what was done', async () => {
    const worker = fakeWorker({ gateFrom: 1 });
    const manager = new StudioManager({ info: READY, dataDir: path.join(tmp, 'f'), staticDir: null, worker });
    const job = await manager.create({
      clips: [
        { id: 'a', rate: 16000, samples: 10, denoise: true, voice: 'profile', faceBytes: 0 },
        { id: 'b', rate: 16000, samples: 10, denoise: false, voice: 'profile', faceBytes: 0 },
      ],
      profile: null,
    });
    await manager.writeAudio(job.id, Readable.from([pcm(20, 5)]));
    await manager.start(job.id);
    // the denoise goes through; the first voice request is held at the gate
    for (let i = 0; i < 200 && worker.calls.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    expect(worker.calls.length).toBe(2);
    const cancelled = await manager.cancel(job.id);
    expect(cancelled.state).toBe('cancelled');
    expect(worker.stopped).toBe(1);
    expect(cancelled.clips[0]?.deep).toBe(true);
    const deep = await fs.readFile(manager.resultPath(job.id, 'a', 'deep'));
    expect(deep.readInt16LE(0)).toBe(2);
    worker.open();
    await new Promise((r) => setTimeout(r, 30));
    expect(manager.get(job.id).state).toBe('cancelled');
    expect(worker.calls.length).toBe(2); // the second voice was never asked for
  });
});

describe('detectStudio', () => {
  it('says the studio is not set up when there is no environment', async () => {
    const info = await detectStudio({ dataDir: path.join(tmp, 'none'), pythonPath: null, staticDir: null });
    expect(info.python).toBeNull();
    expect(info.denoise).toBe(false);
    expect(info.voice).toBe(false);
    expect(info.note).toMatch(/npm run studio/);
    expect(venvPython(path.join(tmp, 'none'))).toContain(path.join('studio', 'venv'));
  });
});
