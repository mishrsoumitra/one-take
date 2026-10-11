import { describe, expect, it } from 'vitest';

import { VoiceActivityDetector, type PhraseResult, type VadSettings } from '../src/core/vad.js';

const settings: VadSettings = {
  threshold: -45,
  hangoverMs: 700,
  prerollMs: 200,
  tailMs: 150,
  minSpeechMs: 200,
};
const BLOCK = 480; // 10 ms at 48 kHz

function loud(): Float32Array {
  const b = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) b[i] = 0.3 * Math.sin(i / 3);
  return b;
}
function quiet(): Float32Array {
  const b = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) b[i] = 0.0005 * Math.sin(i / 7);
  return b;
}

function harness() {
  const phrases: (PhraseResult | null)[] = [];
  let starts = 0;
  const vad = new VoiceActivityDetector(10, settings, {
    onSpeechStart: () => starts++,
    onSpeechEnd: (p) => phrases.push(p),
  });
  const feed = (block: () => Float32Array, ms: number) => {
    for (let i = 0; i < ms / 10; i++) vad.process(block());
  };
  return { vad, phrases, feed, starts: () => starts };
}

describe('VoiceActivityDetector', () => {
  it('keeps one phrase with pre-roll and a short tail', () => {
    const h = harness();
    h.feed(quiet, 1000);
    expect(h.vad.speaking).toBe(false);
    h.feed(loud, 1000);
    expect(h.vad.speaking).toBe(true);
    expect(h.starts()).toBe(1);
    h.feed(quiet, 1000);
    expect(h.vad.speaking).toBe(false);
    expect(h.phrases).toHaveLength(1);
    const p = h.phrases[0]!;
    expect(p).not.toBeNull();
    // 200 ms pre-roll (+3 blocks slack) + 1000 ms speech + 150 ms tail, in 10 ms blocks
    expect(p.blocks.length).toBeGreaterThanOrEqual(100 + 20 + 15);
    expect(p.blocks.length).toBeLessThanOrEqual(100 + 23 + 15);
    expect(p.loudMs).toBeGreaterThanOrEqual(990);
    expect(p.continuation).toBe(false);
  });

  it('drops clicks shorter than the minimum', () => {
    const h = harness();
    h.feed(quiet, 500);
    h.feed(loud, 100);
    h.feed(quiet, 1000);
    expect(h.phrases).toEqual([null]);
  });

  it('survives pauses shorter than the hangover', () => {
    const h = harness();
    h.feed(quiet, 300);
    h.feed(loud, 500);
    h.feed(quiet, 400);
    expect(h.vad.speaking).toBe(true);
    h.feed(loud, 500);
    h.feed(quiet, 1000);
    expect(h.phrases).toHaveLength(1);
    expect(h.phrases[0]!.blocks.length).toBeGreaterThan(140);
  });

  it('splits a phrase on a slide change and keeps the continuation', () => {
    const h = harness();
    h.feed(quiet, 300);
    h.feed(loud, 600);
    const first = h.vad.split();
    expect(first).not.toBeNull();
    expect(first!.length).toBeGreaterThan(60);
    expect(h.vad.speaking).toBe(true);
    h.feed(loud, 100); // shorter than minSpeech, but it continues a phrase
    h.feed(quiet, 1000);
    expect(h.phrases).toHaveLength(1);
    expect(h.phrases[0]!.continuation).toBe(true);
  });

  it('stores nothing for a slide that was skipped past mid-sentence', () => {
    const h = harness();
    h.feed(quiet, 300);
    h.feed(loud, 600);
    expect(h.vad.split()).not.toBeNull(); // first part, on the slide being left
    expect(h.vad.split()).toBeNull(); // straight on to the next slide: nothing was said in between
    h.feed(quiet, 50);
    expect(h.vad.split()).toBeNull(); // a sliver of quiet is not a phrase either
    expect(h.vad.speaking).toBe(true);
    h.feed(loud, 300);
    h.feed(quiet, 1000);
    expect(h.phrases).toHaveLength(1);
    expect(h.phrases[0]!.continuation).toBe(true);
    expect(h.phrases[0]!.loudMs).toBeGreaterThanOrEqual(290);
  });

  it('ends instead of splitting when the speaker already went quiet', () => {
    const h = harness();
    h.feed(quiet, 300);
    h.feed(loud, 600);
    h.feed(quiet, 300);
    expect(h.vad.split()).toBeNull();
    expect(h.vad.speaking).toBe(false);
    expect(h.phrases).toHaveLength(1);
  });

  it('discards the phrase being spoken', () => {
    const h = harness();
    h.feed(quiet, 300);
    h.feed(loud, 600);
    h.vad.discard();
    expect(h.vad.speaking).toBe(false);
    expect(h.phrases).toEqual([null]);
  });

  it('ignores sound while gated off', () => {
    const h = harness();
    h.vad.gate = false;
    h.feed(loud, 1000);
    expect(h.vad.speaking).toBe(false);
    expect(h.starts()).toBe(0);
  });

  it('raises the threshold above a noisy floor', () => {
    const h = harness();
    const noisy = () => {
      const b = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) b[i] = 0.02 * Math.sin(i / 5); // about -37 dB
      return b;
    };
    h.feed(noisy, 3000);
    expect(h.vad.threshold).toBeGreaterThan(-45);
  });
});
