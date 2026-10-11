import { describe, expect, it } from 'vitest';

import {
  cutRange,
  insertAt,
  itemAt,
  joinPcm,
  keepRange,
  peaks,
  removeAt,
  replaceAt,
  splitAt,
  takeToSegments,
  withSlide,
} from '../src/core/edit.js';
import { buildTimeline, segmentDuration, type Segment } from '../src/core/timeline.js';

/** A phrase whose samples count upwards, so a slice can be told apart by its values. */
function seg(
  id: string,
  slide: number,
  seconds: number,
  joined = false,
  prevId: string | null = null,
): Segment {
  const pcm = new Int16Array(seconds * 1000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = i;
  return { id, slide, sampleRate: 1000, pcm, joined, prevId, createdAt: 0 };
}

const settings = { gapMs: 150, slideGapMs: 250 };

describe('joinPcm', () => {
  it('concatenates and fades both sides of the seam', () => {
    const a = new Int16Array([1000, 1000, 1000, 1000]);
    const b = new Int16Array([1000, 1000, 1000, 1000]);
    const out = joinPcm(a, b, 1000, 2); // 2 ms at 1 kHz = 2 samples
    expect(Array.from(out)).toEqual([1000, 1000, 500, 0, 0, 500, 1000, 1000]);
  });
});

describe('cutRange', () => {
  it('removes the middle and keeps the id', () => {
    const s = seg('a', 0, 3);
    const cut = cutRange(s, 1, 2);
    expect(cut).not.toBeNull();
    expect(cut!.id).toBe('a');
    expect(cut!.pcm.length).toBe(2000);
    // the sample before the seam fade comes from the head, the one after it from the tail
    expect(cut!.pcm[500]).toBe(500);
    expect(cut!.pcm[1500]).toBe(2500);
    // the original was not touched
    expect(s.pcm.length).toBe(3000);
  });

  it('accepts the range in either order and clamps to the phrase', () => {
    const s = seg('a', 0, 2);
    expect(cutRange(s, 1.5, 0.5)!.pcm.length).toBe(1000);
    expect(cutRange(s, -5, 0.5)!.pcm.length).toBe(1500);
    expect(cutRange(s, 1.5, 99)!.pcm.length).toBe(1500);
  });

  it('returns the phrase itself for an empty range and null when nothing is left', () => {
    const s = seg('a', 0, 2);
    expect(cutRange(s, 1, 1)).toBe(s);
    expect(cutRange(s, 0, 2)).toBeNull();
    expect(cutRange(s, 0.01, 1.99)).toBeNull();
  });
});

describe('keepRange', () => {
  it('keeps only the selection', () => {
    const kept = keepRange(seg('a', 0, 3), 1, 2)!;
    expect(kept.pcm.length).toBe(1000);
    expect(kept.pcm[0]).toBe(1000);
    expect(keepRange(seg('a', 0, 3), 1, 1.01)).toBeNull();
  });
});

describe('splitAt', () => {
  it('makes two phrases that play back to back', () => {
    const [first, second] = splitAt(seg('a', 2, 3), 1.2, 'b')!;
    expect(first.id).toBe('a');
    expect(first.pcm.length).toBe(1200);
    expect(second.id).toBe('b');
    expect(second.pcm.length).toBe(1800);
    expect(second.pcm[0]).toBe(1200);
    expect(second.slide).toBe(2);
    expect(second.joined).toBe(true);
    expect(second.prevId).toBe('a');
    const tl = buildTimeline([first, second], 'recorded', settings);
    expect(tl.items[1]!.gap).toBe(0);
    expect(tl.total).toBeCloseTo(3, 6);
  });

  it('refuses a cut at either end', () => {
    expect(splitAt(seg('a', 0, 2), 0, 'b')).toBeNull();
    expect(splitAt(seg('a', 0, 2), 2, 'b')).toBeNull();
    expect(splitAt(seg('a', 0, 2), 0.01, 'b')).toBeNull();
  });
});

describe('takeToSegments', () => {
  it('turns the phrases of a take into fresh segments on one slide', () => {
    let n = 0;
    const segs = takeToSegments([new Int16Array(500), new Int16Array(0), new Int16Array(700)], 1000, 4, () =>
      String(++n),
    );
    expect(segs.map((s) => [s.id, s.slide, s.pcm.length, s.joined])).toEqual([
      ['1', 4, 500, false],
      ['2', 4, 700, false],
    ]);
  });
});

describe('list edits', () => {
  const list = [seg('a', 0, 1), seg('b', 0, 1), seg('c', 1, 1)];
  const ids = (l: Segment[]) => l.map((s) => s.id);

  it('replace, insert and remove return new lists', () => {
    expect(ids(replaceAt(list, 1, 1, [seg('x', 0, 1), seg('y', 0, 1)]))).toEqual(['a', 'x', 'y', 'c']);
    expect(ids(insertAt(list, 0, [seg('x', 0, 1)]))).toEqual(['x', 'a', 'b', 'c']);
    expect(ids(insertAt(list, 3, [seg('x', 0, 1)]))).toEqual(['a', 'b', 'c', 'x']);
    expect(ids(insertAt(list, 99, [seg('x', 0, 1)]))).toEqual(['a', 'b', 'c', 'x']);
    expect(ids(removeAt(list, 2))).toEqual(['a', 'b']);
    expect(ids(list)).toEqual(['a', 'b', 'c']);
  });

  it('moves a phrase to another slide without touching its audio', () => {
    const moved = withSlide(list, 2, 0);
    expect(moved[2]!.slide).toBe(0);
    expect(moved[2]!.pcm).toBe(list[2]!.pcm);
    expect(moved[1]).toBe(list[1]);
    expect(withSlide(list, 2, 1)[2]).toBe(list[2]);
  });
});

describe('itemAt', () => {
  const tl = buildTimeline([seg('a', 0, 2), seg('b', 1, 1), seg('c', 1, 1)], 'recorded', settings);

  it('finds the phrase under a time, counting the silence before it as the phrase', () => {
    expect(itemAt(tl, 0.5)).toEqual({ index: 0, offset: 0.5 });
    expect(itemAt(tl, 1.99)).toEqual({ index: 0, offset: 1.99 });
    const hit = itemAt(tl, 2.1)!; // inside the 0.4 s gap before b
    expect(hit.index).toBe(1);
    expect(hit.offset).toBeLessThan(0);
    expect(itemAt(tl, 3)!.index).toBe(1);
    expect(itemAt(tl, 99)!.index).toBe(2);
    expect(itemAt(buildTimeline([], 'recorded', settings), 0)).toBeNull();
  });
});

describe('peaks', () => {
  it('gives the loudest sample per column, scaled to 0..1', () => {
    const pcm = new Int16Array([0, 100, -32768, 50, 0, 0, 16384, 0]);
    expect(Array.from(peaks(pcm, 4))).toEqual([100 / 32768, 1, 0, 0.5]);
    expect(peaks(pcm, 0).length).toBe(0);
    expect(Array.from(peaks(new Int16Array(0), 3))).toEqual([0, 0, 0]);
  });

  it('never skips samples when there are more columns than samples', () => {
    const pcm = new Int16Array([0, 32768 / 2]);
    const p = peaks(pcm, 4);
    expect(p[3]).toBe(0.5);
    expect(segmentDuration({ ...seg('a', 0, 1), pcm })).toBe(0.002);
  });
});
