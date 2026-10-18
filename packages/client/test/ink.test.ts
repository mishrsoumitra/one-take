import { describe, expect, it } from 'vitest';

import { cutRange, keepRange, sliceSegment, splitAt } from '../src/core/edit.js';
import {
  boardBefore,
  concatInk,
  cutInk,
  describeInk,
  INK_GAP_KEEP_MS,
  INK_REST_MS,
  INK_TAIL_MS,
  inkAt,
  inkAtSpeed,
  inkDuration,
  InkSession,
  normalizePen,
  pointsShown,
  sliceInk,
  strokeUntil,
  type ClipInk,
  type InkStroke,
} from '../src/core/ink.js';
import { buildTimeline, type Segment } from '../src/core/timeline.js';
import { InkTrack } from '../src/export/ink-track.js';

const pen = { tool: 'pen' as const, color: '#ff3b30', width: 0.005 };

/** A stroke of `n` points `stepMs` apart from `fromMs`, moving right along one line. */
function stroke(fromMs: number, n: number, stepMs = 20, color = '#ff3b30'): InkStroke {
  return {
    tool: 'pen',
    color,
    width: 0.005,
    points: Array.from({ length: n }, (_, i) => ({ x: 0.1 + i * 0.01, y: 0.5, t: fromMs + i * stepMs })),
  };
}

/** A clip on `slide`: a drawing when `ink` is given, a phrase otherwise; 1 kHz, `seconds` long. */
function seg(id: string, slide: number, seconds: number, ink?: ClipInk): Segment {
  const s: Segment = {
    id,
    slide,
    sampleRate: 1000,
    pcm: new Int16Array(Math.round(seconds * 1000)),
    joined: false,
    prevId: null,
    createdAt: 0,
  };
  if (ink) s.ink = ink;
  return s;
}

describe('InkSession', () => {
  it('times points from the first pen-down and knows when the pen is down or rested', () => {
    const s = new InkSession(1000, 2);
    expect(s.down).toBe(false);
    s.strokeStart(1000, pen, 0.2, 0.3);
    expect(s.down).toBe(true);
    expect(s.restEndsAt).toBeNull();
    s.point(1020, 0.21, 0.3);
    s.point(1040, 0.22, 0.3);
    s.strokeEnd(1050);
    expect(s.down).toBe(false);
    expect(s.restEndsAt).toBe(1050 + INK_REST_MS);
    expect(s.rested(1050 + INK_REST_MS - 1)).toBe(false);
    expect(s.rested(1050 + INK_REST_MS)).toBe(true);
    const done = s.finish(1050 + INK_REST_MS)!;
    expect(done.ink.wipe).toBe(false);
    expect(done.ink.strokes).toHaveLength(1);
    expect(done.ink.strokes[0]!.points.map((p) => p.t)).toEqual([0, 20, 40]);
    expect(done.ink.strokes[0]!.points[0]).toMatchObject({ x: 0.2, y: 0.3 });
    expect(done.durationMs).toBe(40 + INK_TAIL_MS);
  });

  it('keeps the pause between strokes, but never more than the allowed gap, and trims the rest', () => {
    const s = new InkSession(0, 0);
    s.strokeStart(0, pen, 0.1, 0.1);
    s.point(100, 0.2, 0.1);
    s.strokeEnd(100);
    // a short pause stays as it was
    s.strokeStart(300, pen, 0.3, 0.1);
    s.point(400, 0.4, 0.1);
    s.strokeEnd(400);
    // a long one is shortened to the allowed gap
    s.strokeStart(1400, pen, 0.5, 0.1);
    s.point(1500, 0.6, 0.1);
    s.strokeEnd(1500);
    const done = s.finish(1500 + INK_REST_MS)!;
    const starts = done.ink.strokes.map((st) => st.points[0]!.t);
    expect(starts).toEqual([0, 300, 400 + INK_GAP_KEEP_MS]);
    expect(done.durationMs).toBe(400 + INK_GAP_KEEP_MS + 100 + INK_TAIL_MS);
  });

  it('drops a point where the pen did not move, clamps to the slide, and keeps time running forward', () => {
    const s = new InkSession(0, 0);
    s.strokeStart(0, pen, -0.5, 1.5);
    expect(s.point(10, -0.5, 1.5)).toBe(false);
    expect(s.point(20, 0.5, 0.5)).toBe(true);
    expect(s.all[0]!.points).toEqual([
      { x: 0, y: 1, t: 0 },
      { x: 0.5, y: 0.5, t: 20 },
    ]);
    expect(s.point(5, 0.6, 0.5)).toBe(true); // a clock that went backwards never makes time go back
    expect(s.all[0]!.points[2]!.t).toBe(20);
  });

  it('takes back the stroke being drawn, then finished ones, and is nothing once empty', () => {
    const s = new InkSession(0, 0);
    s.strokeStart(0, pen, 0.1, 0.1);
    s.strokeEnd(50);
    s.strokeStart(100, pen, 0.2, 0.2);
    expect(s.strokeCount).toBe(2);
    expect(s.undoStroke(150)).toBe(true); // the one being drawn
    expect(s.down).toBe(false);
    expect(s.restEndsAt).toBe(150 + INK_REST_MS); // the pen counts as lifted from here
    expect(s.strokeCount).toBe(1);
    expect(s.undoStroke(200)).toBe(true);
    expect(s.strokeCount).toBe(0);
    expect(s.undoStroke(250)).toBe(false);
    expect(s.finish(5000)).toBeNull();
  });

  it('finishes a stroke the pen never lifted from', () => {
    const s = new InkSession(0, 1);
    s.strokeStart(0, pen, 0.1, 0.1);
    s.point(30, 0.2, 0.1);
    const done = s.finish(30)!;
    expect(done.ink.strokes[0]!.points).toHaveLength(2);
    expect(s.down).toBe(false);
  });
});

describe('the board', () => {
  const red = stroke(0, 3);
  const blue = stroke(0, 3, 20, '#0673f9');
  const list = [
    seg('a', 0, 1),
    seg('b', 0, 0.2, { wipe: false, strokes: [red] }),
    seg('c', 1, 0.2, { wipe: false, strokes: [blue] }),
    seg('d', 0, 1),
    seg('e', 0, 0.4, { wipe: true, strokes: [] }),
    seg('f', 0, 1),
    seg('g', 0, 0.2, { wipe: false, strokes: [blue] }),
  ];

  it('is everything drawn earlier on the same slide, back to the last wipe', () => {
    expect(boardBefore(list, 0, 0)).toEqual([]);
    expect(boardBefore(list, 1, 0)).toEqual([]); // the drawing itself is not on the board yet
    expect(boardBefore(list, 3, 0)).toEqual([red]); // a voice clip after the drawing shows it
    expect(boardBefore(list, 3, 1)).toEqual([blue]); // the other slide has its own board
    expect(boardBefore(list, 5, 0)).toEqual([]); // wiped
    expect(boardBefore(list, 7, 0)).toEqual([blue]); // drawn again after the wipe
    expect(boardBefore(list, 99, 1)).toEqual([blue]); // past the end: the board as it stands
  });

  it('shows a drawing point by point and a wipe at once', () => {
    const ink: ClipInk = { wipe: false, strokes: [stroke(100, 3, 50), stroke(400, 2, 50)] };
    expect(inkAt([red], ink, 0)).toEqual([red]);
    expect(inkAt([red], ink, 100)).toEqual([
      red,
      { ...ink.strokes[0]!, points: ink.strokes[0]!.points.slice(0, 1) },
    ]);
    expect(inkAt([red], ink, 160)).toEqual([
      red,
      { ...ink.strokes[0]!, points: ink.strokes[0]!.points.slice(0, 2) },
    ]);
    expect(inkAt([red], ink, 200)).toEqual([red, ink.strokes[0]]);
    expect(inkAt([red], ink, 1000)).toEqual([red, ...ink.strokes]);
    expect(inkAt([red], { wipe: true, strokes: [] }, 0)).toEqual([]);
    expect(inkAt([red], { wipe: true, strokes: [blue] }, 1000)).toEqual([blue]);
    expect(pointsShown(ink, 0)).toBe(0);
    expect(pointsShown(ink, 160)).toBe(2);
    expect(pointsShown(ink, 1000)).toBe(5);
  });

  it('cuts a stroke short at the moment asked, and gives nothing before it starts', () => {
    const s = stroke(100, 4, 100);
    expect(strokeUntil(s, 50)).toBeNull();
    expect(strokeUntil(s, 100)!.points).toHaveLength(1);
    expect(strokeUntil(s, 250)!.points).toHaveLength(2);
    expect(strokeUntil(s, 400)).toBe(s);
  });

  it('describes and measures a drawing', () => {
    expect(describeInk({ wipe: false, strokes: [red] })).toBe('1 stroke');
    expect(describeInk({ wipe: true, strokes: [red, blue] })).toBe('cleared, then 2 strokes');
    expect(describeInk({ wipe: true, strokes: [] })).toBe('cleared the slide');
    expect(inkDuration({ wipe: false, strokes: [stroke(100, 3, 50)] })).toBeCloseTo(
      (200 + INK_TAIL_MS) / 1000,
    );
  });

  it('walks a timeline and changes its serial only when the picture changes', () => {
    const tl = buildTimeline(
      [seg('a', 0, 1), seg('b', 0, 0.35, { wipe: false, strokes: [stroke(0, 3, 100)] }), seg('c', 0, 1)],
      'recorded',
      { gapMs: 150, slideGapMs: 250 },
    );
    const track = new InkTrack(tl);
    expect(InkTrack.hasInk(tl)).toBe(true);
    expect(track.at(0, 0)).toBeNull(); // a bare slide
    const b = tl.items[1]!;
    const first = track.at(1, b.start);
    expect(first!.strokes[0]!.points).toHaveLength(1);
    expect(track.at(1, b.start + 0.05)!.serial).toBe(first!.serial); // no new point yet
    const second = track.at(1, b.start + 0.1);
    expect(second!.serial).not.toBe(first!.serial);
    expect(second!.strokes[0]!.points).toHaveLength(2);
    // the gap before a drawing shows the board as it was (here nothing)
    expect(track.at(1, b.from)).toBeNull();
    const c = tl.items[2]!;
    const later = track.at(2, c.start);
    expect(later!.strokes).toEqual([{ ...stroke(0, 3, 100) }]);
    expect(track.at(2, c.start + 0.5)!.serial).toBe(later!.serial);
    expect(
      InkTrack.hasInk(buildTimeline([seg('a', 0, 1)], 'recorded', { gapMs: 150, slideGapMs: 250 })),
    ).toBe(false);
  });
});

describe('edits on a drawing', () => {
  const ink: ClipInk = { wipe: true, strokes: [stroke(0, 5, 100), stroke(600, 3, 100)] };

  it('slices by time, rebasing what is kept, and keeps the wipe only at the very start', () => {
    const cut = sliceInk(ink, 150, 700);
    expect(cut.wipe).toBe(false);
    expect(cut.strokes.map((s) => s.points.map((p) => p.t))).toEqual([[50, 150, 250], [450]]);
    expect(sliceInk(ink, 0, 100).wipe).toBe(true);
    expect(sliceInk(ink, 900, 1000).strokes).toEqual([]);
  });

  it('cuts a stretch out and closes the hole', () => {
    const cut = cutInk(ink, 150, 650);
    expect(cut.wipe).toBe(true);
    expect(cut.strokes.map((s) => s.points.map((p) => p.t))).toEqual([
      [0, 100],
      [200, 300],
    ]);
  });

  it('joins two drawings and plays faster', () => {
    const joined = concatInk(
      { wipe: false, strokes: [stroke(0, 2, 100)] },
      { wipe: true, strokes: [stroke(0, 2, 100)] },
      500,
    );
    expect(joined.wipe).toBe(false);
    expect(joined.strokes[1]!.points.map((p) => p.t)).toEqual([500, 600]);
    const fast = inkAtSpeed(ink, 2);
    expect(fast.strokes[1]!.points.map((p) => p.t)).toEqual([300, 350, 400]);
    expect(inkAtSpeed(ink, 1)).toBe(ink);
  });

  it('follows the sound through the editor: slice, cut, keep and split', () => {
    // a 1 s drawing at 1 kHz: a stroke from 0 to 400 ms and one from 600 to 800 ms
    const s = seg('d', 0, 1, ink);
    const half = sliceSegment(s, 500, 1000)!;
    expect(half.pcm.length).toBe(500);
    expect(half.ink!.wipe).toBe(false);
    expect(half.ink!.strokes.map((x) => x.points.map((p) => p.t))).toEqual([[100, 200, 300]]);
    const cut = cutRange(s, 0.1, 0.7)!;
    expect(cut.pcm.length).toBe(400);
    expect(cut.ink!.strokes.map((x) => x.points.map((p) => p.t))).toEqual([[0], [100, 200]]);
    const kept = keepRange(s, 0.6, 0.9)!;
    expect(kept.ink!.strokes).toHaveLength(1);
    expect(kept.ink!.strokes[0]!.points.map((p) => p.t)).toEqual([0, 100, 200]);
    const [a, b] = splitAt(s, 0.5, 'd2')!;
    expect(a.ink!.wipe).toBe(true);
    expect(a.ink!.strokes[0]!.points).toHaveLength(5);
    expect(b.ink!.wipe).toBe(false);
    expect(b.ink!.strokes[0]!.points.map((p) => p.t)).toEqual([100, 200, 300]);
    // a phrase without a drawing stays without one
    expect(cutRange(seg('v', 0, 1), 0.1, 0.2)!.ink).toBeUndefined();
  });
});

describe('normalizePen', () => {
  it('keeps a sensible pen and falls back on anything else', () => {
    expect(normalizePen({ tool: 'highlighter', color: '#FFD60A', width: 0.01 })).toEqual({
      tool: 'highlighter',
      color: '#ffd60a',
      width: 0.01,
    });
    expect(normalizePen({ tool: 'eraser', color: 'red', width: 5 })).toEqual({
      tool: 'pen',
      color: '#ff3b30',
      width: 0.03,
    });
    expect(normalizePen(null)).toEqual({ tool: 'pen', color: '#ff3b30', width: 0.005 });
  });
});
