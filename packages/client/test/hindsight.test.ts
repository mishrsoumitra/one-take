/**
 * The second listen on real speech: a woman, a man, a deep low voice, a voice that drops to a soft
 * aside and comes back; and on the sounds of a room, which must still score nothing. Then the whole
 * live path with the second listen behind it, the way the app records.
 */
import { describe, expect, it } from 'vitest';

import { listenAgain } from '../src/core/hindsight.js';
import { resampleLinear, type Samples } from '../src/core/pcm.js';
import { Recorder } from '../src/core/recorder.js';
import { cutPhrase, speechRanges } from '../src/core/silence.js';
import { MicScorer, SPEECH_FRAME, SPEECH_KEEP, SPEECH_START } from '../src/core/speech.js';
import { VoiceDetector } from '../src/core/voice.js';

import {
  clicks,
  concat,
  fan,
  loudFrames,
  LOW_VOICE_URL,
  MALE_VOICE_URL,
  maxOf,
  mix,
  RATE,
  readWav,
  scale,
  share,
  silence,
  toFloat,
  toInt16,
  tone,
  VOICE_URL,
  white,
  withNoise,
} from './signals.js';

const woman = toFloat(readWav(VOICE_URL));
const man = toFloat(readWav(MALE_VOICE_URL));
const low = toFloat(readWav(LOW_VOICE_URL));
const settings = { threshold: -45, hangoverMs: 700, prerollMs: 200, tailMs: 150, minSpeechMs: 200 };
const FRAME_SEC = SPEECH_FRAME / RATE;
const AFTER_START = Math.round(1 / FRAME_SEC);

/** A quiet room: a faint fan at about -54 dBFS. */
const room = (seconds: number) => fan(seconds, 0.002, { seed: 3 });

/** The share of a clean voice's loud blocks (10 ms) that fall inside `ranges` (seconds). */
function keptShare(clean: Float32Array, ranges: { from: number; to: number }[]): number {
  let n = 0;
  let hit = 0;
  for (let at = 0; at + 160 <= clean.length; at += 160) {
    let sum = 0;
    for (let i = at; i < at + 160; i++) sum += (clean[i] ?? 0) ** 2;
    if (Math.sqrt(sum / 160) <= 0.0178) continue;
    n++;
    const t = (at + 80) / RATE;
    if (ranges.some((r) => t >= r.from && t < r.to)) hit++;
  }
  return n === 0 ? 0 : hit / n;
}

describe('the second listen on speech', () => {
  it.each([
    ['a woman', woman, 0.7],
    ['a man', man, 0.7],
    // a 58 Hz voice: fewer of its frames score on their own (its harmonics crowd the comb and it has
    // little above 2.5 kHz), but every word is bridged into the stretches kept
    ['a deep voice under the old 70 Hz pitch floor', low, 0.5],
  ])('hears %s as a voice most of the way through', async (_name, voice, frames) => {
    const clean = concat(silence(1), voice, silence(1));
    const probs = await listenAgain(toInt16(mix(clean, room(clean.length / RATE))), RATE);
    expect(probs.length).toBe(Math.ceil(clean.length / SPEECH_FRAME));
    expect(share(probs, SPEECH_START, loudFrames(clean))).toBeGreaterThan(frames);
    const quietFrames = loudFrames(clean).map((l) => !l);
    expect(share(probs, SPEECH_KEEP, quietFrames)).toBeLessThan(0.25);
    expect(keptShare(clean, speechRanges(probs, clean.length / RATE, settings))).toBeGreaterThan(0.97);
  });

  it.each([
    ['a man', man, 25],
    ['a woman', woman, 25],
    ['a deep voice', low, 20],
  ])('keeps a sentence %s drops to %i dB softer in the middle of', async (_name, voice, drop) => {
    const soft = scale(voice, 10 ** (-drop / 20));
    const clean = concat(silence(1), voice, silence(0.4), soft, silence(0.4), voice, silence(1));
    const reference = concat(silence(1), voice, silence(0.4), voice, silence(0.4), voice, silence(1));
    const probs = await listenAgain(toInt16(mix(clean, room(clean.length / RATE))), RATE);
    const ranges = speechRanges(probs, clean.length / RATE, settings);
    expect(keptShare(reference, ranges)).toBeGreaterThan(0.9);
    // the soft sentence itself, not just the loud ones around it
    const from = 1 + voice.length / RATE + 0.4;
    const to = from + voice.length / RATE;
    const middle = ranges.reduce(
      (sum, r) => sum + Math.max(0, Math.min(to, r.to) - Math.max(from, r.from)),
      0,
    );
    expect(middle).toBeGreaterThan(0.85 * (to - from));
  });

  it('keeps a soft sentence that stands on its own, a pause either side', async () => {
    const soft = scale(man, 10 ** (-20 / 20));
    const clean = concat(silence(1), man, silence(1.2), soft, silence(1.2), man, silence(1));
    const probs = await listenAgain(toInt16(mix(clean, room(clean.length / RATE))), RATE);
    const ranges = speechRanges(probs, clean.length / RATE, settings);
    expect(ranges).toHaveLength(3);
    const from = 1 + man.length / RATE + 1.2;
    const to = from + man.length / RATE;
    expect(ranges[1]?.from).toBeLessThan(from + 0.3);
    expect(ranges[1]?.to).toBeGreaterThan(to - 0.4);
  });

  it('keeps hearing the voice over a fan ten decibels under it', async () => {
    for (const [voice, frames] of [
      [woman, 0.4],
      [man, 0.4],
      [low, 0.15],
    ] as const) {
      const clean = concat(silence(1), voice, silence(1));
      const probs = await listenAgain(toInt16(withNoise(clean, fan(clean.length / RATE, 1), 10)), RATE);
      expect(share(probs, SPEECH_START, loudFrames(clean))).toBeGreaterThan(frames);
      expect(keptShare(clean, speechRanges(probs, clean.length / RATE, settings))).toBeGreaterThan(0.9);
    }
  });

  it('runs quickly enough for an hour of clips in under a minute', async () => {
    const clip = toInt16(concat(silence(0.5), woman, silence(0.5), man, silence(0.5)));
    const started = performance.now();
    await listenAgain(clip, RATE);
    const perSecond = (performance.now() - started) / (clip.length / RATE);
    expect(perSecond).toBeLessThan(16); // ms per second of audio, with headroom over a slow CI box
  });
});

describe('the second listen on the sounds of a room', () => {
  it('hears nothing in a fan, a humming fan, hiss, typing, a tone or silence', async () => {
    for (const signal of [
      fan(8, 0.03),
      fan(8, 0.1),
      fan(8, 0.1, { hum: true }),
      fan(8, 0.1, { cutoffHz: 400 }),
      white(8, 0.03),
      clicks(8),
      mix(clicks(8), fan(8, 0.005)),
      tone(8, 1000, 0.1),
      silence(5),
    ]) {
      const probs = await listenAgain(toInt16(signal), RATE);
      expect(maxOf(probs, AFTER_START)).toBeLessThan(SPEECH_KEEP);
      expect(speechRanges(probs, signal.length / RATE, settings)).toEqual([]);
    }
  });

  it('finds no phrase in a fan, a hum or a tone switching on, or in gain creeping up', async () => {
    const creep = fan(10, 0.01);
    for (let i = 0; i < creep.length; i++)
      creep[i] = (creep[i] ?? 0) * Math.pow(10, (20 * i) / creep.length / 20);
    for (const signal of [
      concat(fan(3, 0.001), fan(6, 0.05)),
      concat(fan(3, 0.001), fan(6, 0.05, { hum: true })),
      concat(silence(3), tone(6, 1000, 0.1)),
      concat(silence(3), tone(6, 150, 0.1)),
      fan(10, 0.05, { wobbleDb: 6 }),
      creep,
    ]) {
      const probs = await listenAgain(toInt16(signal), RATE);
      expect(speechRanges(probs, signal.length / RATE, settings)).toEqual([]);
      // the moment of switching on may look like a voice for a frame; never for a phrase's worth
      let hot = 0;
      for (let k = AFTER_START; k < probs.length; k++) if ((probs[k] ?? 0) >= SPEECH_START) hot++;
      expect(hot).toBeLessThanOrEqual(4);
    }
  });
});

describe('cutPhrase', () => {
  /** 48 kHz blocks of 10 ms, like the microphone. */
  function blocksOf(signal16: Samples): Float32Array[] {
    const mic = resampleLinear(signal16, RATE, 48000);
    const out: Float32Array[] = [];
    for (let at = 0; at + 480 <= mic.length; at += 480) out.push(mic.subarray(at, at + 480));
    return out;
  }

  it('keeps a phrase that is voice from start to end, blocks and all', async () => {
    const blocks = blocksOf(concat(silence(0.2), woman, silence(0.15)));
    const verdict = await cutPhrase(blocks, 48000, settings);
    expect(verdict.keep).toEqual([{ from: 0, to: blocks.length }]);
    expect(verdict.startCut).toBe(false);
    expect(verdict.endCut).toBe(false);
  });

  it('cuts the dead air the live detector held through, at block boundaries', async () => {
    const blocks = blocksOf(concat(silence(0.2), woman, silence(1.9)));
    const verdict = await cutPhrase(blocks, 48000, settings);
    expect(verdict.keep).toHaveLength(1);
    const [range] = verdict.keep as [{ from: number; to: number }];
    expect(range.from).toBe(0);
    const end = 0.2 + woman.length / RATE;
    expect(range.to / 100).toBeGreaterThan(end - 0.1);
    expect(range.to / 100).toBeLessThan(end + settings.tailMs / 1000 + 0.15);
    expect(verdict.endCut).toBe(true);
    expect(verdict.startCut).toBe(false);
  });

  it('splits at a pause longer than the hangover and drops a phrase with no voice', async () => {
    const blocks = blocksOf(concat(silence(0.2), woman, silence(1.2), man, silence(0.15)));
    const verdict = await cutPhrase(blocks, 48000, settings);
    expect(verdict.keep).toHaveLength(2);
    const [a, b] = verdict.keep as [{ from: number; to: number }, { from: number; to: number }];
    expect(a.to).toBeLessThan(b.from);
    expect((b.from - a.to) / 100).toBeGreaterThan(0.5);
    expect(b.to).toBe(blocks.length);
    const typing = await cutPhrase(blocksOf(concat(silence(0.2), clicks(2), silence(0.15))), 48000, settings);
    expect(typing.keep).toEqual([]);
  });
});

describe('the live path with the second listen behind it', () => {
  /** 48 kHz blocks through the scorer, the recorder and the second listen, like the microphone. */
  async function record(signal16: Samples): Promise<{ sec: number }[]> {
    const mic = resampleLinear(signal16, RATE, 48000);
    const scorer = new MicScorer(new VoiceDetector());
    const phrases: { sec: number }[] = [];
    let n = 0;
    const rec = new Recorder(
      10,
      settings,
      { mode: 'auto', slide: 0, review: (blocks) => cutPhrase(blocks, 48000, settings) },
      {
        onPhrase: (p) => {
          phrases.push({ sec: (p.blocks.length * 10) / 1000 });
          return `p${++n}`;
        },
        onSpeakingChange: () => undefined,
      },
    );
    for (let at = 0; at + 480 <= mic.length; at += 480) {
      const block = mic.subarray(at, at + 480);
      scorer.push(block, 48000);
      rec.process(block, scorer.prob);
    }
    rec.end();
    await rec.settled();
    return phrases;
  }

  const womanSec = woman.length / RATE;
  const manSec = man.length / RATE;
  const lowSec = low.length / RATE;

  it('records three speakers and nothing of the typing or the pauses between them', async () => {
    const sequence = concat(
      silence(1),
      woman,
      silence(1.5),
      clicks(2),
      silence(1),
      man,
      silence(1.2),
      low,
      silence(1),
    );
    const phrases = await record(sequence);
    expect(phrases.map((p) => p.sec)).toHaveLength(3);
    const [first, second, third] = phrases as [(typeof phrases)[0], (typeof phrases)[0], (typeof phrases)[0]];
    expect(first.sec).toBeGreaterThan(womanSec - 0.3);
    expect(first.sec).toBeLessThan(womanSec + 0.5);
    expect(second.sec).toBeGreaterThan(manSec - 0.3);
    expect(second.sec).toBeLessThan(manSec + 0.5);
    expect(third.sec).toBeGreaterThan(lowSec - 0.4);
    expect(third.sec).toBeLessThan(lowSec + 0.5);
  });

  it('keeps a sentence that drops 25 dB in the middle', async () => {
    const soft = scale(man, 10 ** (-25 / 20));
    const clean = concat(silence(1), man, silence(0.4), soft, silence(0.4), man, silence(1));
    const phrases = await record(mix(clean, room(clean.length / RATE)));
    const total = phrases.reduce((a, p) => a + p.sec, 0);
    expect(total).toBeGreaterThan(3 * manSec - 0.5);
    expect(total).toBeLessThan(3 * manSec + 1.5);
  });

  it('records nothing from a fan, a humming fan, typing, or a hum switching on', async () => {
    expect(await record(fan(10, 0.056))).toEqual([]);
    expect(await record(fan(10, 0.056, { hum: true }))).toEqual([]);
    expect(await record(mix(clicks(6), fan(6, 0.005)))).toEqual([]);
    expect(await record(concat(fan(3, 0.001), fan(6, 0.05, { hum: true })))).toEqual([]);
  });
});
