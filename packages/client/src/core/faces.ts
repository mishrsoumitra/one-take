/**
 * The speaker's mouth, kept with each phrase for the studio's voice extraction.
 *
 * The extraction model (AV-MossFormer2, see `shared/studio.ts`) learnt to tell which voice is
 * yours from a short film of your lips: 25 frames a second, each a 112 × 112 grey square cut from
 * the face the same way ClearerVoice's own video pipeline cuts it. That pipeline finds the face,
 * takes a square around it of side `2 × bs × (1 + 0.4)` where `bs` is half the longer side of the
 * face box, placed so that the face's centre sits a little above the square's middle (the mouth
 * is in the lower half of a face), scales it to 224 and keeps the middle 112. Here the face box
 * comes from the lip check's landmarks, which the lip worker already has for every frame, and the
 * cut is made in one `drawImage` straight into a 112 × 112 canvas.
 *
 * Frames are stamped on the page's clock as they are seen. When a phrase is stored, the frames
 * inside its span are laid on a 25 fps grid from the phrase's start: each grid slot takes the frame
 * nearest to it when one is close enough, and the previous slot's frame otherwise, so a dropped
 * camera frame never shifts the lips against the voice. A phrase the camera saw for less than half
 * of has no film at all.
 *
 * Nothing in this file touches the browser; the tests run it in Node.
 */
import { FACE_FPS, FACE_SIZE } from '@one-take/shared';

import { type Point } from './lips.js';

export { FACE_FPS, FACE_SIZE };

/** ClearerVoice's crop scale: the square around the face is this much wider than the face box. */
export const CROP_SCALE = 0.4;
/** A grid slot takes a frame at most this far from it (half the camera's own frame spacing at 10 fps). */
export const NEAREST_MS = 60;
/** A film is kept only when at least this share of its slots had a frame of their own. */
export const MIN_SEEN_SHARE = 0.5;
/** The grey the model's pipeline pads with outside the picture. */
export const PAD_GREY = 110;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The source rectangle to draw into the 112 × 112 canvas: the middle half of the 224 crop. */
export interface CropRect {
  sx: number;
  sy: number;
  size: number;
}

/** The face's box in pixels from its landmarks (fractions of the frame), or null without landmarks. */
export function faceBox(landmarks: readonly Point[], width: number, height: number): Box | null {
  if (landmarks.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of landmarks) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const x = minX * width;
  const y = minY * height;
  const box = { x, y, width: maxX * width - x, height: maxY * height - y };
  return box.width > 0 && box.height > 0 ? box : null;
}

/**
 * Where to cut: the pipeline's 224 square has side `S = 2 bs (1 + CROP_SCALE)`, spans
 * `[mx − S/2, mx + S/2]` across and `[my − bs, my − bs + S]` down; the middle 112 of it is the
 * middle half of that square.
 */
export function faceCropRect(box: Box): CropRect {
  const bs = Math.max(box.width, box.height) / 2;
  const mx = box.x + box.width / 2;
  const my = box.y + box.height / 2;
  const side = 2 * bs * (1 + CROP_SCALE);
  const quarter = side / 4;
  return { sx: mx - quarter, sy: my - bs + quarter, size: side / 2 };
}

/** One frame of the lips as the worker sends it: when it was seen and the crop, or null without a face. */
export interface FaceSample<T = Uint8Array> {
  t: number;
  crop: T | null;
}

/**
 * The frames inside `[from, to)` laid on the 25 fps grid starting at `from`: one entry per slot,
 * each the nearest frame within {@link NEAREST_MS}, else the previous slot's, else the next
 * frame's (the camera came on a moment late). Null when fewer than half the slots had a frame of
 * their own, or when there is none at all.
 */
export function faceGrid<T>(samples: readonly FaceSample<T>[], from: number, to: number): T[] | null {
  if (to <= from) return null;
  const seen = samples.filter(
    (s): s is FaceSample<T> & { crop: T } =>
      s.crop !== null && s.t >= from - NEAREST_MS && s.t < to + NEAREST_MS,
  );
  if (seen.length === 0) return null;
  const step = 1000 / FACE_FPS;
  const slots = Math.max(1, Math.round((to - from) / step));
  const out: T[] = [];
  let own = 0;
  let k = 0;
  let previous: T | null = null;
  for (let i = 0; i < slots; i++) {
    const at = from + i * step;
    // the nearest frame; on a tie the earlier one, so a dropped frame reads as the last one held
    while (
      k + 1 < seen.length &&
      Math.abs((seen[k + 1]?.t ?? Infinity) - at) < Math.abs((seen[k]?.t ?? Infinity) - at)
    )
      k++;
    const nearest = seen[k];
    if (nearest && Math.abs(nearest.t - at) <= NEAREST_MS) {
      own++;
      previous = nearest.crop;
      out.push(nearest.crop);
    } else {
      out.push(previous ?? (seen[0]?.crop as T));
    }
  }
  return own >= slots * MIN_SEEN_SHARE ? out : null;
}

/** The frames file the studio reads: each JPEG after its length as a little-endian uint32. */
export function framesFile(frames: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const f of frames) total += 4 + f.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const f of frames) {
    view.setUint32(at, f.length, true);
    out.set(f, at + 4);
    at += 4 + f.length;
  }
  return out;
}

/** The frames back out of a frames file. */
export function framesFromFile(bytes: Uint8Array): Uint8Array[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames: Uint8Array[] = [];
  let at = 0;
  while (at + 4 <= bytes.length) {
    const length = view.getUint32(at, true);
    at += 4;
    if (length === 0 || at + length > bytes.length) break;
    frames.push(bytes.subarray(at, at + length));
    at += length;
  }
  return frames;
}

/**
 * The film kept with a phrase: the frames file (the studio's own format, so it is uploaded as it
 * is) and how many frames it holds. Frame `k` covers the phrase's seconds `[k / fps, (k + 1) / fps)`.
 */
export interface FaceTrack {
  fps: number;
  frames: number;
  data: Uint8Array;
}

export function faceTrack(frames: readonly Uint8Array[]): FaceTrack {
  return { fps: FACE_FPS, frames: frames.length, data: framesFile(frames) };
}

/** The frame the phrase's second `sec` falls in. */
function frameAt(track: FaceTrack, sec: number): number {
  return Math.max(0, Math.min(track.frames, Math.round(sec * track.fps)));
}

/** The film between two moments of the phrase, or null when nothing of it is left. */
export function sliceFaces(track: FaceTrack, fromSec: number, toSec: number): FaceTrack | null {
  const lo = frameAt(track, Math.min(fromSec, toSec));
  const hi = frameAt(track, Math.max(fromSec, toSec));
  if (hi <= lo) return null;
  const frames = framesFromFile(track.data).slice(lo, hi);
  return frames.length > 0 ? faceTrack(frames) : null;
}

/** The film with the stretch between two moments taken out. */
export function cutFaces(track: FaceTrack, fromSec: number, toSec: number): FaceTrack | null {
  const lo = frameAt(track, Math.min(fromSec, toSec));
  const hi = frameAt(track, Math.max(fromSec, toSec));
  if (hi <= lo) return track;
  const all = framesFromFile(track.data);
  const frames = [...all.slice(0, lo), ...all.slice(hi)];
  return frames.length > 0 ? faceTrack(frames) : null;
}

/** Two films back to back; null when either is missing (a film with a hole is no use to the model). */
export function joinFaces(a: FaceTrack | undefined, b: FaceTrack | undefined): FaceTrack | undefined {
  if (!a || !b) return undefined;
  return {
    fps: a.fps,
    frames: a.frames + b.frames,
    data: (() => {
      const out = new Uint8Array(a.data.length + b.data.length);
      out.set(a.data, 0);
      out.set(b.data, a.data.length);
      return out;
    })(),
  };
}
