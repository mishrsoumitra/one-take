/**
 * Telling the speaker's voice from another one.
 *
 * A speaker-embedding model turns a stretch of speech into a vector of 256 numbers that says what
 * the voice sounds like and, as far as the model can manage, nothing about what was said. Two
 * stretches of the same voice give vectors that point the same way; two voices give vectors that do
 * not. The model is WeSpeaker's ResNet34 trained on VoxCeleb (the ONNX file sherpa-onnx publishes),
 * fed Kaldi's log mel filterbank with the mean taken out (`fbank.ts`); it runs in a worker through
 * onnxruntime-web, and this file holds the arithmetic around it that the tests can run in Node.
 *
 * **Enrollment.** At first launch the speaker reads for twenty seconds. The voice heard in them is
 * cut into windows, each window gets its vector, and their mean is the voice profile. It is kept in
 * this browser; it never leaves the machine.
 *
 * **A phrase.** While a phrase is being spoken its audio is embedded window by window as it comes
 * (`embeddingWindows` says which stretches), so that when the phrase ends only the tail is left to
 * do and the verdict is ready within a second. The phrase's vector is the mean of its windows'.
 *
 * **The comparison** is the cosine between the phrase's vector and the profile: 1 for the same
 * direction, 0 for unrelated. On the model's own test speakers the same voice scores 0.5 to 0.9 and
 * another voice 0.4 at most (median 0.14); the two bars below leave a band of doubt between them.
 */

/** The model file, where it is published, and what to check it against. */
export const SPEAKER_MODEL = {
  name: 'wespeaker_en_voxceleb_resnet34_LM.onnx',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx',
  sha256: 'e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012',
  bytes: 26_530_550,
  /** Numbers in a vector. */
  dim: 256,
  /** The graph's input and output names. */
  input: 'feats',
  output: 'embs',
} as const;

/** A cosine at or over this is the speaker's own voice. */
export const VOICE_MATCH = 0.5;
/** A cosine at or under this is another voice; between the two bars is doubt. */
export const VOICE_OTHER = 0.35;

/** How long an enrollment listens, in seconds, and the least voice it needs to hear in that time. */
export const ENROLL_SEC = 20;
export const ENROLL_MIN_VOICE_SEC = 8;

/** A phrase is embedded over windows this long, a new one every `hop` seconds of speech. */
export const WINDOW_SEC = 4;
export const HOP_SEC = 2;
/** The tail left after the last window is embedded on its own only when it is at least this long. */
export const TAIL_MIN_SEC = 0.8;
/** Less speech than this says nothing about a voice. */
export const MIN_SPEECH_SEC = 0.8;

export type VoiceOpinion = 'you' | 'other' | 'unsure';

/** What the cosine says on its own. */
export function voiceOpinion(similarity: number): VoiceOpinion {
  if (similarity >= VOICE_MATCH) return 'you';
  if (similarity <= VOICE_OTHER) return 'other';
  return 'unsure';
}

/** The speaker's voice as enrolled: the mean vector, how much voice went into it, and which model made it. */
export interface VoiceProfile {
  model: string;
  embedding: number[];
  seconds: number;
  createdAt: number;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

/** A vector as it is stored (plain numbers) or as the model gives it (a typed array). */
export type Vector = ArrayLike<number> & Iterable<number>;

/** The vector scaled to length one. */
export function unit(v: Vector): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  const out = new Float32Array(v.length);
  const scale = n > 0 ? 1 / Math.sqrt(n) : 0;
  let i = 0;
  for (const x of v) out[i++] = x * scale;
  return out;
}

/**
 * The mean direction of several vectors, each weighted by how much speech it came from (a 4 s window
 * says more than a 1 s tail). Each is scaled to length one first so a loud window does not outweigh
 * a quiet one; the result has length one too.
 */
export function meanEmbedding(vectors: readonly { embedding: Vector; seconds: number }[]): Float32Array {
  const dim = vectors[0]?.embedding.length ?? 0;
  const sum = new Float64Array(dim);
  for (const { embedding, seconds } of vectors) {
    const u = unit(embedding);
    const w = Math.max(0, seconds);
    for (let i = 0; i < dim; i++) sum[i] = (sum[i] ?? 0) + w * (u[i] ?? 0);
  }
  return unit(sum);
}

/** A stretch of a phrase to embed, in seconds from the phrase's start. */
export interface Window {
  from: number;
  to: number;
}

/**
 * Which stretches of a phrase to embed. With `done` seconds already covered by earlier windows and
 * `heard` seconds of speech now in hand, returns every window that has become due: one ending at
 * each multiple of {@link HOP_SEC} up to `heard`, each reaching back {@link WINDOW_SEC}. With `final`
 * (the phrase has ended), the tail past the last window is embedded on its own when it is at least
 * {@link TAIL_MIN_SEC}; a phrase shorter than a hop is embedded whole as long as it clears
 * {@link MIN_SPEECH_SEC}.
 */
export function embeddingWindows(done: number, heard: number, final: boolean): Window[] {
  const out: Window[] = [];
  let end = done;
  for (let next = (Math.floor(done / HOP_SEC) + 1) * HOP_SEC; next <= heard + 1e-9; next += HOP_SEC) {
    out.push({ from: Math.max(0, next - WINDOW_SEC), to: next });
    end = next;
  }
  if (final) {
    const tail = heard - end;
    if (end === 0 ? heard >= MIN_SPEECH_SEC : tail >= TAIL_MIN_SEC) {
      out.push({ from: Math.max(0, heard - WINDOW_SEC), to: heard });
    }
  }
  return out;
}
