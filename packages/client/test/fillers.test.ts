/**
 * The filler detector on spoken fixtures (macOS text-to-speech): hesitations said flat and slow with a
 * pause on either side are found, ordinary sentences are left alone, and the cut keeps a pause.
 */
import { describe, expect, it } from 'vitest';

import { FILLER_THRESHOLD, findFillers, scoreFillers, type FillerCandidate } from '../src/core/fillers.js';

import { MALE_VOICE_URL, RATE, readWav, toFloat, VOICE_URL } from './signals.js';

/** "So the sky is blue [um] because the air scatters blue light. [uh] At sunset…", two voices. */
const FILLERS_URL = new URL('./fixtures/fillers-16k.wav', import.meta.url);
const FILLERS_MALE_URL = new URL('./fixtures/fillers-male-16k.wav', import.meta.url);

function covering(found: readonly FillerCandidate[], from: number, to: number): FillerCandidate | undefined {
  return found.find((c) => c.from <= from + 0.08 && c.to >= to - 0.08);
}

describe('findFillers', () => {
  it('finds the "um" between two pauses, at every sensitivity', () => {
    const pcm = readWav(FILLERS_URL);
    for (const sensitivity of ['low', 'medium', 'high'] as const) {
      const found = findFillers(pcm, RATE, sensitivity);
      const um = covering(found, 1.5, 1.85);
      expect(um, sensitivity).toBeDefined();
      expect(um?.features.pauseBefore ?? 0).toBeGreaterThan(0.2);
      expect(um?.features.pauseAfter ?? 0).toBeGreaterThan(0.2);
      // the cut takes the run and most of the pauses, but leaves a pause behind
      expect(um?.cutFrom ?? 0).toBeLessThan(um?.from ?? 0);
      expect(um?.cutTo ?? 0).toBeGreaterThan(um?.to ?? 0);
      expect((um?.from ?? 0) - (um?.cutFrom ?? 0)).toBeLessThan(0.3);
    }
  });

  it('finds the "uh" with a falling pitch only when asked to catch more', () => {
    const pcm = readWav(FILLERS_URL);
    expect(covering(findFillers(pcm, RATE, 'high'), 4.25, 4.6)).toBeDefined();
    expect(covering(findFillers(pcm, RATE, 'low'), 4.25, 4.6)).toBeUndefined();
  });

  it('finds a man’s "um" that runs straight into the next word, when catching more', () => {
    const pcm = readWav(FILLERS_MALE_URL);
    const um = covering(findFillers(pcm, RATE, 'high'), 1.6, 1.85);
    expect(um).toBeDefined();
    expect(um?.features.f1Hz ?? 0).toBeGreaterThan(430);
    expect(um?.features.f2Hz ?? 0).toBeLessThan(1750);
  });

  it.each([
    ['a woman', VOICE_URL],
    ['a man', MALE_VOICE_URL],
  ])('leaves an ordinary sentence by %s alone, even when catching more', (_name, url) => {
    const pcm = readWav(url);
    expect(findFillers(pcm, RATE, 'high')).toEqual([]);
  });

  it('scores every voiced run and keeps the measurements', () => {
    const runs = scoreFillers(toFloat(readWav(FILLERS_URL)));
    expect(runs.length).toBeGreaterThan(8);
    for (const r of runs) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
      expect(r.to).toBeGreaterThan(r.from);
      expect(r.cutFrom).toBeLessThanOrEqual(r.from);
      expect(r.cutTo).toBeGreaterThanOrEqual(r.to);
      for (const v of Object.values(r.parts)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
    expect(FILLER_THRESHOLD.low).toBeGreaterThan(FILLER_THRESHOLD.medium);
    expect(FILLER_THRESHOLD.medium).toBeGreaterThan(FILLER_THRESHOLD.high);
  });

  it('handles silence, a short clip and 48 kHz input', () => {
    expect(findFillers(new Int16Array(16000), RATE, 'high')).toEqual([]);
    expect(findFillers(new Int16Array(100), RATE, 'high')).toEqual([]);
    const pcm = readWav(FILLERS_URL);
    // the same clip resampled to 48 kHz by repeating samples: the um is found at the same time
    const up = new Int16Array(pcm.length * 3);
    for (let i = 0; i < pcm.length; i++) {
      up[i * 3] = pcm[i] ?? 0;
      up[i * 3 + 1] = pcm[i] ?? 0;
      up[i * 3 + 2] = pcm[i] ?? 0;
    }
    expect(covering(findFillers(up, 48000, 'medium'), 1.5, 1.85)).toBeDefined();
  });
});
