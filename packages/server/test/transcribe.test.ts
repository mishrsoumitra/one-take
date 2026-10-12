import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  looksLikeDownload,
  parseCppJson,
  parseOpenaiJson,
  parseProgress,
  TranscriptionManager,
} from '../src/services/transcribe.js';

let tmp: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'one-take-transcribe-'));
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('recogniser output', () => {
  it('reads the progress bars both whispers print', () => {
    expect(parseProgress(' 43%|████▎     | 2868/6728 [00:03<00:04, 927.81frames/s]')).toBeCloseTo(0.43);
    expect(parseProgress('whisper_print_progress_callback: progress =  75%')).toBeCloseTo(0.75);
    expect(parseProgress('100%|██████████| 6728/6728')).toBe(1);
    expect(parseProgress('Detecting language using up to the first 30 seconds.')).toBeNull();
  });

  it('tells a model download from a transcription', () => {
    expect(looksLikeDownload('100%|██████████| 139M/139M [00:12<00:00, 11.4MiB/s]')).toBe(true);
    expect(looksLikeDownload(' 43%|████▎     | 2868/6728 [00:03<00:04, 927.81frames/s]')).toBe(false);
  });

  it("reads openai-whisper's words", () => {
    const json = JSON.stringify({
      text: ' Hello there.',
      language: 'en',
      segments: [
        {
          words: [
            { word: ' Hello', start: 0.5, end: 0.9, probability: 0.9 },
            { word: ' there.', start: 0.9, end: 1.3, probability: 0.8 },
            { word: '  ', start: 1.3, end: 1.3, probability: 0 },
          ],
        },
      ],
    });
    expect(parseOpenaiJson(json)).toEqual({
      words: [
        { text: 'Hello', start: 0.5, end: 0.9 },
        { text: 'there.', start: 0.9, end: 1.3 },
      ],
      language: 'en',
    });
  });

  it("reads whisper.cpp's words and skips its markers", () => {
    const json = JSON.stringify({
      result: { language: 'en' },
      transcription: [
        {
          timestamps: { from: '00:00:00,500', to: '00:00:00,900' },
          offsets: { from: 500, to: 900 },
          text: ' Hello',
        },
        {
          timestamps: { from: '00:00:00,900', to: '00:00:01,300' },
          offsets: { from: 900, to: 1300 },
          text: ' there.',
        },
        {
          timestamps: { from: '00:00:01,300', to: '00:00:02,000' },
          offsets: { from: 1300, to: 2000 },
          text: ' [BLANK_AUDIO]',
        },
      ],
    });
    expect(parseCppJson(json)).toEqual({
      words: [
        { text: 'Hello', start: 0.5, end: 0.9 },
        { text: 'there.', start: 0.9, end: 1.3 },
      ],
      language: 'en',
    });
  });
});

describe('TranscriptionManager', () => {
  it('refuses when there is no recogniser, and knows no jobs', async () => {
    const manager = new TranscriptionManager({ info: null, dataDir: tmp });
    expect(manager.available).toBe(false);
    await expect(
      manager.create(Readable.from([Buffer.from('RIFF')]), { language: 'en', durationSec: 1 }),
    ).rejects.toMatchObject({ code: 'transcription_unavailable' });
    expect(() => manager.get('nope')).toThrow(/Unknown transcription/);
  });

  it('refuses whisper.cpp without a model', async () => {
    const manager = new TranscriptionManager({
      info: {
        engine: 'whisper-cpp',
        path: '/nonexistent/whisper-cli',
        version: null,
        model: '',
        modelReady: false,
        note: 'no model',
      },
      dataDir: tmp,
    });
    await expect(
      manager.create(Readable.from([Buffer.from('RIFF')]), { language: 'en', durationSec: 1 }),
    ).rejects.toMatchObject({ code: 'transcription_unavailable' });
  });

  it('reports a recogniser that cannot start as a failed job and cleans up', async () => {
    const manager = new TranscriptionManager({
      info: {
        engine: 'openai-whisper',
        path: path.join(tmp, 'no-such-whisper'),
        version: null,
        model: 'base.en',
        modelReady: true,
        note: 'test',
      },
      dataDir: tmp,
    });
    const job = await manager.create(Readable.from([Buffer.from('RIFF....WAVE')]), {
      language: 'en',
      durationSec: 2,
    });
    expect(job.state).toBe('running');
    const final = await new Promise<typeof job>((resolve) => {
      const unsubscribe = manager.subscribe(job.id, (e) => {
        if (e.job.state !== 'running') {
          unsubscribe();
          resolve(e.job);
        }
      });
    });
    expect(final.state).toBe('failed');
    expect(final.error).toContain('Could not start');
    const left = (await fs.readdir(path.join(tmp, 'tmp'))).filter((n) => n.includes(job.id));
    expect(left).toEqual([]);
  });
});
