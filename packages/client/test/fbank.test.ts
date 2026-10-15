/**
 * The Kaldi filterbank against frames computed by kaldi-native-fbank (what sherpa-onnx feeds the
 * speaker model), on the three spoken fixtures.
 */
import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { FBANK_BANDS, fbank, fbankFrames, subtractMean } from '../src/core/fbank.js';

import { LOW_VOICE_URL, MALE_VOICE_URL, readWav, toFloat, VOICE_URL } from './signals.js';

export interface ClipReference {
  samples: number;
  frames: number;
  pick: number[];
  fbank: number[][];
  embedding: number[];
  cropCount: number;
}

export interface SpeakerReference {
  'voice-16k.wav': ClipReference;
  'voice-male-16k.wav': ClipReference;
  'voice-low-16k.wav': ClipReference;
  cosines: Record<string, number>;
}

export const reference = JSON.parse(
  fs.readFileSync(new URL('./fixtures/speaker-reference.json', import.meta.url), 'utf8'),
) as SpeakerReference;

const clips = [
  ['voice-16k.wav', VOICE_URL],
  ['voice-male-16k.wav', MALE_VOICE_URL],
  ['voice-low-16k.wav', LOW_VOICE_URL],
] as const;

describe('fbank', () => {
  it('counts frames the way Kaldi does once a clip is finished', () => {
    expect(fbankFrames(0)).toBe(0);
    expect(fbankFrames(79)).toBe(0);
    expect(fbankFrames(80)).toBe(1);
    expect(fbankFrames(16000)).toBe(100);
    for (const [name] of clips) {
      const ref = reference[name];
      expect(fbankFrames(ref.samples)).toBe(ref.frames);
    }
  });

  for (const [name, url] of clips) {
    it(`matches kaldi-native-fbank on ${name}, edges included`, () => {
      const ref = reference[name];
      const samples = toFloat(readWav(url));
      expect(samples.length).toBe(ref.samples);
      const feats = fbank(samples);
      expect(feats.frames).toBe(ref.frames);
      let worst = 0;
      ref.pick.forEach((frame, k) => {
        const expected = ref.fbank[k] ?? [];
        for (let b = 0; b < FBANK_BANDS; b++) {
          const got = feats.data[frame * FBANK_BANDS + b] ?? NaN;
          worst = Math.max(worst, Math.abs(got - (expected[b] ?? NaN)));
        }
      });
      // float32 in the reference against float64 here: a few thousandths on log energies of 10 to 25
      expect(worst).toBeLessThan(0.02);
    });
  }

  it('takes each band to a zero mean over the clip', () => {
    const feats = subtractMean(fbank(toFloat(readWav(VOICE_URL))));
    for (let b = 0; b < FBANK_BANDS; b++) {
      let sum = 0;
      for (let f = 0; f < feats.frames; f++) sum += feats.data[f * FBANK_BANDS + b] ?? 0;
      expect(Math.abs(sum / feats.frames)).toBeLessThan(1e-4);
    }
  });

  it('gives the same features for the same voice 20 dB quieter, once the mean is out', () => {
    const loud = toFloat(readWav(VOICE_URL));
    const quiet = Float32Array.from(loud, (v) => v * 0.1);
    const a = subtractMean(fbank(loud));
    const b = subtractMean(fbank(quiet));
    let worst = 0;
    for (let i = 0; i < a.data.length; i++)
      worst = Math.max(worst, Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)));
    // only the bands that hit the energy floor in the quiet copy can differ
    expect(worst).toBeLessThan(0.5);
  });
});
