import { describe, expect, it } from 'vitest';

import { LIVE_KEEP, LIVE_START } from '../src/core/speech.js';
import { LIVE_HOLD_MS, VoiceActivityDetector, type PhraseResult, type VadSettings } from '../src/core/vad.js';

const settings: VadSettings = {
  threshold: -45,
  hangoverMs: 700,
  prerollMs: 200,
  tailMs: 150,
  minSpeechMs: 200,
};
const BLOCK = 480; // 10 ms at 48 kHz
/** Quiet long enough to end a phrase: the live hold plus a little. */
const HOLD = LIVE_HOLD_MS + 100;

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
  const feed = (block: () => Float32Array, ms: number, speech: number | null = null) => {
    for (let i = 0; i < ms / 10; i++) vad.process(block(), speech);
  };
  return { vad, phrases, feed, starts: () => starts };
}

describe('VoiceActivityDetector with a voice score', () => {
  it('does not start a phrase on loud sound the model does not hear as a voice', () => {
    const h = harness();
    h.feed(loud, 3000, 0.05);
    expect(h.vad.speaking).toBe(false);
    expect(h.starts()).toBe(0);
    // and the line stays where the user put it instead of climbing above the noise
    expect(h.vad.threshold).toBe(-45);
    expect(h.vad.voice).toBe(0.05);
  });

  it('ends a phrase in loud noise once the model hears no voice', () => {
    // the bug this guards against: typing, breathing or a fan kept a level-only phrase open for minutes
    const h = harness();
    h.feed(quiet, 500, 0.02);
    h.feed(loud, 1000, 0.9);
    expect(h.vad.speaking).toBe(true);
    h.feed(loud, HOLD, 0.1);
    expect(h.vad.speaking).toBe(false);
    expect(h.phrases).toHaveLength(1);
    const p = h.phrases[0]!;
    expect(p).not.toBeNull();
    // 1000 ms of voice plus the pre-roll and the 150 ms tail: none of the noisy seconds
    expect(p.blocks.length).toBeLessThanOrEqual(100 + 23 + 15);
    expect(p.loudMs).toBeGreaterThanOrEqual(990);
  });

  it('opens at the live start score and stays open at the live keep score', () => {
    const h = harness();
    h.feed(loud, 1000, LIVE_START - 0.01);
    expect(h.vad.speaking).toBe(false);
    h.feed(loud, 30, LIVE_START);
    expect(h.vad.speaking).toBe(true);
    // a soft stretch the live detector must not cut: scored well under the second listen's keep score
    h.feed(loud, 3000, LIVE_KEEP);
    expect(h.vad.speaking).toBe(true);
    h.feed(loud, HOLD, LIVE_KEEP - 0.01);
    expect(h.vad.speaking).toBe(false);
    expect(h.phrases).toHaveLength(1);
    expect(h.phrases[0]!.loudMs).toBeGreaterThanOrEqual(3000);
  });

  it('needs the level over the line to start, but not to go on', () => {
    const h = harness();
    h.feed(quiet, 1000, 0.95); // a faint voice from the next room
    expect(h.vad.speaking).toBe(false);
    h.feed(loud, 500, 0.95);
    expect(h.vad.speaking).toBe(true);
    h.feed(quiet, 2000, 0.95); // trailing off at the end of a sentence
    expect(h.vad.speaking).toBe(true);
  });

  it('holds a phrase open for two seconds of nothing, not just the hangover', () => {
    const h = harness();
    h.feed(loud, 500, 0.9);
    h.feed(loud, 500, 0.4);
    expect(h.vad.speaking).toBe(true);
    h.feed(loud, 1500, 0.1); // longer than the hangover, shorter than the hold
    expect(h.vad.speaking).toBe(true);
    h.feed(loud, LIVE_HOLD_MS, 0.1);
    expect(h.vad.speaking).toBe(false);
  });

  it('survives a short pause the model scores as no voice', () => {
    const h = harness();
    h.feed(loud, 500, 0.9);
    h.feed(quiet, 400, 0.02);
    expect(h.vad.speaking).toBe(true);
    h.feed(loud, 500, 0.9);
    h.feed(quiet, HOLD, 0.02);
    expect(h.phrases).toHaveLength(1);
  });

  it('falls back to level the moment the score goes away', () => {
    const h = harness();
    h.feed(loud, 500, 0.9);
    expect(h.vad.speaking).toBe(true);
    h.feed(loud, 2000, null); // the model failed: the loud blocks keep the phrase going by level
    expect(h.vad.speaking).toBe(true);
    expect(h.vad.voice).toBeNull();
    h.feed(quiet, HOLD, null);
    expect(h.vad.speaking).toBe(false);
  });
});

describe('VoiceActivityDetector', () => {
  it('keeps one phrase with pre-roll and a short tail', () => {
    const h = harness();
    h.feed(quiet, 1000);
    expect(h.vad.speaking).toBe(false);
    h.feed(loud, 1000);
    expect(h.vad.speaking).toBe(true);
    expect(h.starts()).toBe(1);
    h.feed(quiet, HOLD);
    expect(h.vad.speaking).toBe(false);
    expect(h.phrases).toHaveLength(1);
    const p = h.phrases[0]!;
    expect(p).not.toBeNull();
    // 200 ms pre-roll (+3 blocks slack) + 1000 ms speech + 150 ms tail, in 10 ms blocks: the rest of
    // the two-second hold is not kept
    expect(p.blocks.length).toBeGreaterThanOrEqual(100 + 20 + 15);
    expect(p.blocks.length).toBeLessThanOrEqual(100 + 23 + 15);
    expect(p.loudMs).toBeGreaterThanOrEqual(990);
    expect(p.continuation).toBe(false);
  });

  it('drops clicks shorter than the minimum', () => {
    const h = harness();
    h.feed(quiet, 500);
    h.feed(loud, 100);
    h.feed(quiet, HOLD);
    expect(h.phrases).toEqual([null]);
  });

  it('holds through a pause longer than the hangover; the second listen cuts it later', () => {
    const h = harness();
    h.feed(quiet, 300);
    h.feed(loud, 500);
    h.feed(quiet, 1200);
    expect(h.vad.speaking).toBe(true);
    h.feed(loud, 500);
    h.feed(quiet, HOLD);
    expect(h.phrases).toHaveLength(1);
    expect(h.phrases[0]!.blocks.length).toBeGreaterThan(220);
  });

  it('splits a phrase on a slide change and keeps the continuation', () => {
    const h = harness();
    h.feed(quiet, 300);
    h.feed(loud, 600);
    const first = h.vad.split();
    expect(first).not.toBeNull();
    expect(first!.blocks.length).toBeGreaterThan(60);
    expect(h.vad.speaking).toBe(true);
    h.feed(loud, 100); // shorter than minSpeech, but it continues a phrase
    h.feed(quiet, HOLD);
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
    h.feed(quiet, HOLD);
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
