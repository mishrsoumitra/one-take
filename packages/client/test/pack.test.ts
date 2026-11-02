import { describe, expect, it } from 'vitest';

import { type Segment } from '../src/core/timeline.js';
import { packSegment, phraseMeta, unpackSegment } from '../src/storage/pack.js';

function sample(n: number, seed: number): Int16Array {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = ((i * 7919 + seed) % 65536) - 32768;
  return out;
}

function bytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

/** A phrase with every kind of thing a phrase can carry. */
function full(): Segment {
  return {
    id: '1700000000000-3',
    slide: 2,
    sampleRate: 48000,
    pcm: sample(4801, 1),
    raw: sample(4801, 2),
    deep: sample(4801, 3),
    voice: sample(4801, 4),
    joined: true,
    prevId: '1700000000000-2',
    createdAt: 1700000000123,
    sitting: 2,
    choice: 'voice',
    speaker: {
      verdict: 'unsure',
      similarity: 0.61,
      lips: 'still',
      reasons: ['Voice in between (61% match)'],
    },
    faces: { fps: 25, frames: 3, data: bytes(301, 9) },
    video: {
      codec: 'avc1.42E01F',
      width: 640,
      height: 360,
      pieces: [
        {
          startUs: 120_000,
          durationUs: 1_880_000,
          rate: 1,
          frames: [
            { key: true, timestamp: 0, duration: 40_000, data: bytes(1203, 5) },
            { key: false, timestamp: 40_000, duration: 40_000, data: bytes(77, 6) },
          ],
        },
        {
          startUs: -5,
          durationUs: 500_000,
          rate: 1.5,
          frames: [{ key: true, timestamp: 0, duration: 1, data: bytes(1, 7) }],
        },
      ],
    },
    ink: {
      wipe: false,
      strokes: [
        {
          tool: 'pen',
          color: '#ff3b30',
          width: 0.005,
          points: [
            { x: 0.1, y: 0.2, t: 0 },
            { x: 0.3, y: 0.4, t: 120 },
          ],
        },
      ],
    },
  };
}

describe('packSegment / unpackSegment', () => {
  it('round-trips a phrase with every field, arrays in buffers of their own', () => {
    const seg = full();
    const packed = packSegment(seg);
    expect(String.fromCharCode(...packed.subarray(0, 4))).toBe('OTP1');
    const back = unpackSegment(packed);
    expect(back).toEqual(seg);
    expect(back.pcm).toBeInstanceOf(Int16Array);
    expect(back.raw).toBeInstanceOf(Int16Array);
    expect(back.video?.pieces[0]?.frames[0]?.data).toBeInstanceOf(Uint8Array);
    expect(back.faces?.data).toBeInstanceOf(Uint8Array);
    // each array owns its buffer: changing one leaves the file and the others alone
    expect(back.pcm.byteOffset).toBe(0);
    expect(back.pcm.buffer.byteLength).toBe(back.pcm.byteLength);
    back.pcm[0] = 1;
    expect(unpackSegment(packed).pcm[0]).toBe(seg.pcm[0]);
    // the file is the same for the same phrase, so its hash names its content
    expect(packSegment(full())).toEqual(packed);
  });

  it('keeps a plain phrase small and leaves out undefined fields', () => {
    const seg: Segment = {
      id: 'a',
      slide: 0,
      sampleRate: 16000,
      pcm: sample(160, 0),
      joined: false,
      prevId: null,
      createdAt: 1,
      video: null,
      raw: undefined,
    };
    const packed = packSegment(seg);
    expect(packed.byteLength).toBeLessThan(160 * 2 + 200);
    const back = unpackSegment(packed);
    expect(back).toEqual({
      id: 'a',
      slide: 0,
      sampleRate: 16000,
      pcm: seg.pcm,
      joined: false,
      prevId: null,
      createdAt: 1,
      video: null,
    });
    expect('raw' in back).toBe(false);
  });

  it('works on a view into a larger buffer', () => {
    const seg = full();
    const packed = packSegment(seg);
    const wrapped = new Uint8Array(packed.byteLength + 7);
    wrapped.set(packed, 3);
    expect(unpackSegment(wrapped.subarray(3, 3 + packed.byteLength))).toEqual(seg);
  });

  it('refuses what is not a phrase file', () => {
    expect(() => unpackSegment(new Uint8Array([1, 2, 3]))).toThrow(/not a One Take phrase file/);
    expect(() => unpackSegment(new TextEncoder().encode('OTP1xxxxjunk'))).toThrow();
    const packed = packSegment(full());
    // a header that says the blobs are longer than the file
    const cut = packed.slice(0, packed.byteLength - 100);
    expect(() => unpackSegment(cut)).toThrow(/past the end/);
    // a file of the right shape whose header is not a phrase
    const header = new TextEncoder().encode(JSON.stringify({ v: 1, seg: { hello: 1 }, blobs: [] }));
    const bad = new Uint8Array(8 + header.byteLength);
    bad.set(new TextEncoder().encode('OTP1'), 0);
    new DataView(bad.buffer).setUint32(4, header.byteLength, true);
    bad.set(header, 8);
    expect(() => unpackSegment(bad)).toThrow(/not a phrase/);
  });

  it('describes the phrase for the manifest', () => {
    const seg = full();
    expect(phraseMeta(seg)).toEqual({
      slide: 2,
      seconds: 4801 / 48000,
      sitting: 2,
      kind: 'ink',
      camera: true,
      createdAt: 1700000000123,
    });
    const { ink: _ink, video: _video, sitting: _sitting, ...voice } = seg;
    expect(phraseMeta(voice)).toMatchObject({ kind: 'voice', camera: false, sitting: 1 });
  });
});
