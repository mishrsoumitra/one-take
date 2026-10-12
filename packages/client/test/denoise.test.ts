/**
 * The noise filter on real speech (macOS text-to-speech) and on the sounds of a room: a clean voice
 * must come out as it went in, a fan under a voice must go quiet without taking the voice with it,
 * the room alone must drop by about 20 dB and never sound like a voice to the detector, a fan
 * switching on must be absorbed, and the live path (48 kHz blocks through the filter, the scorer and
 * the phrase detector) must still cut the same phrases.
 */
import { describe, expect, it } from 'vitest';

import { expint, FLOOR_DB, frameSizeFor, NoiseFilter } from '../src/core/denoise.js';
import { resampleLinear, type Samples } from '../src/core/pcm.js';
import { Recorder } from '../src/core/recorder.js';
import { cutPhrase } from '../src/core/silence.js';
import { MicScorer, scoreClip, SPEECH_FRAME, SPEECH_KEEP, SPEECH_START } from '../src/core/speech.js';
import { VoiceDetector, VoiceStream } from '../src/core/voice.js';

import {
  clicks,
  concat,
  fan,
  loudFrames,
  MALE_VOICE_URL,
  maxOf,
  RATE,
  readWav,
  rms,
  share,
  silence,
  toFloat,
  toInt16,
  VOICE_URL,
  white,
  withNoise,
} from './signals.js';

const woman = toFloat(readWav(VOICE_URL));
const man = toFloat(readWav(MALE_VOICE_URL));
const voices = [
  ['a woman', woman],
  ['a man', man],
] as const;

/** Frames after the first second: the filter and the detector have both settled by then. */
const AFTER_START = Math.round(1 / (SPEECH_FRAME / RATE));

/** The whole signal through a filter in blocks of `block` samples, as the mic would send it. */
function filter(signal: Float32Array, block = 160, sampleRate = RATE): Samples {
  const f = new NoiseFilter(sampleRate);
  const out = new Float32Array(signal.length);
  for (let at = 0; at < signal.length; at += block) {
    out.set(f.process(signal.subarray(at, Math.min(signal.length, at + block))), at);
  }
  return out;
}

/** `signal` moved `by` samples later, so it lines up with what the filter gives back. */
function delayed(signal: Float32Array, by: number): Samples {
  const out = new Float32Array(signal.length);
  out.set(signal.subarray(0, signal.length - by), by);
  return out;
}

function db(x: number): number {
  return 20 * Math.log10(x + 1e-9);
}

/** Mean over the flagged frames of the ratio, in dB, of the clean signal to what `out` got wrong. */
function segmentalSnr(out: Float32Array, clean: Float32Array, mask: readonly boolean[]): number {
  let sum = 0;
  let n = 0;
  for (let f = 0; f < mask.length; f++) {
    if (!mask[f]) continue;
    let signal = 0;
    let error = 0;
    for (let i = f * SPEECH_FRAME; i < (f + 1) * SPEECH_FRAME; i++) {
      const c = clean[i] ?? 0;
      signal += c * c;
      error += ((out[i] ?? 0) - c) ** 2;
    }
    sum += 10 * Math.log10((signal + 1e-12) / (error + 1e-12));
    n++;
  }
  return sum / Math.max(1, n);
}

/** How much quieter, in dB, each second of `out` is than the same second of `signal`. */
function changePerSecond(signal: Float32Array, out: Float32Array): number[] {
  const seconds = Math.floor(signal.length / RATE);
  const out2: number[] = [];
  for (let s = 0; s < seconds; s++)
    out2.push(db(rms(out, s * RATE, (s + 1) * RATE)) - db(rms(signal, s * RATE, (s + 1) * RATE)));
  return out2;
}

async function score(signal: Float32Array): Promise<Float32Array> {
  return scoreClip(new VoiceDetector(), toInt16(signal), RATE);
}

const LATENCY = new NoiseFilter(RATE).latency;

describe('NoiseFilter on a voice', () => {
  it.each(voices)('passes %s through almost unchanged, one frame later', (_name, voice) => {
    const clean = concat(silence(1), voice, silence(1));
    const out = filter(clean);
    const reference = delayed(clean, LATENCY);
    expect(segmentalSnr(out, reference, loudFrames(reference))).toBeGreaterThan(20);
    expect(Math.abs(db(rms(out)) - db(rms(clean)))).toBeLessThan(1.5);
  });

  it.each(voices)('takes a fan out from under %s and leaves the voice', async (_name, voice) => {
    const clean = concat(silence(1), voice, silence(1.5));
    const seconds = clean.length / RATE;
    for (const snrDb of [10, 5]) {
      const noisy = withNoise(clean, fan(seconds, 1), snrDb);
      const out = filter(noisy);
      const reference = delayed(clean, LATENCY);
      const loud = loudFrames(reference);
      // the room alone, in the last second: twenty decibels quieter
      const tail = Math.round((seconds - 1) * RATE);
      expect(db(rms(out, tail)) - db(rms(noisy, tail))).toBeLessThan(-17);
      // the voice is still there: against the clean voice it measures within a couple of decibels
      // of the noisy mix (the filter dulls its weakest parts a little while the fan goes)
      expect(segmentalSnr(out, reference, loud)).toBeGreaterThan(
        segmentalSnr(delayed(noisy, LATENCY), reference, loud) - 2,
      );
      // and the detector hears more of it than it did through the fan
      const before = share(await score(noisy), SPEECH_START, loud);
      const after = share(await score(out), SPEECH_START, loud);
      expect(after).toBeGreaterThan(before);
      expect(after).toBeGreaterThan(0.4);
    }
  });

  it('leaves the voice detector nothing to hear in the filtered room after the voice', async () => {
    const clean = concat(silence(1), woman, silence(2));
    const seconds = clean.length / RATE;
    for (const noise of [fan(seconds, 1), fan(seconds, 1, { hum: true }), white(seconds, 1)]) {
      const probs = await score(filter(withNoise(clean, noise, 5)));
      const tailFrame = Math.round((seconds - 1.5) / (SPEECH_FRAME / RATE));
      expect(maxOf(probs, tailFrame)).toBeLessThan(SPEECH_KEEP);
    }
  });
});

describe('NoiseFilter on the sounds of a room', () => {
  it('quietens a fan, a humming fan, a hissy fan and hiss by about 20 dB from the first second', () => {
    for (const signal of [
      fan(6, 0.1),
      fan(6, 0.1, { hum: true }),
      fan(6, 0.1, { cutoffHz: 400 }),
      fan(6, 0.01),
      white(6, 0.03),
    ]) {
      const change = changePerSecond(signal, filter(signal));
      for (const c of change) expect(c).toBeLessThan(-15);
      for (const c of change) expect(c).toBeGreaterThan(-FLOOR_DB - 2);
    }
  });

  it('absorbs a fan that switches on within three seconds', () => {
    const signal = concat(fan(3, 0.001), fan(6, 0.05));
    const change = changePerSecond(signal, filter(signal));
    // the first second after the switch-on goes through: nothing yet says it is the room
    expect(change[3]).toBeGreaterThan(-6);
    expect(change[6]).toBeLessThan(-15);
    expect(change[7]).toBeLessThan(-15);
    expect(change[8]).toBeLessThan(-15);
  });

  it('never makes a voice out of the room for the voice detector', () => {
    for (const seed of [1, 2, 3, 5, 8, 9, 13]) {
      for (const signal of [fan(6, 0.1, { seed }), fan(6, 0.1, { seed, hum: true }), white(6, 0.03, seed)]) {
        // the frame of silence the filter starts with is dropped: the detector takes its first frame
        // for the room, and a real mic has no such frame (the filter's delay is a third of one)
        const out = filter(signal).subarray(LATENCY);
        const stream = new VoiceStream();
        let hot = 0;
        for (let f = 0; (f + 1) * SPEECH_FRAME <= out.length; f++) {
          const s = stream.score(out.subarray(f * SPEECH_FRAME, (f + 1) * SPEECH_FRAME));
          if (f >= AFTER_START && s >= SPEECH_KEEP) hot++;
        }
        expect(hot).toBe(0);
      }
    }
  });

  it('lets typing through only dulled: it is not the room', () => {
    const signal = clicks(4);
    const change = changePerSecond(signal, filter(signal));
    for (const c of change.slice(1)) expect(c).toBeGreaterThan(-12);
  });
});

describe('NoiseFilter as a stream', () => {
  it('gives the same samples whatever the block size', () => {
    const signal = withNoise(concat(silence(0.3), woman.subarray(0, RATE)), fan(1.3, 1), 10);
    const whole = filter(signal, signal.length);
    expect(filter(signal, 128)).toEqual(whole);
    expect(filter(signal, 7)).toEqual(whole);
    expect(filter(signal, 1000)).toEqual(whole);
  });

  it('is the same every time', () => {
    const signal = withNoise(concat(silence(0.3), man.subarray(0, RATE)), white(1.3, 1), 5);
    expect(filter(signal)).toEqual(filter(signal));
  });

  it('starts with one frame of silence and runs that far behind', () => {
    const click = new Float32Array(RATE);
    click[RATE / 2] = 1;
    const out = filter(concat(silence(1), click));
    expect(Array.from(out.subarray(0, LATENCY)).every((v) => v === 0)).toBe(true);
    let peakAt = 0;
    for (let i = 0; i < out.length; i++) if (Math.abs(out[i] ?? 0) > Math.abs(out[peakAt] ?? 0)) peakAt = i;
    expect(peakAt).toBe(RATE + RATE / 2 + LATENCY);
  });

  it('frames 21 ms at 48 kHz, 23 ms at 44.1 kHz and 32 ms at 16 kHz', () => {
    expect(frameSizeFor(48000)).toBe(1024);
    expect(frameSizeFor(44100)).toBe(1024);
    expect(frameSizeFor(16000)).toBe(512);
    const f = new NoiseFilter(48000);
    expect(f.frame).toBe(1024);
    expect(f.hop).toBe(512);
    expect(f.latency).toBe(1024);
  });

  it('runs far ahead of real time', () => {
    const signal = white(10, 0.1);
    const f = new NoiseFilter(48000);
    const started = performance.now();
    for (let at = 0; at + 128 <= signal.length; at += 128) f.process(signal.subarray(at, at + 128));
    // 160 000 samples is 3.3 s of 48 kHz audio; a tenth of real time is plenty of margin
    expect(performance.now() - started).toBeLessThan(330);
  });

  it('knows the exponential integral', () => {
    expect(expint(0.1)).toBeCloseTo(1.822924, 4);
    expect(expint(0.5)).toBeCloseTo(0.559774, 4);
    expect(expint(1)).toBeCloseTo(0.219384, 4);
    expect(expint(2)).toBeCloseTo(0.048901, 4);
    expect(expint(5)).toBeCloseTo(0.001148, 4);
    expect(expint(0)).toBe(Infinity);
  });
});

/** The live path: 48 kHz blocks through the filter, the scorer, the recorder and the second listen, like the microphone. */
async function record(signal16: Samples, threshold = -45): Promise<{ at: number; sec: number }[]> {
  const mic = resampleLinear(signal16, RATE, 48000);
  const noise = new NoiseFilter(48000);
  const scorer = new MicScorer(new VoiceDetector());
  const settings = { threshold, hangoverMs: 700, prerollMs: 200, tailMs: 150, minSpeechMs: 200 };
  const phrases: { at: number; sec: number }[] = [];
  const when = new Map<Float32Array, number>();
  let n = 0;
  const rec = new Recorder(
    10,
    settings,
    { mode: 'auto', slide: 0, review: (blocks) => cutPhrase(blocks, 48000, settings) },
    {
      onPhrase: (p) => {
        phrases.push({ at: (when.get(p.blocks[0]!) ?? 0) / 1000, sec: (p.blocks.length * 10) / 1000 });
        return `p${++n}`;
      },
      onSpeakingChange: () => undefined,
    },
  );
  let t = 0;
  for (let at = 0; at + 480 <= mic.length; at += 480, t += 10) {
    const block = noise.process(mic.subarray(at, at + 480));
    when.set(block, t);
    scorer.push(block, 48000);
    rec.process(block, scorer.prob);
  }
  rec.end();
  await rec.settled();
  return phrases;
}

describe('the live detector behind the noise filter', () => {
  const womanSec = woman.length / RATE;
  const manSec = man.length / RATE;

  it('records the two speakers over a fan and nothing of the typing between them', async () => {
    const sequence = concat(silence(1), woman, silence(1.5), clicks(2), silence(1), man, silence(1));
    const phrases = await record(withNoise(sequence, fan(sequence.length / RATE, 1), 10));
    expect(phrases).toHaveLength(2);
    const [first, second] = phrases as [(typeof phrases)[0], (typeof phrases)[0]];
    // the phrase begins with the pre-roll, up to 0.2 s before the first word
    expect(first.at).toBeGreaterThan(0.7);
    expect(first.at).toBeLessThan(1.2);
    expect(first.sec).toBeGreaterThan(womanSec - 0.3);
    expect(first.sec).toBeLessThan(womanSec + 0.6);
    expect(second.at).toBeGreaterThan(1 + womanSec + 4.5 - 0.4);
    expect(second.at).toBeLessThan(1 + womanSec + 4.5 + 0.2);
    expect(second.sec).toBeGreaterThan(manSec - 0.3);
    expect(second.sec).toBeLessThan(manSec + 0.6);
  });

  it('records nothing of a fan, a humming fan or hiss alone', async () => {
    for (const signal of [
      fan(8, 0.1),
      fan(8, 0.1, { hum: true }),
      white(8, 0.03),
      concat(fan(3, 0.001), fan(5, 0.05)),
    ]) {
      expect(await record(signal)).toHaveLength(0);
    }
  });
});
