/**
 * The versions of a clip's sound, and which one plays.
 *
 * A phrase is recorded twice over: as the microphone heard it (`raw`, before any filter) and as
 * the live noise filter cleaned it (`pcm`, what the app has always kept). The studio can add two
 * more from the raw one: the deep clean (`deep`) and only the speaker's voice (`voice`). All four
 * line up sample for sample, so a cut, a split or a re-record made on one is made on all of them,
 * and the editor can switch a clip between **Original**, **Cleaned** and **Only my voice** and hear
 * the same stretch each way.
 *
 * - Original is the raw microphone; a phrase recorded with the filter off, or by an older version,
 *   has no separate raw and plays `pcm`.
 * - Cleaned is the deep clean once it has run, and the live filter's version until then.
 * - Only my voice is the studio's extraction once it has run; until then it falls back to Cleaned.
 *
 * A clip remembers the choice (`choice`); without one, a clip whose voice has been kept because
 * another voice was heard in it plays that, and every other clip plays Cleaned.
 */
import { type Segment } from './timeline.js';

export type Voicing = 'original' | 'cleaned' | 'voice';

export const VOICINGS: readonly Voicing[] = ['original', 'cleaned', 'voice'];

export const VOICING_LABELS: Record<Voicing, string> = {
  original: 'Original',
  cleaned: 'Cleaned',
  voice: 'Only my voice',
};

/** Every field of a segment that holds audio; all of them line up with `pcm`. */
export const AUDIO_FIELDS = ['pcm', 'raw', 'deep', 'voice'] as const;
export type AudioField = (typeof AUDIO_FIELDS)[number];

/** A phrase the checks marked as another voice, or as not surely the speaker's. */
export function flagged(seg: Segment): boolean {
  return seg.speaker !== undefined && seg.speaker.verdict !== 'you';
}

/** The version a clip plays: its own choice, else its kept voice when it was flagged, else Cleaned. */
export function chosenVoicing(seg: Segment): Voicing {
  if (seg.choice) return seg.choice;
  return seg.voice && flagged(seg) ? 'voice' : 'cleaned';
}

/** Whether the version is there as its own audio (Original and Cleaned always are: `pcm` stands in). */
export function hasVersion(seg: Segment, voicing: Voicing): boolean {
  switch (voicing) {
    case 'original':
      return true;
    case 'cleaned':
      return true;
    case 'voice':
      return seg.voice !== undefined;
  }
}

/** The audio of a version, falling back as described above. */
export function audioOf(seg: Segment, voicing: Voicing = chosenVoicing(seg)): Int16Array {
  switch (voicing) {
    case 'original':
      return seg.raw ?? seg.pcm;
    case 'cleaned':
      return seg.deep ?? seg.pcm;
    case 'voice':
      return seg.voice ?? seg.deep ?? seg.pcm;
  }
}

/** What a version is made of right now, for the editor's switch: `live filter`, `deep clean`. */
export function describeVersion(seg: Segment, voicing: Voicing): string {
  switch (voicing) {
    case 'original':
      return seg.raw ? 'the microphone, no filter' : 'as recorded (no separate raw copy)';
    case 'cleaned':
      return seg.deep ? 'deep clean' : 'live filter';
    case 'voice':
      return seg.voice ? 'the studio kept your voice' : 'not made yet';
  }
}

/**
 * Applies the same sample operation to every version of a clip. `fn` gets each version's audio and
 * returns the new audio, or null when nothing worth keeping is left (then the whole clip is null).
 * Versions that are not there stay not there; one that comes out a different length is dropped.
 */
export function mapAudio(seg: Segment, fn: (pcm: Int16Array) => Int16Array | null): Segment | null {
  const pcm = fn(seg.pcm);
  if (pcm === null) return null;
  const { raw: _raw, deep: _deep, voice: _voice, ...rest } = seg;
  const next: Segment = { ...rest, pcm };
  const map = (audio: Int16Array | undefined): Int16Array | undefined => {
    if (!audio) return undefined;
    const mapped = fn(audio);
    return mapped !== null && mapped.length === pcm.length ? mapped : undefined;
  };
  const raw = map(seg.raw);
  if (raw) next.raw = raw;
  const deep = map(seg.deep);
  if (deep) next.deep = deep;
  const voice = map(seg.voice);
  if (voice) next.voice = voice;
  return next;
}

/** Joins two clips' versions back to back with `join`, keeping only the versions both have. */
export function joinAudio(
  a: Segment,
  b: Segment,
  join: (x: Int16Array, y: Int16Array) => Int16Array,
): Pick<Segment, AudioField> {
  const out: Pick<Segment, AudioField> = { pcm: join(a.pcm, b.pcm) };
  for (const field of AUDIO_FIELDS) {
    if (field === 'pcm') continue;
    const x = a[field];
    const y = b[field];
    if (x && y) out[field] = join(x, y);
  }
  return out;
}

/** A clip with one version put in place (the studio's result, say). The audio must line up with `pcm`. */
export function withVersion(seg: Segment, field: 'deep' | 'voice' | 'raw', audio: Int16Array): Segment {
  if (audio.length !== seg.pcm.length) {
    throw new Error(`the ${field} version has ${audio.length} samples, the clip ${seg.pcm.length}`);
  }
  return { ...seg, [field]: audio };
}

/** Bytes a clip's versions take in memory. */
export function versionBytes(seg: Segment): number {
  let n = 0;
  for (const field of AUDIO_FIELDS) n += (seg[field]?.length ?? 0) * 2;
  return n;
}
