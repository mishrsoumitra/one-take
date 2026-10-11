/**
 * The voice model for real: Silero VAD through ONNX Runtime's Node build, on a spoken fixture
 * (macOS text-to-speech, 16 kHz) and on signals that are loud but not a voice.
 */
import fs from 'node:fs';

import * as ort from 'onnxruntime-web';
import { beforeAll, describe, expect, it } from 'vitest';

import { resampleLinear, type Samples } from '../src/core/pcm.js';
import { SileroModel } from '../src/core/silero.js';
import {
  Downsampler,
  scoreClip,
  SPEECH_FRAME,
  SPEECH_RATE,
  SpeechScorer,
  type SpeechModel,
} from '../src/core/speech.js';

const MODEL = new URL('../src/audio/silero/silero_vad.onnx', import.meta.url);
const VOICE = new URL('./fixtures/voice-16k.wav', import.meta.url);

/** 16-bit mono PCM out of a RIFF file. */
function readWav(url: URL): Int16Array {
  const buf = fs.readFileSync(url);
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'data') {
      const out = new Int16Array(size / 2);
      for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(at + 8 + i * 2);
      return out;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

function toFloat(pcm: Int16Array): Samples {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = (pcm[i] ?? 0) / 32768;
  return out;
}

function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++)
    out[i] = Math.round(Math.max(-1, Math.min(1, samples[i] ?? 0)) * 32767);
  return out;
}

function tone(hz: number, seconds: number, rate: number, amp = 0.3): Samples {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

function noise(seconds: number, rate: number, amp: number): Samples {
  const out = new Float32Array(Math.round(seconds * rate));
  let seed = 4242;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = ((seed / 0x7fffffff) * 2 - 1) * amp;
  }
  return out;
}

/** Keyboard-like clicks: a 4 ms burst every 300 ms. */
function clicks(seconds: number, rate: number): Samples {
  const out = new Float32Array(Math.round(seconds * rate));
  let seed = 7;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const phase = t % 0.3;
    if (phase < 0.004) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      out[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.6 * Math.exp(-phase * 800);
    }
  }
  return out;
}

function rms(x: Float32Array, from = 0): number {
  let sum = 0;
  for (let i = from; i < x.length; i++) sum += (x[i] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, x.length - from));
}

function mean(x: Float32Array): number {
  return x.reduce((a, b) => a + b, 0) / Math.max(1, x.length);
}

/** Runs the whole signal through a downsampler in blocks of `block` samples, as the mic would. */
function downsampleInBlocks(samples: Float32Array, from: number, to: number, block: number): Float32Array {
  const down = new Downsampler(from, to);
  const pieces: Float32Array[] = [];
  for (let at = 0; at < samples.length; at += block)
    pieces.push(down.process(samples.subarray(at, at + block)));
  const out = new Float32Array(pieces.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of pieces) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('Downsampler', () => {
  it('keeps a voice-band tone and its loudness from 48 kHz to 16 kHz', () => {
    const input = tone(1000, 1, 48000);
    const out = downsampleInBlocks(input, 48000, 16000, 480);
    expect(Math.abs(out.length - 16000)).toBeLessThanOrEqual(2);
    expect(rms(out, 400) / rms(input, 1200)).toBeGreaterThan(0.95);
    expect(rms(out, 400) / rms(input, 1200)).toBeLessThan(1.05);
  });

  it('keeps the count right across blocks of odd lengths and from 44.1 kHz', () => {
    const input = tone(500, 2, 44100);
    const out = downsampleInBlocks(input, 44100, 16000, 441);
    expect(Math.abs(out.length - 32000)).toBeLessThanOrEqual(2);
    expect(rms(out, 400) / rms(input, 1100)).toBeGreaterThan(0.95);
  });

  it('takes out what would fold back into the voice band', () => {
    const input = tone(14000, 1, 48000);
    const out = downsampleInBlocks(input, 48000, 16000, 480);
    expect(rms(out, 400) / rms(input, 1200)).toBeLessThan(0.1);
  });

  it('passes 16 kHz audio through untouched', () => {
    const input = tone(1000, 0.1, 16000);
    expect(new Downsampler(16000, 16000).process(input)).toBe(input);
  });
});

describe('Silero VAD', () => {
  let model: SpeechModel;
  let voice: Int16Array;

  beforeAll(async () => {
    ort.env.logLevel = 'error';
    const session = await ort.InferenceSession.create(fs.readFileSync(MODEL), {
      executionProviders: ['wasm'],
    });
    model = new SileroModel(ort, session);
    voice = readWav(VOICE);
  });

  it('hears the spoken fixture as a voice nearly all the way through', async () => {
    const probs = await scoreClip(model, voice, SPEECH_RATE);
    expect(probs.length).toBe(Math.ceil(voice.length / SPEECH_FRAME));
    expect(mean(probs)).toBeGreaterThan(0.7);
    expect(probs.filter((p) => p >= 0.5).length / probs.length).toBeGreaterThan(0.75);
  });

  it('hears nothing in loud noise, keyboard clicks or silence', async () => {
    for (const signal of [
      noise(3, SPEECH_RATE, 0.05),
      clicks(3, SPEECH_RATE),
      new Float32Array(2 * SPEECH_RATE),
    ]) {
      const probs = await scoreClip(model, toInt16(signal), SPEECH_RATE);
      expect(Math.max(...probs)).toBeLessThan(0.3);
    }
  });

  it('reports progress in seconds up to the clip length', async () => {
    const seen: number[] = [];
    await scoreClip(model, voice, SPEECH_RATE, (sec) => seen.push(sec));
    expect(seen.length).toBeGreaterThan(1);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen[seen.length - 1]).toBeCloseTo(voice.length / SPEECH_RATE, 3);
  });

  it('scores a 48 kHz microphone, block by block, the same as the clip', async () => {
    const mic = resampleLinear(toFloat(voice), SPEECH_RATE, 48000);
    const scorer = new SpeechScorer(model);
    const seen: number[] = [];
    for (let at = 0; at + 480 <= mic.length; at += 480) {
      scorer.push(mic.subarray(at, at + 480), 48000);
      await scorer.settle();
      seen.push(scorer.prob ?? -1);
    }
    expect(scorer.failed).toBe(false);
    expect(Math.abs(scorer.frames - Math.floor(voice.length / SPEECH_FRAME))).toBeLessThanOrEqual(2);
    expect(seen.filter((p) => p >= 0.5).length / seen.length).toBeGreaterThan(0.7);
  });

  it('starts over on reset', async () => {
    const scorer = new SpeechScorer(model);
    scorer.push(toFloat(voice).subarray(0, SPEECH_RATE), SPEECH_RATE);
    await scorer.settle();
    expect(scorer.frames).toBeGreaterThan(20);
    scorer.reset();
    expect(scorer.frames).toBe(0);
    expect(scorer.prob).toBe(0);
  });
});

describe('SpeechScorer when the model breaks', () => {
  it('turns its score off instead of lying', async () => {
    const broken: SpeechModel = {
      stream: () => ({ score: () => Promise.reject(new Error('no wasm')) }),
    };
    const scorer = new SpeechScorer(broken);
    scorer.push(new Float32Array(SPEECH_FRAME), SPEECH_RATE);
    await scorer.settle();
    expect(scorer.prob).toBeNull();
    expect(scorer.failed).toBe(true);
    scorer.push(new Float32Array(SPEECH_FRAME), SPEECH_RATE);
    expect(scorer.prob).toBeNull();
  });
});
