/**
 * The plumbing around the voice detector: the downsampler, the microphone scorer (48 kHz blocks)
 * and the clip scorer, on the spoken fixture.
 */
import { describe, expect, it } from 'vitest';

import { resampleLinear } from '../src/core/pcm.js';
import {
  Downsampler,
  MicScorer,
  scoreClip,
  SPEECH_FRAME,
  SPEECH_RATE,
  SPEECH_START,
} from '../src/core/speech.js';
import { VoiceDetector } from '../src/core/voice.js';

import { readWav, rms, share, toFloat, tone, VOICE_URL } from './signals.js';

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
    const input = tone(1, 1000, 0.3);
    const at48 = resampleLinear(input, 16000, 48000);
    const out = downsampleInBlocks(at48, 48000, 16000, 480);
    expect(Math.abs(out.length - 16000)).toBeLessThanOrEqual(2);
    expect(rms(out, 400) / rms(at48, 1200)).toBeGreaterThan(0.95);
    expect(rms(out, 400) / rms(at48, 1200)).toBeLessThan(1.05);
  });

  it('keeps the count right across blocks of odd lengths and from 44.1 kHz', () => {
    const input = new Float32Array(Math.round(2 * 44100));
    for (let i = 0; i < input.length; i++) input[i] = 0.3 * Math.sin((2 * Math.PI * 500 * i) / 44100);
    const out = downsampleInBlocks(input, 44100, 16000, 441);
    expect(Math.abs(out.length - 32000)).toBeLessThanOrEqual(2);
    expect(rms(out, 400) / rms(input, 1100)).toBeGreaterThan(0.95);
  });

  it('takes out what would fold back into the voice band', () => {
    const input = new Float32Array(48000);
    for (let i = 0; i < input.length; i++) input[i] = 0.3 * Math.sin((2 * Math.PI * 14000 * i) / 48000);
    const out = downsampleInBlocks(input, 48000, 16000, 480);
    expect(rms(out, 400) / rms(input, 1200)).toBeLessThan(0.1);
  });

  it('passes 16 kHz audio through untouched', () => {
    const input = tone(0.1, 1000, 0.3);
    expect(new Downsampler(16000, 16000).process(input)).toBe(input);
  });
});

describe('scoreClip', () => {
  const voice = readWav(VOICE_URL);

  it('gives one score per frame, the last frame padded', async () => {
    const probs = await scoreClip(new VoiceDetector(), voice, SPEECH_RATE);
    expect(probs.length).toBe(Math.ceil(voice.length / SPEECH_FRAME));
    expect(share(probs, SPEECH_START)).toBeGreaterThan(0.6);
  });

  it('reports progress in seconds up to the clip length', async () => {
    const seen: number[] = [];
    await scoreClip(new VoiceDetector(), voice, SPEECH_RATE, (sec) => seen.push(sec));
    expect(seen.length).toBeGreaterThan(1);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen[seen.length - 1]).toBeCloseTo(voice.length / SPEECH_RATE, 3);
  });
});

describe('MicScorer', () => {
  const voice = readWav(VOICE_URL);

  it('scores a 48 kHz microphone, block by block, the same as the clip', async () => {
    const mic = resampleLinear(toFloat(voice), SPEECH_RATE, 48000);
    const scorer = new MicScorer(new VoiceDetector());
    const seen: number[] = [];
    for (let at = 0; at + 480 <= mic.length; at += 480) {
      scorer.push(mic.subarray(at, at + 480), 48000);
      seen.push(scorer.prob);
    }
    expect(Math.abs(scorer.frames - Math.floor(voice.length / SPEECH_FRAME))).toBeLessThanOrEqual(2);
    const clip = await scoreClip(new VoiceDetector(), voice, SPEECH_RATE);
    expect(Math.abs(share(seen, SPEECH_START) - share(clip, SPEECH_START))).toBeLessThan(0.1);
  });

  it('starts over on reset', () => {
    const scorer = new MicScorer(new VoiceDetector());
    scorer.push(toFloat(voice).subarray(0, SPEECH_RATE), SPEECH_RATE);
    expect(scorer.frames).toBeGreaterThan(20);
    expect(scorer.prob).toBeGreaterThan(0);
    scorer.reset();
    expect(scorer.frames).toBe(0);
    expect(scorer.prob).toBe(0);
  });
});
