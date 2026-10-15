import { describe, expect, it } from 'vitest';

import {
  cutFaces,
  faceBox,
  faceCropRect,
  faceGrid,
  faceTrack,
  framesFile,
  framesFromFile,
  joinFaces,
  sliceFaces,
} from '../src/core/faces.js';

describe('the mouth crop', () => {
  it('boxes the face from its landmarks in pixels', () => {
    const box = faceBox(
      [
        { x: 0.25, y: 0.2 },
        { x: 0.75, y: 0.2 },
        { x: 0.5, y: 0.8 },
      ],
      640,
      480,
    );
    expect(box).toEqual({ x: 160, y: 96, width: 320, height: 288 });
    expect(faceBox([], 640, 480)).toBeNull();
    expect(faceBox([{ x: 0.5, y: 0.5 }], 640, 480)).toBeNull();
  });

  it('cuts where ClearerVoice cuts: the middle half of a square 1.4 times the face, set a little high', () => {
    // a 200 px square face centred at (300, 250): bs = 100, side S = 280, middle half = 140 wide
    const rect = faceCropRect({ x: 200, y: 150, width: 200, height: 200 });
    expect(rect.size).toBeCloseTo(140);
    expect(rect.sx).toBeCloseTo(300 - 70); // centred across
    expect(rect.sy).toBeCloseTo(250 - 100 + 70); // from the box's top edge down a quarter of the square
  });
});

describe('faceGrid', () => {
  it('lays frames on the 25 fps grid, repeating the last one across a dropped frame', () => {
    const samples = [0, 40, 80, 160, 200].map((t) => ({ t: 1000 + t, crop: `f${t}` }));
    const grid = faceGrid(samples, 1000, 1240);
    expect(grid).toEqual(['f0', 'f40', 'f80', 'f80', 'f160', 'f200']);
  });

  it('takes the nearest frame when the camera runs at its own rate', () => {
    const samples = [0, 33, 67, 100, 133, 167].map((t) => ({ t: 2000 + t, crop: t }));
    expect(faceGrid(samples, 2000, 2200)).toEqual([0, 33, 67, 133, 167]);
  });

  it('gives up when the face was there for less than half the phrase, or not at all', () => {
    const few = [
      { t: 500, crop: 'a' },
      { t: 540, crop: 'b' },
      { t: 580, crop: null },
    ];
    expect(faceGrid(few, 500, 1000)).toBeNull();
    expect(faceGrid([{ t: 10, crop: null }], 0, 400)).toBeNull();
    expect(faceGrid([], 0, 400)).toBeNull();
  });

  it('starts from the first frame when the camera came on a moment late', () => {
    const samples = [120, 160, 200].map((t) => ({ t, crop: t }));
    expect(faceGrid(samples, 0, 240)).toEqual([120, 120, 120, 120, 160, 200]);
  });
});

describe('the frames file', () => {
  it('round-trips length-prefixed frames', () => {
    const frames = [Uint8Array.from([1, 2, 3]), Uint8Array.from([]), Uint8Array.from([9])];
    const file = framesFile(frames.filter((f) => f.length > 0));
    expect(file.length).toBe(4 + 3 + 4 + 1);
    const back = framesFromFile(file);
    expect(back.map((f) => Array.from(f))).toEqual([[1, 2, 3], [9]]);
    expect(framesFromFile(file.subarray(0, 6))).toEqual([]);
  });
});

describe('the film follows the cuts', () => {
  const frames = Array.from({ length: 10 }, (_, k) => Uint8Array.from([k]));
  const track = faceTrack(frames);
  const ids = (t: { data: Uint8Array } | null | undefined) =>
    t ? framesFromFile(t.data).map((f) => f[0]) : null;

  it('keeps a stretch, cuts one out, and joins two films', () => {
    expect(track.frames).toBe(10);
    // 0.1 s is frame 2.5, rounded to 3; 0.3 s is frame 7.5, rounded to 8
    expect(ids(sliceFaces(track, 0.1, 0.3))).toEqual([3, 4, 5, 6, 7]);
    expect(ids(cutFaces(track, 0.1, 0.3))).toEqual([0, 1, 2, 8, 9]);
    expect(sliceFaces(track, 0.2, 0.2)).toBeNull();
    expect(cutFaces(track, 0.2, 0.2)).toBe(track);
    expect(
      ids(joinFaces(sliceFaces(track, 0, 0.08) ?? undefined, sliceFaces(track, 0.32, 0.4) ?? undefined)),
    ).toEqual([0, 1, 8, 9]);
    expect(joinFaces(track, undefined)).toBeUndefined();
  });
});
