/** Small, dependency-free audio helpers shared by capture, preview and export. */

/** Float samples backed by a plain ArrayBuffer (what Web Audio and WebCodecs accept). */
export type Samples = Float32Array<ArrayBuffer>;

export function floatBlocksToInt16(blocks: readonly Float32Array[]): Int16Array {
  let n = 0;
  for (const b of blocks) n += b.length;
  const out = new Int16Array(n);
  let o = 0;
  for (const b of blocks) {
    for (const sample of b) {
      const v = Math.max(-1, Math.min(1, sample));
      out[o++] = v < 0 ? v * 32768 : v * 32767;
    }
  }
  return out;
}

export function int16ToFloat(pcm: Int16Array): Samples {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = (pcm[i] ?? 0) / 32768;
  return out;
}

/** Linear-interpolation resampler; adequate for speech between the common 44.1/48 kHz rates. */
export function resampleLinear(input: Samples, from: number, to: number): Samples {
  if (from === to) return input;
  const n = Math.round((input.length * to) / from);
  const out = new Float32Array(n);
  const ratio = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const j = Math.floor(x);
    const t = x - j;
    const a = input[j] ?? 0;
    const b = input[j + 1] ?? a;
    out[i] = a + (b - a) * t;
  }
  return out;
}

/** Short linear fades at the edges so cuts between phrases never click. */
export function applyFades(
  samples: Float32Array,
  sampleRate: number,
  fadeIn: boolean,
  fadeOut: boolean,
  ms = 8,
): void {
  const n = Math.min(samples.length >> 1, Math.round((sampleRate * ms) / 1000));
  if (fadeIn) for (let i = 0; i < n; i++) samples[i] = (samples[i] ?? 0) * (i / n);
  if (fadeOut) {
    for (let i = 0; i < n; i++) {
      const k = samples.length - 1 - i;
      samples[k] = (samples[k] ?? 0) * (i / n);
    }
  }
}

/** RMS level of a block in dBFS; silence is about -90. */
export function rmsDb(block: Float32Array): number {
  let sum = 0;
  for (const v of block) sum += v * v;
  return 20 * Math.log10(Math.sqrt(sum / Math.max(1, block.length)) + 1e-7);
}

/** Converts a stored segment to floats at the wanted rate, with fades applied. */
export function segmentToFloat(
  pcm: Int16Array,
  sampleRate: number,
  targetRate: number,
  fadeIn: boolean,
  fadeOut: boolean,
): Samples {
  const floats = resampleLinear(int16ToFloat(pcm), sampleRate, targetRate);
  applyFades(floats, targetRate, fadeIn, fadeOut);
  return floats;
}
