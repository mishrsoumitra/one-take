/**
 * The voice detector on real speech (macOS text-to-speech) and on the sounds of a room: a fan, a
 * humming fan, hiss, typing, a tone, a sound switching on, gain creeping up. Then the whole live
 * path: 48 kHz microphone blocks through the scorer and the phrase detector.
 */
import { describe, expect, it } from 'vitest';

import { resampleLinear, type Samples } from '../src/core/pcm.js';
import { MicScorer, scoreClip, SPEECH_FRAME, SPEECH_KEEP, SPEECH_START } from '../src/core/speech.js';
import { VoiceActivityDetector, type PhraseResult } from '../src/core/vad.js';
import { VoiceDetector } from '../src/core/voice.js';

import {
  clicks,
  concat,
  fan,
  loudFrames,
  MALE_VOICE_URL,
  maxOf,
  mix,
  RATE,
  readWav,
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
const voices = [
  ['a woman', woman],
  ['a man', man],
] as const;

/** Frames after the first second: the floor has settled by then. */
const AFTER_START = Math.round(1 / (SPEECH_FRAME / RATE));

async function score(signal: Float32Array): Promise<Float32Array> {
  return scoreClip(new VoiceDetector(), toInt16(signal), RATE);
}

describe('VoiceDetector on speech', () => {
  it.each(voices)('hears %s as a voice most of the way through', async (_name, voice) => {
    const clean = concat(silence(1), voice, silence(1));
    const probs = await score(clean);
    expect(probs.length).toBe(Math.ceil(clean.length / SPEECH_FRAME));
    expect(share(probs, SPEECH_START, loudFrames(clean))).toBeGreaterThan(0.7);
    // and the silence around it as nothing
    const quietFrames = loudFrames(clean).map((loud) => !loud);
    expect(share(probs, SPEECH_KEEP, quietFrames)).toBeLessThan(0.25);
  });

  it.each(voices)('keeps hearing %s over a fan ten decibels under the voice', async (_name, voice) => {
    const clean = concat(silence(1), voice, silence(1));
    const noisy = withNoise(clean, fan(clean.length / RATE, 1), 10);
    const probs = await score(noisy);
    expect(share(probs, SPEECH_START, loudFrames(clean))).toBeGreaterThan(0.4);
    // the fan alone, before and after the voice, is never voice
    const before = probs.subarray(AFTER_START - 10, AFTER_START);
    const after = probs.subarray(probs.length - 15);
    expect(maxOf(before)).toBeLessThan(SPEECH_KEEP);
    expect(maxOf(after)).toBeLessThan(SPEECH_KEEP);
  });

  it('still hears the voice over a humming fan and over white noise', async () => {
    const clean = concat(silence(1), woman, silence(1));
    const seconds = clean.length / RATE;
    for (const noise of [fan(seconds, 1, { hum: true }), white(seconds, 1)]) {
      const probs = await score(withNoise(clean, noise, 10));
      expect(share(probs, SPEECH_START, loudFrames(clean))).toBeGreaterThan(0.4);
    }
  });

  it('drops the score within a few frames of the voice stopping', async () => {
    const clean = concat(silence(1), woman, fan(2, 0.03));
    const probs = await score(withNoise(clean, fan(clean.length / RATE, 1), 15));
    const end = Math.ceil((1 + woman.length / RATE) / (SPEECH_FRAME / RATE));
    expect(maxOf(probs, end + 6)).toBeLessThan(SPEECH_KEEP);
  });
});

describe('VoiceDetector on the sounds of a room', () => {
  it('hears nothing in a fan, a humming fan, hiss, typing or silence', async () => {
    for (const signal of [
      fan(8, 0.03),
      fan(8, 0.1),
      fan(8, 0.1, { hum: true }),
      fan(8, 0.1, { cutoffHz: 400 }),
      white(8, 0.03),
      clicks(8),
      silence(5),
    ]) {
      const probs = await score(signal);
      expect(maxOf(probs, AFTER_START)).toBeLessThan(SPEECH_KEEP);
    }
  });

  it('never starts a phrase on a fan that swells and fades', async () => {
    const probs = await score(fan(10, 0.05, { wobbleDb: 6 }));
    expect(maxOf(probs, AFTER_START)).toBeLessThan(SPEECH_START);
  });

  it('lets the floor follow the gain creeping up during a long pause', async () => {
    // automatic gain control raises a quiet room by 20 dB over ten seconds
    const creep = fan(10, 0.01);
    for (let i = 0; i < creep.length; i++)
      creep[i] = (creep[i] ?? 0) * Math.pow(10, (20 * i) / creep.length / 20);
    const probs = await score(creep);
    expect(maxOf(probs, AFTER_START)).toBeLessThan(SPEECH_KEEP);
  });

  it('does not take a fan switching on for a voice', async () => {
    const probs = await score(concat(fan(3, 0.001), fan(5, 0.05)));
    expect(maxOf(probs, AFTER_START)).toBeLessThan(SPEECH_START);
  });

  it('forgets a hum or a tone that switches on long before it could be a phrase', async () => {
    // the click of the switch-on can look like a voice for a frame or two; a phrase needs 200 ms
    for (const signal of [
      concat(fan(3, 0.001), fan(5, 0.05, { hum: true })),
      concat(silence(3), tone(5, 1000, 0.1)),
      concat(silence(3), tone(5, 150, 0.1)),
    ]) {
      const probs = await score(signal);
      let hot = 0;
      for (let k = AFTER_START; k < probs.length; k++) if ((probs[k] ?? 0) >= SPEECH_START) hot++;
      expect(hot).toBeLessThanOrEqual(4);
      // and once the sound has been on for two seconds it is the room
      expect(maxOf(probs, Math.round(5.5 / (SPEECH_FRAME / RATE)))).toBeLessThan(SPEECH_KEEP);
    }
  });

  it('reports what it measured on the latest frame', () => {
    const stream = new VoiceDetector().stream();
    const frame = new Float32Array(SPEECH_FRAME);
    stream.score(frame);
    expect(stream.features.snrDb).toBe(0);
    expect(stream.features.harmonicity).toBe(0);
    expect(stream.features.pitchHz).toBe(0);
    const t = tone(0.1, 120, 0.3);
    for (let at = 0; at + SPEECH_FRAME <= t.length; at += SPEECH_FRAME)
      stream.score(t.subarray(at, at + SPEECH_FRAME));
    expect(stream.features.pitchHz).toBeGreaterThan(110);
    expect(stream.features.pitchHz).toBeLessThan(130);
    expect(stream.features.harmonicity).toBeGreaterThan(0.7);
  });

  it('refuses a frame of the wrong size', () => {
    expect(() => new VoiceDetector().stream().score(new Float32Array(100))).toThrow(/512/);
  });
});

/** The live path: 48 kHz blocks through the scorer and the phrase detector, like the microphone. */
function record(signal16: Samples, threshold = -45): { at: number; sec: number; loudSec: number }[] {
  const mic = resampleLinear(signal16, RATE, 48000);
  const scorer = new MicScorer(new VoiceDetector());
  const phrases: { at: number; sec: number; loudSec: number }[] = [];
  let startAt = 0;
  let t = 0;
  const vad = new VoiceActivityDetector(
    10,
    { threshold, hangoverMs: 700, prerollMs: 200, tailMs: 150, minSpeechMs: 200 },
    {
      onSpeechStart: () => (startAt = t),
      onSpeechEnd: (p: PhraseResult | null) => {
        if (p)
          phrases.push({ at: startAt / 1000, sec: (p.blocks.length * 10) / 1000, loudSec: p.loudMs / 1000 });
      },
    },
  );
  for (let at = 0; at + 480 <= mic.length; at += 480, t += 10) {
    const block = mic.subarray(at, at + 480);
    scorer.push(block, 48000);
    vad.process(block, scorer.prob);
  }
  vad.end();
  return phrases;
}

describe('the live detector with the voice detector', () => {
  const womanSec = woman.length / RATE;
  const manSec = man.length / RATE;
  /** Quiet room, the woman, a fan, typing, the man, quiet. */
  const sequence = concat(silence(1), woman, silence(1.5), clicks(2), silence(1), man, silence(1));

  it('records the two speakers and nothing of the typing between them', () => {
    const phrases = record(sequence);
    expect(phrases).toHaveLength(2);
    const [first, second] = phrases as [(typeof phrases)[0], (typeof phrases)[0]];
    expect(first.at).toBeGreaterThan(0.9);
    expect(first.at).toBeLessThan(1.3);
    expect(first.sec).toBeGreaterThan(womanSec);
    expect(first.sec).toBeLessThan(womanSec + 0.5);
    expect(second.at).toBeGreaterThan(1 + womanSec + 4.5 - 0.1);
    expect(second.at).toBeLessThan(1 + womanSec + 4.5 + 0.3);
    expect(second.sec).toBeGreaterThan(manSec - 0.3);
    expect(second.sec).toBeLessThan(manSec + 0.5);
  });

  it('does the same with a fan running ten decibels under the voice', () => {
    const phrases = record(withNoise(sequence, fan(sequence.length / RATE, 1, { hum: true }), 10));
    expect(phrases.length).toBeGreaterThanOrEqual(2);
    expect(phrases.length).toBeLessThanOrEqual(4);
    const total = phrases.reduce((a, p) => a + p.sec, 0);
    expect(total).toBeGreaterThan((womanSec + manSec) * 0.8);
    expect(total).toBeLessThan(womanSec + manSec + 1.5);
    // nothing is a phrase during the typing
    for (const p of phrases) {
      const end = p.at + p.sec;
      expect(end < 1 + womanSec + 1.5 + 0.4 || p.at > 1 + womanSec + 3.5 - 0.3).toBe(true);
    }
  });

  it('records nothing from a fan, a humming fan, typing or a hum switching on', () => {
    expect(record(fan(10, 0.056))).toEqual([]);
    expect(record(fan(10, 0.056, { hum: true }))).toEqual([]);
    expect(record(mix(clicks(6), fan(6, 0.005)))).toEqual([]);
    expect(record(concat(fan(3, 0.001), fan(6, 0.05, { hum: true })))).toEqual([]);
  });
});
