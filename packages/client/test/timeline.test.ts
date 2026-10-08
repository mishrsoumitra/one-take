import { describe, expect, it } from 'vitest';

import { buildTimeline, durationPerSlide, type Segment } from '../src/core/timeline.js';

function seg(
  id: string,
  slide: number,
  seconds: number,
  joined = false,
  prevId: string | null = null,
): Segment {
  return { id, slide, sampleRate: 1000, pcm: new Int16Array(seconds * 1000), joined, prevId, createdAt: 0 };
}

const settings = { gapMs: 150, slideGapMs: 250 };

describe('buildTimeline', () => {
  it('inserts gaps, bigger on slide changes, none on joined phrases', () => {
    const tl = buildTimeline(
      [seg('a', 0, 2), seg('b', 0, 1), seg('c', 1, 1, true, 'b'), seg('d', 2, 1)],
      'recorded',
      settings,
    );
    expect(tl.items.map((i) => [i.gap, i.joined])).toEqual([
      [0, false],
      [0.15, false],
      [0, true],
      [0.4, false],
    ]);
    expect(tl.total).toBeCloseTo(2 + 0.15 + 1 + 1 + 0.4 + 1, 6);
    expect(tl.items.map((i) => [i.fadeIn, i.fadeOut])).toEqual([
      [true, true],
      [true, false],
      [false, true],
      [true, true],
    ]);
    expect(tl.items[3]!.start).toBeCloseTo(4.55, 6);
  });

  it('groups by slide number when asked, keeping recorded order inside a slide', () => {
    const tl = buildTimeline(
      [seg('a', 2, 1), seg('b', 0, 1), seg('c', 2, 1), seg('d', 1, 1)],
      'slide',
      settings,
    );
    expect(tl.items.map((i) => i.seg.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('does not join a phrase whose predecessor moved away', () => {
    const tl = buildTimeline(
      [seg('a', 0, 1), seg('x', 1, 1), seg('b', 0, 1, true, 'a')],
      'recorded',
      settings,
    );
    expect(tl.items[2]!.joined).toBe(false);
    expect(tl.items[2]!.gap).toBeCloseTo(0.4, 6);
  });

  it('sums per slide', () => {
    expect(durationPerSlide([seg('a', 0, 2), seg('b', 2, 1), seg('c', 9, 1)], 3)).toEqual([2, 0, 1]);
  });
});
