/** The lip check's arithmetic on made-up faces and made-up mouths. */
import { describe, expect, it } from 'vitest';

import {
  LIP_MIN_FRAMES,
  LIP_SWING_MOVING,
  lipActivity,
  lipOpinion,
  LipTrack,
  LOWER_LIP,
  MOUTH_LEFT,
  MOUTH_RIGHT,
  mouthOpening,
  UPPER_LIP,
  type LipSample,
  type Point,
} from '../src/core/lips.js';

/** A face with only the four points the check reads, as fractions of a frame. */
function face(gap: number, width: number): Point[] {
  const points: Point[] = Array.from({ length: 300 }, () => ({ x: 0.5, y: 0.5 }));
  points[MOUTH_LEFT] = { x: 0.5 - width / 2, y: 0.6 };
  points[MOUTH_RIGHT] = { x: 0.5 + width / 2, y: 0.6 };
  points[UPPER_LIP] = { x: 0.5, y: 0.6 - gap / 2 };
  points[LOWER_LIP] = { x: 0.5, y: 0.6 + gap / 2 };
  return points;
}

/** A talking mouth: the opening swings between 0 and `amplitude` four times a second, 30 frames a second. */
function talking(seconds: number, amplitude = 0.3, from = 0): LipSample[] {
  const out: LipSample[] = [];
  for (let i = 0; i < seconds * 30; i++) {
    const t = from + (i * 1000) / 30;
    out.push({ t, open: (amplitude / 2) * (1 - Math.cos(2 * Math.PI * 4 * (i / 30))) });
  }
  return out;
}

/** A listening mouth: shut, with the landmarks' jitter. */
function still(seconds: number, from = 0): LipSample[] {
  const out: LipSample[] = [];
  for (let i = 0; i < seconds * 30; i++) {
    out.push({ t: from + (i * 1000) / 30, open: 0.02 + 0.006 * Math.sin(i * 1.7) });
  }
  return out;
}

describe('mouthOpening', () => {
  it("is the lip gap over the mouth width, in the frame's pixels", () => {
    // a square frame: fractions are the same unit both ways
    expect(mouthOpening(face(0.04, 0.2), 1)).toBeCloseTo(0.2);
    expect(mouthOpening(face(0, 0.2), 1)).toBeCloseTo(0);
    // a 16:9 frame: a horizontal fraction is 16/9 as many pixels as a vertical one
    expect(mouthOpening(face(0.04, 0.2), 16 / 9)).toBeCloseTo(0.04 / (0.2 * (16 / 9)));
  });

  it('is null without the points or without a mouth width', () => {
    expect(mouthOpening([], 1)).toBeNull();
    expect(mouthOpening(face(0.04, 0), 1)).toBeNull();
  });
});

describe('lipActivity', () => {
  it('sees a talking mouth move', () => {
    const a = lipActivity(talking(3), 0, 3000);
    expect(a.frames).toBe(90);
    expect(a.faceFrames).toBe(90);
    expect(a.swing).toBeGreaterThan(LIP_SWING_MOVING);
    expect(lipOpinion(a)).toBe('moving');
  });

  it("sees a shut mouth hold still through the landmarks' jitter", () => {
    const a = lipActivity(still(3), 0, 3000);
    expect(a.faceFrames).toBe(90);
    expect(a.swing).toBeLessThan(LIP_SWING_MOVING);
    expect(lipOpinion(a)).toBe('still');
  });

  it("only looks inside the phrase's span", () => {
    const samples = [...still(2), ...talking(2, 0.3, 2000), ...still(2, 4000)];
    expect(lipOpinion(lipActivity(samples, 0, 2000))).toBe('still');
    expect(lipOpinion(lipActivity(samples, 2000, 4000))).toBe('moving');
    expect(lipOpinion(lipActivity(samples, 4000, 6000))).toBe('still');
    expect(lipActivity(samples, 6000, 9000).frames).toBe(0);
  });

  it('has nothing to say without a face for most of the phrase, or with too few frames', () => {
    const gone = talking(3).map((s, i) => (i % 3 === 0 ? s : { t: s.t, open: null }));
    expect(lipOpinion(lipActivity(gone, 0, 3000))).toBe('unseen');
    expect(lipOpinion(lipActivity(talking(3).slice(0, LIP_MIN_FRAMES - 1), 0, 3000))).toBe('unseen');
    expect(lipOpinion(lipActivity([], 0, 3000))).toBe('unseen');
  });

  it('does not count the jump across a frame without a face as motion', () => {
    const samples = talking(3).map((s, i) => (i === 45 ? { t: s.t, open: null } : s));
    const a = lipActivity(samples, 0, 3000);
    expect(a.faceFrames).toBe(89);
    expect(lipOpinion(a)).toBe('moving');
  });
});

describe('LipTrack', () => {
  it('keeps the recent samples and forgets the stale ones', () => {
    const track = new LipTrack(1000);
    for (let t = 0; t <= 3000; t += 100) track.push({ t, open: 0.1 });
    expect(track.length).toBe(11);
    expect(track.latest?.t).toBe(3000);
    expect(track.activity(0, 1900).frames).toBe(0);
    expect(track.activity(2000, 3100).frames).toBe(11);
    track.clear();
    expect(track.length).toBe(0);
    expect(track.latest).toBeNull();
  });
});
