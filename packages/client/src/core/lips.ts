/**
 * The lip check: were the speaker's lips moving while a phrase was heard?
 *
 * The camera is watched by MediaPipe's Face Landmarker (in `vision/lips.ts`), which gives 478
 * points on the face for every frame. Four of them are enough here: the middle of the upper and
 * lower lip on the inside edge, and the two corners of the mouth. How far the lips are apart,
 * divided by how wide the mouth is, is the mouth's **opening**: a number that does not change when
 * the speaker leans towards the camera or away from it, and that goes from about 0 with the mouth
 * shut to 0.5 or so for an open "ah". Speech swings it up and down several times a second; a
 * listener's mouth holds still.
 *
 * Each frame becomes a sample (when it was seen, and the opening, or null when no face was in
 * view). For a phrase, the samples inside its time span are looked at together: how far the opening
 * swung (the gap between its 10th and 90th percentiles) and how much it moved from frame to frame.
 * Either one past its bar means the lips were moving. Too few frames with a face, or a face in view
 * for less than half the phrase, and the camera has nothing to say.
 *
 * Nothing in this file touches the browser or the model; the tests run it in Node.
 */

/** A landmark as Face Landmarker gives it: x and y as fractions of the frame's width and height. */
export interface Point {
  x: number;
  y: number;
}

/** Face Landmarker's indices for the points used here. */
export const UPPER_LIP = 13;
export const LOWER_LIP = 14;
export const MOUTH_LEFT = 61;
export const MOUTH_RIGHT = 291;

/** An opening swing over a phrase this large (as a share of the mouth's width) means the lips moved. */
export const LIP_SWING_MOVING = 0.05;
/** A mean frame-to-frame change this large means the lips moved, whatever the swing. */
export const LIP_MOTION_MOVING = 0.02;
/** Fewer frames with a face than this, and the camera has nothing to say. */
export const LIP_MIN_FRAMES = 6;
/** A face in view for less than this share of the phrase, and the camera has nothing to say. */
export const LIP_FACE_SHARE = 0.5;

/**
 * How open the mouth is in one frame: the gap between the inner lips over the width of the mouth,
 * measured in the frame's pixels (`aspect` is the frame's width over its height, which turns the
 * fractional coordinates into the same unit both ways). Null when the landmarks are missing or the
 * mouth has no width (a face seen edge-on).
 */
export function mouthOpening(landmarks: readonly Point[], aspect: number): number | null {
  const upper = landmarks[UPPER_LIP];
  const lower = landmarks[LOWER_LIP];
  const left = landmarks[MOUTH_LEFT];
  const right = landmarks[MOUTH_RIGHT];
  if (!upper || !lower || !left || !right) return null;
  const width = Math.hypot((right.x - left.x) * aspect, right.y - left.y);
  if (width < 1e-4) return null;
  const gap = Math.hypot((lower.x - upper.x) * aspect, lower.y - upper.y);
  return gap / width;
}

/** One camera frame: when it was seen (absolute ms) and the mouth's opening, or null without a face. */
export interface LipSample {
  t: number;
  open: number | null;
}

/** What the camera saw over a phrase. */
export interface LipActivity {
  /** Frames inside the phrase's span. */
  frames: number;
  /** Of which, frames with a face in view. */
  faceFrames: number;
  /** The gap between the 10th and 90th percentiles of the opening over the face frames. */
  swing: number;
  /** The mean change of the opening from one face frame to the next. */
  motion: number;
}

export type LipOpinion = 'moving' | 'still' | 'unseen';

/** What the camera says on its own. */
export function lipOpinion(a: LipActivity): LipOpinion {
  if (a.frames === 0 || a.faceFrames < LIP_MIN_FRAMES || a.faceFrames < a.frames * LIP_FACE_SHARE)
    return 'unseen';
  return a.swing >= LIP_SWING_MOVING || a.motion >= LIP_MOTION_MOVING ? 'moving' : 'still';
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[at] ?? 0;
}

/** The activity in the samples with `from <= t < to` (samples in time order). */
export function lipActivity(samples: readonly LipSample[], from: number, to: number): LipActivity {
  const opens: number[] = [];
  let frames = 0;
  let motionSum = 0;
  let steps = 0;
  let previous: number | null = null;
  for (const s of samples) {
    if (s.t < from || s.t >= to) continue;
    frames++;
    if (s.open === null) {
      previous = null;
      continue;
    }
    opens.push(s.open);
    if (previous !== null) {
      motionSum += Math.abs(s.open - previous);
      steps++;
    }
    previous = s.open;
  }
  opens.sort((a, b) => a - b);
  return {
    frames,
    faceFrames: opens.length,
    swing: percentile(opens, 0.9) - percentile(opens, 0.1),
    motion: steps > 0 ? motionSum / steps : 0,
  };
}

/** The last few minutes of samples, oldest first, with lookups by time span. */
export class LipTrack {
  private samples: LipSample[] = [];

  constructor(
    /** Samples older than this (ms) are dropped as new ones come in. */
    private readonly keepMs = 10 * 60_000,
  ) {}

  get length(): number {
    return this.samples.length;
  }

  /** The newest sample, or null before the first. */
  get latest(): LipSample | null {
    return this.samples[this.samples.length - 1] ?? null;
  }

  push(sample: LipSample): void {
    this.samples.push(sample);
    const cutoff = sample.t - this.keepMs;
    // samples come in time order, so the stale ones are all at the front
    let drop = 0;
    while (drop < this.samples.length && (this.samples[drop]?.t ?? Infinity) < cutoff) drop++;
    if (drop > 0) this.samples.splice(0, drop);
  }

  activity(from: number, to: number): LipActivity {
    return lipActivity(this.samples, from, to);
  }

  clear(): void {
    this.samples = [];
  }
}
