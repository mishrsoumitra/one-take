/**
 * The real studio worker, when this machine has it (`npm run studio`): a clip of a voice-like tone
 * under noise goes through the deep clean and comes back as long as it went in and quieter where
 * there was only noise; the voice step keeps a voice by its level and measures a second one. Skipped
 * where the studio is not set up, so a plain checkout is not slowed down by a gigabyte of models.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { detectStudio, StudioWorker } from '../src/services/studio.js';

const DATA_DIR = process.env.ONE_TAKE_DATA_DIR ?? path.join(os.homedir(), '.one-take');
const info = await detectStudio({ dataDir: DATA_DIR, pythonPath: null, staticDir: null });
const have = info.denoise && info.voice && info.python !== null;

/** `seconds` of a voice-like tone with pauses, plus noise at `noise` of full scale, as 16-bit PCM. */
function clip(rate: number, seconds: number, noise: number): Buffer {
  const n = Math.round(rate * seconds);
  const buf = Buffer.alloc(n * 2);
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const speaking = t % 2 < 1.2; // 1.2 s of voice, 0.8 s of pause
    let v = 0;
    if (speaking)
      for (let h = 1; h <= 5; h++)
        v += (0.25 / h) * Math.sin(2 * Math.PI * 140 * h * t * (1 + 0.02 * Math.sin(2 * Math.PI * 3 * t)));
    v += noise * random();
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
  }
  return buf;
}

function rmsDb(buf: Buffer, fromSec: number, toSec: number, rate: number): number {
  let sum = 0;
  let count = 0;
  for (let i = Math.round(fromSec * rate); i < Math.round(toSec * rate) && i * 2 + 1 < buf.length; i++) {
    const v = buf.readInt16LE(i * 2) / 32768;
    sum += v * v;
    count++;
  }
  return 20 * Math.log10(Math.sqrt(sum / Math.max(1, count)) + 1e-9);
}

describe.skipIf(!have)('the studio worker', () => {
  it('cleans a noisy clip and measures a second voice', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'one-take-studio-worker-'));
    const python = info.python ?? '';
    const models = path.join(DATA_DIR, 'studio', 'models');
    const speaker = path.join(models, 'wespeaker_en_voxceleb_resnet34_LM.onnx');
    const worker = new StudioWorker(
      python,
      models,
      (await fs.stat(speaker).catch(() => null)) ? speaker : null,
      () => undefined,
      5000,
    );
    try {
      const rate = 48000;
      const noisy = clip(rate, 6, 0.08);
      const input = path.join(tmp, 'in.pcm');
      const out = path.join(tmp, 'out.pcm');
      await fs.writeFile(input, noisy);
      const progress: number[] = [];
      const done = await worker.request('denoise', { audio: input, rate, out }, (f) => progress.push(f));
      expect(done.samples).toBe(noisy.length / 2);
      const cleaned = await fs.readFile(out);
      expect(cleaned.length).toBe(noisy.length);
      // the pause (1.3 to 1.9 s) loses most of its noise; the voice (0.2 to 1.0 s) keeps its level within a few dB
      expect(rmsDb(cleaned, 1.3, 1.9, rate)).toBeLessThan(rmsDb(noisy, 1.3, 1.9, rate) - 10);
      expect(Math.abs(rmsDb(cleaned, 0.2, 1.0, rate) - rmsDb(noisy, 0.2, 1.0, rate))).toBeLessThan(4);
      const measured = await worker.request(
        'voice',
        { audio: out, rate, out: path.join(tmp, 'voice.pcm'), faces: null, profile: null, measure: true },
        () => undefined,
      );
      expect(measured.method).toBe('energy');
      expect(typeof measured.otherShare).toBe('number');
      expect(typeof measured.otherLevelDb).toBe('number');
    } finally {
      worker.stop();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 180_000);
});
