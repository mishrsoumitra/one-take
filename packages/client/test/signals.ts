/**
 * Signals for the voice tests: spoken fixtures (macOS text-to-speech at 16 kHz) and synthetic room
 * sounds. Everything random is seeded, so a test hears the same thing every run.
 */
import fs from 'node:fs';

import { type Samples } from '../src/core/pcm.js';
import { SPEECH_FRAME, SPEECH_RATE } from '../src/core/speech.js';

export const RATE = SPEECH_RATE;

/** A woman's voice (Samantha), 4.8 s. */
export const VOICE_URL = new URL('./fixtures/voice-16k.wav', import.meta.url);
/** A man's voice (Daniel), 6.5 s. */
export const MALE_VOICE_URL = new URL('./fixtures/voice-male-16k.wav', import.meta.url);
/** A deep voice (Daniel with the pitch base at 58 Hz, under a 70 Hz pitch floor), 4.9 s. */
export const LOW_VOICE_URL = new URL('./fixtures/voice-low-16k.wav', import.meta.url);

/** 16-bit mono PCM out of a RIFF file. */
export function readWav(url: URL): Int16Array {
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

export function toFloat(pcm: Int16Array): Samples {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = (pcm[i] ?? 0) / 32768;
  return out;
}

export function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++)
    out[i] = Math.round(Math.max(-1, Math.min(1, samples[i] ?? 0)) * 32767);
  return out;
}

export function rms(x: Float32Array, from = 0, to = x.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += (x[i] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, to - from));
}

export function db(x: Float32Array): number {
  return 20 * Math.log10(rms(x) + 1e-9);
}

/** A seeded source of noise; one per signal so the signals do not depend on the order they are made in. */
export class Noise {
  constructor(private seed: number) {}

  /** Uniform in [-1, 1). The multiply is done in 32 bits: in floating point it loses digits and the
   * sequence can fall into a short cycle (seed 9 repeated every 220 samples, a 73 Hz buzz). */
  next(): number {
    this.seed = (Math.imul(this.seed, 1103515245) + 12345) & 0x7fffffff;
    return (this.seed / 0x7fffffff) * 2 - 1;
  }

  /** Roughly Gaussian, unit variance. */
  gauss(): number {
    return (this.next() + this.next() + this.next()) / Math.sqrt(3);
  }
}

export function silence(seconds: number): Samples {
  return new Float32Array(Math.round(seconds * RATE));
}

export function tone(seconds: number, hz: number, amp: number): Samples {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / RATE);
  return out;
}

/** White noise at an RMS level. */
export function white(seconds: number, amp: number, seed = 1): Samples {
  const noise = new Noise(seed);
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) out[i] = noise.gauss() * amp;
  return out;
}

export interface FanOptions {
  /** Add a blade hum at 100 Hz with two harmonics. */
  hum?: boolean;
  /** Slow swell and fade of this many dB, three times every ten seconds. */
  wobbleDb?: number;
  /** Where the rumble rolls off; 200 Hz is a desk fan, 400 Hz a louder, hissier one. */
  cutoffHz?: number;
  seed?: number;
}

/** A fan: low rumble (one-pole low-passed noise) under a bed of hiss, at an RMS level. */
export function fan(seconds: number, amp: number, options: FanOptions = {}): Samples {
  const noise = new Noise(options.seed ?? 2);
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  const a = Math.exp((-2 * Math.PI * (options.cutoffHz ?? 200)) / RATE);
  const wobble = options.wobbleDb ?? 1;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    lp = a * lp + (1 - a) * noise.gauss();
    let v = lp * 6 + noise.gauss() * 0.12;
    if (options.hum) {
      v +=
        0.3 * Math.sin(2 * Math.PI * 100 * t) +
        0.15 * Math.sin(2 * Math.PI * 200 * t) +
        0.08 * Math.sin(2 * Math.PI * 300 * t);
    }
    out[i] = v * Math.pow(10, (wobble * Math.sin(2 * Math.PI * 0.3 * t)) / 20);
  }
  const r = rms(out);
  for (let i = 0; i < n; i++) out[i] = ((out[i] ?? 0) / r) * amp;
  return out;
}

/** Keyboard-like typing: a 4 ms burst every 300 ms, loud enough to cross any speech line. */
export function clicks(seconds: number, amp = 0.6, seed = 7): Samples {
  const noise = new Noise(seed);
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const phase = t % 0.3;
    if (phase < 0.004) out[i] = noise.gauss() * amp * Math.exp(-phase * 800);
  }
  return out;
}

export function concat(...parts: Float32Array[]): Samples {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** The sum of the signals, as long as the longest. */
export function mix(...parts: Float32Array[]): Samples {
  const out = new Float32Array(Math.max(...parts.map((p) => p.length)));
  for (const p of parts) for (let i = 0; i < p.length; i++) out[i] = (out[i] ?? 0) + (p[i] ?? 0);
  return out;
}

export function scale(x: Float32Array, gain: number): Samples {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = (x[i] ?? 0) * gain;
  return out;
}

/** `voice` with `noise` mixed in at `snrDb` below the voice's level. */
export function withNoise(voice: Float32Array, noise: Float32Array, snrDb: number): Samples {
  return mix(voice, scale(noise, (rms(voice) / rms(noise)) * Math.pow(10, -snrDb / 20)));
}

/** Which frames of a clean recording hold a loud voice (RMS over -35 dBFS), one flag per frame. */
export function loudFrames(clean: Float32Array): boolean[] {
  const out: boolean[] = [];
  for (let at = 0; at + SPEECH_FRAME <= clean.length; at += SPEECH_FRAME)
    out.push(rms(clean, at, at + SPEECH_FRAME) > 0.0178);
  return out;
}

/** The share of frames in `probs` scored at least `level`, over the frames `mask` flags (all when omitted). */
export function share(probs: ArrayLike<number>, level: number, mask?: readonly boolean[]): number {
  let n = 0;
  let hit = 0;
  for (let k = 0; k < probs.length; k++) {
    if (mask && !mask[k]) continue;
    n++;
    if ((probs[k] ?? 0) >= level) hit++;
  }
  return n === 0 ? 0 : hit / n;
}

export function maxOf(probs: ArrayLike<number>, fromFrame = 0): number {
  let max = 0;
  for (let k = fromFrame; k < probs.length; k++) max = Math.max(max, probs[k] ?? 0);
  return max;
}
