/**
 * The speaker arithmetic (cosine, mean vector, the bars, the windows), then the real model through
 * onnxruntime-web on the spoken fixtures against embeddings computed in Python, when the model file
 * is on this machine (`npm run models` fetches it).
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { fbank, subtractMean } from '../src/core/fbank.js';
import {
  cosine,
  embeddingWindows,
  HOP_SEC,
  meanEmbedding,
  SPEAKER_MODEL,
  unit,
  VOICE_MATCH,
  VOICE_OTHER,
  voiceOpinion,
  WINDOW_SEC,
} from '../src/core/speaker.js';

import { reference } from './fbank.test.js';
import { MALE_VOICE_URL, readWav, toFloat, VOICE_URL } from './signals.js';

describe('speaker arithmetic', () => {
  it('measures the cosine between vectors', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosine([3, 4], [6, 8])).toBeCloseTo(1);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  it('scales a vector to length one', () => {
    const u = unit([3, 4]);
    expect(u[0]).toBeCloseTo(0.6);
    expect(u[1]).toBeCloseTo(0.8);
    expect(Array.from(unit([0, 0]))).toEqual([0, 0]);
  });

  it('averages directions, weighted by seconds of speech', () => {
    const mean = meanEmbedding([
      { embedding: [10, 0], seconds: 1 },
      { embedding: [0, 1], seconds: 1 },
    ]);
    expect(mean[0]).toBeCloseTo(Math.SQRT1_2);
    expect(mean[1]).toBeCloseTo(Math.SQRT1_2);
    const leaning = meanEmbedding([
      { embedding: [1, 0], seconds: 3 },
      { embedding: [0, 1], seconds: 1 },
    ]);
    expect(leaning[0]).toBeGreaterThan(leaning[1] ?? 0);
    expect(Math.hypot(leaning[0] ?? 0, leaning[1] ?? 0)).toBeCloseTo(1);
  });

  it('reads the cosine against the two bars', () => {
    expect(voiceOpinion(VOICE_MATCH)).toBe('you');
    expect(voiceOpinion(0.9)).toBe('you');
    expect(voiceOpinion(VOICE_OTHER)).toBe('other');
    expect(voiceOpinion(0)).toBe('other');
    expect(voiceOpinion((VOICE_MATCH + VOICE_OTHER) / 2)).toBe('unsure');
  });

  it('plans windows every hop, reaching back a window, as speech comes in', () => {
    expect(embeddingWindows(0, 1, false)).toEqual([]);
    expect(embeddingWindows(0, HOP_SEC, false)).toEqual([{ from: 0, to: HOP_SEC }]);
    expect(embeddingWindows(0, 5, false)).toEqual([
      { from: 0, to: 2 },
      { from: 0, to: 4 },
    ]);
    expect(embeddingWindows(4, 5, false)).toEqual([]);
    expect(embeddingWindows(4, 6.5, false)).toEqual([{ from: 6 - WINDOW_SEC, to: 6 }]);
  });

  it('embeds the tail on its own at the end, when it is long enough', () => {
    expect(embeddingWindows(4, 7.5, true)).toEqual([
      { from: 2, to: 6 },
      { from: 3.5, to: 7.5 },
    ]);
    expect(embeddingWindows(4, 4.5, true)).toEqual([]);
    expect(embeddingWindows(4, 6, true)).toEqual([{ from: 2, to: 6 }]);
    // a phrase shorter than a hop is embedded whole, unless it is too short to say anything
    expect(embeddingWindows(0, 0.5, true)).toEqual([]);
    expect(embeddingWindows(0, 1.2, true)).toEqual([{ from: 0, to: 1.2 }]);
  });
});

const MODEL_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../public/models',
  SPEAKER_MODEL.name,
);

describe.skipIf(!fs.existsSync(MODEL_PATH))('the speaker model through onnxruntime-web', () => {
  async function session(): Promise<{
    embed: (samples: Float32Array) => Promise<Float32Array>;
  }> {
    const ort = await import('onnxruntime-web');
    ort.env.wasm.numThreads = 1;
    const s = await ort.InferenceSession.create(MODEL_PATH, { executionProviders: ['wasm'] });
    return {
      embed: async (samples) => {
        const feats = subtractMean(fbank(samples));
        const input = new ort.Tensor('float32', feats.data, [1, feats.frames, 80]);
        const out = await s.run({ [SPEAKER_MODEL.input]: input });
        const tensor = out[SPEAKER_MODEL.output];
        if (!tensor) throw new Error('no embedding output');
        return new Float32Array(tensor.data as Float32Array);
      },
    };
  }

  it('gives the same embedding as the Python reference, and tells the two voices apart', async () => {
    const { embed } = await session();
    const woman = toFloat(readWav(VOICE_URL));
    const man = toFloat(readWav(MALE_VOICE_URL));
    const ew = await embed(woman);
    const em = await embed(man);
    expect(ew.length).toBe(SPEAKER_MODEL.dim);
    expect(cosine(ew, reference['voice-16k.wav'].embedding)).toBeGreaterThan(0.995);
    expect(cosine(em, reference['voice-male-16k.wav'].embedding)).toBeGreaterThan(0.995);
    const apart = cosine(ew, em);
    expect(Math.abs(apart - (reference.cosines['woman-man'] ?? 0))).toBeLessThan(0.05);
    expect(voiceOpinion(apart)).toBe('other');
  }, 60_000);

  it('recognises a voice from its windows, and a 2 s crop, against the whole clip', async () => {
    const { embed } = await session();
    const man = toFloat(readWav(MALE_VOICE_URL));
    const whole = await embed(man);
    const seconds = man.length / 16000;
    const windows = embeddingWindows(0, seconds, true);
    expect(windows.length).toBeGreaterThan(1);
    const parts = [];
    for (const w of windows) {
      const slice = man.subarray(Math.round(w.from * 16000), Math.round(w.to * 16000));
      parts.push({ embedding: await embed(slice), seconds: w.to - w.from });
    }
    expect(cosine(meanEmbedding(parts), whole)).toBeGreaterThan(0.9);
    const crop = await embed(man.subarray(16000, 48000));
    expect(voiceOpinion(cosine(crop, whole))).toBe('you');
    // and the woman's voice stays another voice however it is cut
    const woman = toFloat(readWav(VOICE_URL));
    expect(voiceOpinion(cosine(await embed(woman.subarray(0, 32000)), whole))).toBe('other');
  }, 60_000);
});
