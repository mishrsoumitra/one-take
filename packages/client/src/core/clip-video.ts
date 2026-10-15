/**
 * The camera's picture of the speaker, kept with each phrase.
 *
 * A phrase is audio first: pauses are cut out of it, it is split at slide changes, the editor cuts
 * stretches out of it and the export may play it faster. The video has to follow every one of those
 * cuts without ever being decoded and encoded again, so it is stored as the encoder produced it,
 * with a little arithmetic around it:
 *
 * - A clip's video is a list of **pieces** played back to back. Each piece is a run of encoded frames
 *   that starts at a key frame, and says where in those frames the piece's audio begins (`startUs`)
 *   and how long it plays (`durationUs`). Frames before `startUs` are decoded and thrown away, which
 *   costs at most a second (the gap between key frames) per piece.
 * - Cutting a stretch out of a clip makes two pieces; splitting a clip gives each half the pieces it
 *   needs; keeping only a stretch keeps one piece. Nothing is re-encoded, a piece only moves its
 *   start and loses the frames it no longer reaches.
 * - Playing the audio faster leaves the frames alone and raises the piece's `rate`: the picture then
 *   runs through the frames that much faster.
 *
 * Time inside a piece runs from 0 to `durationUs` at the pace of the audio; the frame to show at
 * piece time `p` is the last one whose timestamp is at or before `startUs + p × rate`. Before the
 * first frame, the first frame is shown (a picture a little early is better than a hole).
 *
 * Everything here is plain arithmetic on plain objects, so it runs in tests as well as in the browser.
 */

/** One encoded frame; `data` is what the encoder produced (Annex B H.264 or a VP8 frame). */
export interface EncodedFrame {
  key: boolean;
  /** Microseconds on the piece's own clock. */
  timestamp: number;
  /** Microseconds the frame is meant to stay on screen. */
  duration: number;
  data: Uint8Array;
}

export interface VideoPiece {
  /** In order, starting at a key frame. */
  frames: EncodedFrame[];
  /** Frame time at which the piece's audio starts, in µs; may be negative when the camera came on a moment late. */
  startUs: number;
  /** How long the piece plays, in µs of audio. */
  durationUs: number;
  /** Frame time per unit of piece time: 1 as recorded, 1.5 when the audio was made 1.5× faster. */
  rate: number;
}

/** A phrase's video: the codec the frames are in, their size, and the pieces to play back to back. */
export interface ClipVideo {
  /** A WebCodecs codec string: `avc1.42E01F` (Annex B, so no description is needed) or `vp8`. */
  codec: string;
  width: number;
  height: number;
  pieces: VideoPiece[];
}

export const US = 1_000_000;

/**
 * A stretch whose last frame before it is older than this has no picture: the camera had stopped
 * delivering (it was paused, or came on later), and a frozen frame would be wrong.
 */
const STALE_US = 500_000;

/** How long the clip's video plays, in seconds. */
export function clipVideoDuration(video: ClipVideo): number {
  return video.pieces.reduce((sum, p) => sum + p.durationUs, 0) / US;
}

/** The frame time (µs) that piece time `pieceUs` maps to. */
export function frameTimeAt(piece: VideoPiece, pieceUs: number): number {
  return piece.startUs + pieceUs * piece.rate;
}

/** Index of the frame to show at frame time `atUs`: the last one at or before it, else the first. */
export function frameIndexAt(frames: readonly EncodedFrame[], atUs: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  if (hi < 0 || (frames[0]?.timestamp ?? 0) > atUs) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((frames[mid]?.timestamp ?? Infinity) <= atUs) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Index of the last key frame at or before `index` (0 when none: pieces always start on one). */
export function keyFrameBefore(frames: readonly EncodedFrame[], index: number): number {
  for (let k = Math.min(index, frames.length - 1); k > 0; k--) if (frames[k]?.key) return k;
  return 0;
}

/**
 * A piece cut from a run of frames stamped on one clock (the camera's recording clock): the frames
 * from the last key frame at or before `fromUs` up to `toUs`, with timestamps rebased so the first
 * kept frame is at 0. Null when no frame falls inside the stretch.
 */
export function pieceFromFrames(
  frames: readonly EncodedFrame[],
  fromUs: number,
  toUs: number,
): VideoPiece | null {
  if (toUs <= fromUs) return null;
  const last = lastFrameBefore(frames, toUs);
  // no frame inside the stretch or just before it: the camera has nothing of this moment
  if (last < 0 || (frames[last]?.timestamp ?? -Infinity) < fromUs - STALE_US) return null;
  const first = keyFrameBefore(frames, frameIndexAt(frames, fromUs));
  if (!frames[first]?.key) return null;
  const kept = frames.slice(first, last + 1);
  if (kept.length === 0) return null;
  const base = kept[0]?.timestamp ?? 0;
  return {
    frames: kept.map((f) => ({ ...f, timestamp: f.timestamp - base })),
    startUs: fromUs - base,
    durationUs: toUs - fromUs,
    rate: 1,
  };
}

/** Index of the last frame whose timestamp is before `atUs`, or -1. */
function lastFrameBefore(frames: readonly EncodedFrame[], atUs: number): number {
  let k = frames.length - 1;
  while (k >= 0 && (frames[k]?.timestamp ?? 0) >= atUs) k--;
  return k;
}

/** The stretch `[fromUs, toUs)` of a piece's own time as a piece of its own; null when empty. */
export function slicePiece(piece: VideoPiece, fromUs: number, toUs: number): VideoPiece | null {
  const from = Math.max(0, fromUs);
  const to = Math.min(piece.durationUs, toUs);
  if (to <= from) return null;
  if (from === 0 && to === piece.durationUs) return piece;
  const startUs = frameTimeAt(piece, from);
  const endUs = frameTimeAt(piece, to);
  const first = keyFrameBefore(piece.frames, frameIndexAt(piece.frames, startUs));
  let last = piece.frames.length - 1;
  while (last > first && (piece.frames[last]?.timestamp ?? 0) >= endUs) last--;
  const kept = piece.frames.slice(first, last + 1);
  const base = kept[0]?.timestamp ?? 0;
  return {
    frames: base === 0 ? kept : kept.map((f) => ({ ...f, timestamp: f.timestamp - base })),
    startUs: startUs - base,
    durationUs: to - from,
    rate: piece.rate,
  };
}

/** The stretch `[fromSec, toSec)` of a clip's video; null when nothing of it is left. */
export function sliceClipVideo(video: ClipVideo, fromSec: number, toSec: number): ClipVideo | null {
  const fromUs = Math.round(Math.min(fromSec, toSec) * US);
  const toUs = Math.round(Math.max(fromSec, toSec) * US);
  const pieces: VideoPiece[] = [];
  let at = 0;
  for (const piece of video.pieces) {
    const end = at + piece.durationUs;
    if (end > fromUs && at < toUs) {
      const cut = slicePiece(piece, fromUs - at, toUs - at);
      if (cut) pieces.push(cut);
    }
    at = end;
  }
  return pieces.length > 0 ? { ...video, pieces } : null;
}

/** `a` then `b`; either may be missing. Both must come from the same camera (same codec and size). */
export function concatClipVideo(a: ClipVideo | null, b: ClipVideo | null): ClipVideo | null {
  if (!a) return b;
  if (!b) return a;
  return { ...a, pieces: [...a.pieces, ...b.pieces] };
}

/** The same frames played `speed` times faster (or slower), to follow audio that was stretched. */
export function clipVideoAtSpeed(video: ClipVideo, speed: number): ClipVideo {
  if (Math.abs(speed - 1) < 0.005) return video;
  return {
    ...video,
    pieces: video.pieces.map((p) => ({
      ...p,
      durationUs: Math.round(p.durationUs / speed),
      rate: p.rate * speed,
    })),
  };
}

/** Bytes the clip's video takes in memory. */
export function clipVideoBytes(video: ClipVideo): number {
  let n = 0;
  for (const p of video.pieces) for (const f of p.frames) n += f.data.byteLength;
  return n;
}
