import { describe, expect, it } from 'vitest';

import { type Segment } from '../src/core/timeline.js';
import {
  audioOf,
  chosenVoicing,
  describeVersion,
  hasVersion,
  joinAudio,
  mapAudio,
  versionBytes,
  withVersion,
} from '../src/core/versions.js';

function seg(extra: Partial<Segment> = {}): Segment {
  return {
    id: 's',
    slide: 0,
    sampleRate: 48000,
    pcm: Int16Array.from([1, 2, 3, 4]),
    joined: false,
    prevId: null,
    createdAt: 0,
    ...extra,
  };
}

describe('versions', () => {
  it('plays Cleaned by default, the kept voice when the phrase was flagged, and the clip’s own choice first', () => {
    const plain = seg({ raw: Int16Array.from([9, 9, 9, 9]) });
    expect(chosenVoicing(plain)).toBe('cleaned');
    expect(audioOf(plain)).toBe(plain.pcm);
    const kept = seg({
      voice: Int16Array.from([5, 5, 5, 5]),
      speaker: { verdict: 'other', similarity: 0.1, lips: null, reasons: [] },
    });
    expect(chosenVoicing(kept)).toBe('voice');
    expect(audioOf(kept)).toBe(kept.voice);
    const chosen = seg({ ...kept, choice: 'original' });
    expect(chosenVoicing(chosen)).toBe('original');
    expect(audioOf(chosen)).toBe(chosen.pcm); // no raw copy: the live version stands in
  });

  it('falls back version by version', () => {
    const s = seg({ raw: Int16Array.from([7, 7, 7, 7]), deep: Int16Array.from([8, 8, 8, 8]) });
    expect(audioOf(s, 'original')).toBe(s.raw);
    expect(audioOf(s, 'cleaned')).toBe(s.deep);
    expect(audioOf(s, 'voice')).toBe(s.deep);
    expect(hasVersion(s, 'voice')).toBe(false);
    expect(describeVersion(s, 'cleaned')).toBe('deep clean');
    expect(describeVersion(seg(), 'cleaned')).toBe('live filter');
    expect(describeVersion(s, 'voice')).toBe('not made yet');
  });

  it('applies an edit to every version and drops one that comes out a different length', () => {
    const s = seg({ raw: Int16Array.from([9, 9, 9, 9]), deep: Int16Array.from([8, 8, 8]) });
    const cut = mapAudio(s, (pcm) => pcm.slice(1));
    expect(cut?.pcm).toEqual(Int16Array.from([2, 3, 4]));
    expect(cut?.raw).toEqual(Int16Array.from([9, 9, 9]));
    expect(cut?.deep).toBeUndefined(); // was out of step already
    expect(mapAudio(s, () => null)).toBeNull();
  });

  it('joins only the versions both clips have', () => {
    const a = seg({ raw: Int16Array.from([1, 1]), deep: Int16Array.from([2, 2]) });
    const b = seg({ raw: Int16Array.from([3, 3]) });
    const joined = joinAudio(a, b, (x, y) => Int16Array.from([...x, ...y]));
    expect(joined.pcm.length).toBe(8);
    expect(joined.raw).toEqual(Int16Array.from([1, 1, 3, 3]));
    expect(joined.deep).toBeUndefined();
  });

  it('puts a studio result in place only when it lines up', () => {
    const s = seg();
    expect(withVersion(s, 'deep', Int16Array.from([0, 0, 0, 0])).deep?.length).toBe(4);
    expect(() => withVersion(s, 'voice', Int16Array.from([0]))).toThrow(/samples/);
    expect(versionBytes(seg({ raw: Int16Array.from([1, 1, 1, 1]) }))).toBe(16);
  });
});
