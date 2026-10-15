import { describe, expect, it } from 'vitest';

import {
  clipVideoAtSpeed,
  clipVideoDuration,
  concatClipVideo,
  frameIndexAt,
  frameTimeAt,
  pieceFromFrames,
  sliceClipVideo,
  slicePiece,
  US,
  type ClipVideo,
  type EncodedFrame,
  type VideoPiece,
} from '../src/core/clip-video.js';

/** `count` frames `stepUs` apart from `fromUs`, a key frame every `keyEvery`; the data byte is the frame's number. */
function frames(fromUs: number, count: number, stepUs = 40_000, keyEvery = 25): EncodedFrame[] {
  return Array.from({ length: count }, (_, i) => ({
    key: i % keyEvery === 0,
    timestamp: fromUs + i * stepUs,
    duration: stepUs,
    data: new Uint8Array([i & 0xff, (i >> 8) & 0xff]),
  }));
}

const frameNo = (f: EncodedFrame) => (f.data[0] ?? 0) | ((f.data[1] ?? 0) << 8);

/** The number of the frame shown at piece time `sec`. */
function shownAt(piece: VideoPiece, sec: number): number {
  const f = piece.frames[frameIndexAt(piece.frames, frameTimeAt(piece, sec * US))];
  return f ? frameNo(f) : -1;
}

function clip(pieces: VideoPiece[]): ClipVideo {
  return { codec: 'vp8', width: 640, height: 360, pieces };
}

describe('pieceFromFrames', () => {
  it('starts at the key frame before the stretch and skips to where the audio starts', () => {
    // the camera clock started 3 s before the phrase; frames every 40 ms, a key frame every second
    const all = frames(0, 250);
    const piece = pieceFromFrames(all, 3_120_000, 5_000_000);
    expect(piece).not.toBeNull();
    const p = piece!;
    expect(p.frames[0]?.key).toBe(true);
    expect(frameNo(p.frames[0]!)).toBe(75); // the key frame at 3.0 s
    expect(p.frames[0]?.timestamp).toBe(0); // rebased
    expect(p.startUs).toBe(120_000); // the audio starts 120 ms into the kept frames
    expect(p.durationUs).toBe(1_880_000);
    expect(p.rate).toBe(1);
    // the last kept frame is the last one that starts before the end of the stretch
    const last = p.frames[p.frames.length - 1]!;
    expect(frameNo(last)).toBe(124); // 4.96 s; the one at 5.0 s is never shown
    // what plays: frame 78 at 0 s (3.12 s on the camera), frame 100 one second in
    expect(shownAt(p, 0)).toBe(78);
    expect(shownAt(p, 0.88)).toBe(100);
  });

  it('is null when the camera has nothing of the stretch', () => {
    // the frames end at 0.36 s: a phrase ten seconds later gets no frozen picture
    expect(pieceFromFrames(frames(0, 10), 10 * US, 11 * US)).toBeNull();
    // but one that starts just after the last frame still gets it
    expect(pieceFromFrames(frames(0, 10), 0.5 * US, 1 * US)).not.toBeNull();
    expect(pieceFromFrames([], 0, US)).toBeNull();
    expect(pieceFromFrames(frames(0, 10), 5, 5)).toBeNull();
  });

  it('starts the picture a little late when the camera came on after the phrase began', () => {
    const all = frames(2 * US, 50);
    const p = pieceFromFrames(all, 1 * US, 3 * US)!;
    expect(p.startUs).toBe(-US); // the first frame is a second into the audio
    expect(shownAt(p, 0)).toBe(0); // until then the first frame stands in
    expect(shownAt(p, 1.5)).toBe(12);
  });
});

describe('slicePiece and sliceClipVideo', () => {
  const whole = pieceFromFrames(frames(0, 250), 0, 10 * US)!;

  it('returns the piece itself for the whole stretch and null for an empty one', () => {
    expect(slicePiece(whole, 0, 10 * US)).toBe(whole);
    expect(slicePiece(whole, 4 * US, 4 * US)).toBeNull();
    expect(slicePiece(whole, 12 * US, 13 * US)).toBeNull();
  });

  it('keeps the same frame on screen at the same moment of audio after a cut', () => {
    const mid = slicePiece(whole, 2.5 * US, 6.1 * US)!;
    expect(mid.durationUs).toBe(3.6 * US);
    expect(mid.frames[0]?.key).toBe(true);
    expect(frameNo(mid.frames[0]!)).toBe(50); // the key frame at 2 s
    for (const sec of [0, 0.2, 1, 2.5, 3.59]) {
      expect(shownAt(mid, sec)).toBe(shownAt(whole, 2.5 + sec));
    }
    // nothing after the stretch is carried along
    const last = mid.frames[mid.frames.length - 1]!;
    expect(frameNo(last)).toBeLessThan(153);
  });

  it('cuts across pieces and leaves out the ones it does not touch', () => {
    const a = pieceFromFrames(frames(0, 50), 0, 2 * US)!; // 2 s
    const b = pieceFromFrames(frames(100 * US, 75), 100 * US, 103 * US)!; // 3 s
    const c = pieceFromFrames(frames(200 * US, 25), 200 * US, 201 * US)!; // 1 s
    const v = clip([a, b, c]);
    expect(clipVideoDuration(v)).toBeCloseTo(6, 6);
    const cut = sliceClipVideo(v, 1.5, 5.5)!;
    expect(cut.pieces).toHaveLength(3);
    expect(cut.pieces.map((p) => p.durationUs)).toEqual([0.5 * US, 3 * US, 0.5 * US]);
    expect(cut.pieces[1]).toBe(b); // untouched, so the same object
    expect(shownAt(cut.pieces[0]!, 0)).toBe(shownAt(a, 1.5));
    expect(shownAt(cut.pieces[2]!, 0.4)).toBe(shownAt(c, 0.4));
    expect(sliceClipVideo(v, 6, 7)).toBeNull();
    expect(sliceClipVideo(v, 2, 5)).toEqual(clip([b]));
  });

  it('concatenates and tolerates a missing side', () => {
    const a = clip([whole]);
    expect(concatClipVideo(a, null)).toBe(a);
    expect(concatClipVideo(null, a)).toBe(a);
    expect(concatClipVideo(null, null)).toBeNull();
    const both = concatClipVideo(a, a)!;
    expect(both.pieces).toEqual([whole, whole]);
  });
});

describe('clipVideoAtSpeed', () => {
  it('runs through the same frames faster', () => {
    const whole = pieceFromFrames(frames(0, 250), 0, 10 * US)!;
    const fast = clipVideoAtSpeed(clip([whole]), 2);
    const p = fast.pieces[0]!;
    expect(p.durationUs).toBe(5 * US);
    expect(p.rate).toBe(2);
    expect(p.frames).toBe(whole.frames);
    expect(shownAt(p, 1)).toBe(shownAt(whole, 2));
    expect(shownAt(p, 4.99)).toBe(shownAt(whole, 9.98));
    // a stretch of a sped-up piece keeps the pace
    const bit = slicePiece(p, 1 * US, 2 * US)!;
    expect(bit.rate).toBe(2);
    expect(shownAt(bit, 0.5)).toBe(shownAt(whole, 3));
    expect(clipVideoAtSpeed(fast, 1)).toBe(fast);
  });
});
