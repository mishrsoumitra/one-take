import { describe, expect, it } from 'vitest';

import { cutRanges, EDGE_SLACK_SEC, speechRanges, trimSilences, type Range } from '../src/core/silence.js';
import { SPEECH_FRAME_SEC } from '../src/core/speech.js';
import { type Segment } from '../src/core/timeline.js';

const settings = { hangoverMs: 700, prerollMs: 200, tailMs: 150, minSpeechMs: 200 };
const F = SPEECH_FRAME_SEC; // 0.032 s
const RATE = 16000;

/** One score per frame from runs of (score, frames). */
function scores(...runs: [score: number, frames: number][]): Float32Array {
  const out: number[] = [];
  for (const [p, n] of runs) for (let i = 0; i < n; i++) out.push(p);
  return Float32Array.from(out);
}

function seg(id: string, seconds: number, extra: Partial<Segment> = {}): Segment {
  const pcm = new Int16Array(Math.round(seconds * RATE));
  for (let i = 0; i < pcm.length; i++) pcm[i] = i % 2 === 0 ? 1000 : -1000;
  return { id, slide: 0, sampleRate: RATE, pcm, joined: false, prevId: null, createdAt: 1, ...extra };
}

function ids(): () => string {
  let n = 0;
  return () => `new${++n}`;
}

function dur(s: Segment): number {
  return s.pcm.length / s.sampleRate;
}

describe('speechRanges', () => {
  it('finds nothing in silence', () => {
    expect(speechRanges(scores([0.02, 300]), 300 * F, settings)).toEqual([]);
  });

  it('pads one stretch of voice with the pre-roll and tail, inside the clip', () => {
    const probs = scores([0.9, 32], [0.02, 100]);
    const total = probs.length * F;
    expect(speechRanges(probs, total, settings)).toEqual([{ from: 0, to: 32 * F + 0.15 }]);
    // the voice starts later: pre-roll in front
    const later = scores([0.02, 50], [0.9, 32], [0.02, 100]);
    expect(speechRanges(later, later.length * F, settings)).toEqual([
      { from: 50 * F - 0.2, to: 82 * F + 0.15 },
    ]);
  });

  it('splits at a pause longer than the hangover and not at a shorter one', () => {
    const long = scores([0.9, 32], [0.02, 31], [0.9, 32]); // 0.992 s pause
    const ranges = speechRanges(long, long.length * F, settings);
    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toEqual({ from: 0, to: 32 * F + 0.15 });
    expect(ranges[1]).toEqual({ from: 63 * F - 0.2, to: 95 * F });
    const short = scores([0.9, 32], [0.02, 15], [0.9, 32]); // 0.48 s pause
    expect(speechRanges(short, short.length * F, settings)).toEqual([{ from: 0, to: 79 * F }]);
  });

  it('drops a blip shorter than the minimum phrase', () => {
    const probs = scores([0.02, 20], [0.9, 3], [0.02, 100]);
    expect(speechRanges(probs, probs.length * F, settings)).toEqual([]);
  });

  it('needs the start score to begin but only the keep score to go on', () => {
    const never = scores([0.45, 100]);
    expect(speechRanges(never, never.length * F, settings)).toEqual([]);
    const dips = scores([0.9, 10], [0.4, 40], [0.02, 100]);
    expect(speechRanges(dips, dips.length * F, settings)).toEqual([{ from: 0, to: 50 * F + 0.15 }]);
  });

  it('merges stretches whose padding overlaps', () => {
    const tight = { ...settings, hangoverMs: 300 }; // hangover shorter than pre-roll plus tail
    const probs = scores([0.9, 10], [0.02, 10], [0.9, 10], [0.02, 50]);
    const ranges = speechRanges(probs, probs.length * F, tight);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.from).toBe(0);
    expect(ranges[0]?.to).toBeCloseTo(30 * F + 0.15, 6);
  });

  it('never runs past the end of the clip', () => {
    const probs = scores([0.9, 10]);
    expect(speechRanges(probs, 0.3, settings)).toEqual([{ from: 0, to: 0.3 }]);
  });
});

describe('cutRanges', () => {
  it('leaves a sliver at either end alone and says when an end was cut', () => {
    const whole = cutRanges([{ from: 0.1, to: 4.9 }], 5);
    expect(whole.keep).toEqual([{ from: 0, to: 5 }]);
    expect(whole.startCut).toBe(false);
    expect(whole.endCut).toBe(false);
    const tail = cutRanges([{ from: 0, to: 3 }], 5);
    expect(tail.keep).toEqual([{ from: 0, to: 3 }]);
    expect(tail.endCut).toBe(true);
    expect(tail.startCut).toBe(false);
    const head = cutRanges([{ from: 1, to: 5 }], 5);
    expect(head.startCut).toBe(true);
    expect(head.endCut).toBe(false);
  });

  it('clamps to the clip and drops what is left empty', () => {
    const cut = cutRanges(
      [
        { from: -1, to: 0.5 },
        { from: 2, to: 9 },
        { from: 6, to: 6 },
      ],
      4,
    );
    expect(cut.keep).toEqual([
      { from: 0, to: 0.5 },
      { from: 2, to: 4 },
    ]);
  });

  it('reports nothing kept as both ends cut', () => {
    const none = cutRanges([], 3);
    expect(none.keep).toEqual([]);
    expect(none.startCut).toBe(true);
    expect(none.endCut).toBe(true);
  });
});

describe('trimSilences', () => {
  it('leaves a clip alone when its voice covers it, as the same object', () => {
    const a = seg('a', 3);
    const ranges = new Map<string, Range[]>([['a', [{ from: 0, to: 3 }]]]);
    const result = trimSilences([a], ranges, ids());
    expect(result.segments[0]).toBe(a);
    expect(result.changed).toBe(0);
    expect(result.removedSec).toBe(0);
  });

  it('leaves a clip without a verdict alone', () => {
    const a = seg('a', 3);
    expect(trimSilences([a], new Map(), ids()).segments[0]).toBe(a);
  });

  it('cuts a long silent tail and keeps the id and the join', () => {
    const a = seg('a', 12, { joined: true, prevId: 'z' });
    const ranges = new Map<string, Range[]>([['a', [{ from: 0, to: 2.15 }]]]);
    const result = trimSilences([a], ranges, ids());
    expect(result.segments).toHaveLength(1);
    const piece = result.segments[0]!;
    expect(piece.id).toBe('a');
    expect(piece.joined).toBe(true);
    expect(piece.prevId).toBe('z');
    expect(dur(piece)).toBeCloseTo(2.15, 4);
    expect(piece.pcm[0]).toBe(a.pcm[0]);
    expect(result.removedSec).toBeCloseTo(9.85, 4);
    expect(result.changed).toBe(1);
  });

  it('ignores slivers of silence at either end', () => {
    const a = seg('a', 5, { joined: true, prevId: 'z' });
    const ranges = new Map<string, Range[]>([
      ['a', [{ from: EDGE_SLACK_SEC / 2, to: 5 - EDGE_SLACK_SEC / 2 }]],
    ]);
    const result = trimSilences([a], ranges, ids());
    expect(result.segments[0]).toBe(a);
    expect(result.changed).toBe(0);
  });

  it('splits a clip at a pause inside it; the last piece keeps the id so the next clip still continues it', () => {
    const a = seg('a', 10);
    const b = seg('b', 2, { joined: true, prevId: 'a' });
    const ranges = new Map<string, Range[]>([
      [
        'a',
        [
          { from: 0, to: 3 },
          { from: 6, to: 10 },
        ],
      ],
    ]);
    const result = trimSilences([a, b], ranges, ids());
    expect(result.segments.map((s) => s.id)).toEqual(['new1', 'a', 'b']);
    const [first, last, next] = result.segments as [Segment, Segment, Segment];
    expect(dur(first)).toBeCloseTo(3, 4);
    expect(first.joined).toBe(false);
    expect(dur(last)).toBeCloseTo(4, 4);
    expect(last.joined).toBe(false);
    expect(last.prevId).toBeNull();
    expect(last.pcm[0]).toBe(a.pcm[6 * RATE]);
    expect(next).toBe(b);
    expect(result.removedSec).toBeCloseTo(3, 4);
    expect(result.changed).toBe(1);
  });

  it('breaks the join of the clip after one whose end was cut', () => {
    const a = seg('a', 10);
    const b = seg('b', 2, { joined: true, prevId: 'a' });
    const c = seg('c', 2, { joined: true, prevId: 'b' });
    const ranges = new Map<string, Range[]>([['a', [{ from: 0, to: 4 }]]]);
    const result = trimSilences([a, b, c], ranges, ids());
    expect(result.segments.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    const next = result.segments[1]!;
    expect(next).not.toBe(b);
    expect(next.joined).toBe(false);
    expect(next.prevId).toBeNull();
    expect(next.pcm).toBe(b.pcm);
    expect(result.segments[2]).toBe(c);
  });

  it('removes a clip that is all silence and unjoins the one after it', () => {
    const a = seg('a', 3);
    const b = seg('b', 2, { joined: true, prevId: 'a' });
    const ranges = new Map<string, Range[]>([['a', []]]);
    const result = trimSilences([a, b], ranges, ids());
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.id).toBe('b');
    expect(result.segments[0]?.joined).toBe(false);
    expect(result.removedSec).toBe(3);
    expect(result.changed).toBe(1);
  });

  it('keeps the join in front only when nothing was cut in front', () => {
    const a = seg('a', 6, { joined: true, prevId: 'z' });
    const ranges = new Map<string, Range[]>([['a', [{ from: 1, to: 6 }]]]);
    const piece = trimSilences([a], ranges, ids()).segments[0]!;
    expect(piece.joined).toBe(false);
    expect(piece.prevId).toBeNull();
    expect(dur(piece)).toBeCloseTo(5, 4);
  });
});
