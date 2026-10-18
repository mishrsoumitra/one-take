/**
 * Pure edits on the recording: cutting audio out of a phrase, splitting one, swapping or inserting
 * phrases, and the little geometry the editor needs (which clip is at a time, waveform peaks).
 *
 * A `Segment` is never changed in place. Every edit returns new objects, so the editor can keep old
 * lists for undo and the controller can tell by identity which phrases need saving again.
 */
import { concatClipVideo, sliceClipVideo, type ClipVideo } from './clip-video.js';
import { cutFaces, sliceFaces, type FaceTrack } from './faces.js';
import { cutInk, sliceInk, type ClipInk } from './ink.js';
import { segmentDuration, type Segment, type Timeline } from './timeline.js';
import { mapAudio } from './versions.js';

/** The fade on either side of a seam inside a phrase, so a cut never clicks. */
const SEAM_FADE_MS = 8;
/** Nothing shorter than this survives a cut; the detector itself drops bursts under 200 ms. */
export const MIN_CLIP_SEC = 0.05;

export type IdFactory = () => string;

function clampSec(seg: Segment, sec: number): number {
  return Math.max(0, Math.min(segmentDuration(seg), sec));
}

function sampleAt(seg: Segment, sec: number): number {
  return Math.round(clampSec(seg, sec) * seg.sampleRate);
}

/** The phrase's video between two sample positions, so a cut in the audio is the same cut in the picture. */
export function videoBetween(seg: Segment, fromSample: number, toSample: number): ClipVideo | null {
  if (!seg.video) return null;
  return sliceClipVideo(seg.video, fromSample / seg.sampleRate, toSample / seg.sampleRate);
}

/** A segment with its film set, or without one. */
function withFaces(seg: Segment, faces: FaceTrack | null | undefined): Segment {
  const { faces: _faces, ...rest } = seg;
  return faces ? { ...rest, faces } : rest;
}

/** A segment with its drawing set, or without one. */
function withInk(seg: Segment, ink: ClipInk | undefined): Segment {
  const { ink: _ink, ...rest } = seg;
  return ink ? { ...rest, ink } : rest;
}

/**
 * The stretch `[fromSample, toSample)` of a phrase: every version of its sound, its picture, its
 * film and its drawing cut the same way, in one place, so no edit can leave one of them behind.
 * Null when nothing worth keeping is in the stretch.
 */
export function sliceSegment(seg: Segment, fromSample: number, toSample: number): Segment | null {
  const lo = Math.max(0, Math.min(seg.pcm.length, Math.min(fromSample, toSample)));
  const hi = Math.max(0, Math.min(seg.pcm.length, Math.max(fromSample, toSample)));
  if (hi - lo < MIN_CLIP_SEC * seg.sampleRate) return null;
  const sliced = mapAudio(seg, (pcm) => pcm.slice(lo, hi));
  if (!sliced) return null;
  const sr = seg.sampleRate;
  const ms = (sample: number) => (sample / sr) * 1000;
  return withInk(
    withFaces(
      { ...sliced, video: seg.video ? videoBetween(seg, lo, hi) : seg.video },
      seg.faces ? sliceFaces(seg.faces, lo / sr, hi / sr) : undefined,
    ),
    seg.ink ? sliceInk(seg.ink, ms(lo), ms(hi)) : undefined,
  );
}

/** Joins two runs of samples with a short fade out and fade in around the seam. */
export function joinPcm(a: Int16Array, b: Int16Array, sampleRate: number, fadeMs = SEAM_FADE_MS): Int16Array {
  const out = new Int16Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  const n = Math.min(a.length, b.length, Math.round((sampleRate * fadeMs) / 1000));
  for (let i = 0; i < n; i++) {
    const g = i / n;
    const tail = a.length - 1 - i;
    out[tail] = Math.round((out[tail] ?? 0) * g);
    out[a.length + i] = Math.round((out[a.length + i] ?? 0) * g);
  }
  return out;
}

/**
 * Removes the audio between `fromSec` and `toSec` from a phrase, in every version of its sound, its
 * picture and its film alike. The result keeps the phrase's id and slide; it is `null` when nothing
 * worth keeping would be left.
 */
export function cutRange(seg: Segment, fromSec: number, toSec: number): Segment | null {
  const lo = sampleAt(seg, Math.min(fromSec, toSec));
  const hi = sampleAt(seg, Math.max(fromSec, toSec));
  if (hi <= lo) return seg;
  if (seg.pcm.length - (hi - lo) < MIN_CLIP_SEC * seg.sampleRate) return null;
  const cut = mapAudio(seg, (pcm) => {
    const head = pcm.subarray(0, lo);
    const tail = pcm.subarray(hi);
    return head.length === 0
      ? tail.slice()
      : tail.length === 0
        ? head.slice()
        : joinPcm(head, tail, seg.sampleRate);
  });
  if (!cut) return null;
  const video = seg.video
    ? concatClipVideo(videoBetween(seg, 0, lo), videoBetween(seg, hi, seg.pcm.length))
    : seg.video;
  const sr = seg.sampleRate;
  return withInk(
    withFaces({ ...cut, video }, seg.faces ? cutFaces(seg.faces, lo / sr, hi / sr) : undefined),
    seg.ink ? cutInk(seg.ink, (lo / sr) * 1000, (hi / sr) * 1000) : undefined,
  );
}

/** Keeps only the audio between `fromSec` and `toSec` (the opposite of {@link cutRange}). */
export function keepRange(seg: Segment, fromSec: number, toSec: number): Segment | null {
  return sliceSegment(seg, sampleAt(seg, Math.min(fromSec, toSec)), sampleAt(seg, Math.max(fromSec, toSec)));
}

/**
 * Splits a phrase in two at `atSec`. The first half keeps the id; the second half gets `newId` and is
 * marked as continuing the first, so the timeline plays them back to back with no gap, exactly as
 * before. Returns `null` when the cut would fall at either end.
 */
export function splitAt(seg: Segment, atSec: number, newId: string): [Segment, Segment] | null {
  const at = sampleAt(seg, atSec);
  const min = MIN_CLIP_SEC * seg.sampleRate;
  if (at < min || seg.pcm.length - at < min) return null;
  const first = sliceSegment(seg, 0, at);
  const rest = sliceSegment(seg, at, seg.pcm.length);
  if (!first || !rest) return null;
  const second: Segment = { ...rest, id: newId, joined: true, prevId: seg.id, createdAt: Date.now() };
  return [first, second];
}

/** One phrase of a take: its audio, the microphone before the filter when there was one, and its picture when the camera was on. */
export interface TakePhrase {
  pcm: Int16Array;
  raw: Int16Array | null;
  video: ClipVideo | null;
}

/** The phrases of one take, as new segments spoken on one slide. */
export function takeToSegments(
  phrases: readonly TakePhrase[],
  sampleRate: number,
  slide: number,
  nextId: IdFactory,
): Segment[] {
  return phrases
    .filter((p) => p.pcm.length > 0)
    .map((p) => ({
      id: nextId(),
      slide,
      sampleRate,
      pcm: p.pcm,
      ...(p.raw ? { raw: p.raw } : {}),
      joined: false,
      prevId: null,
      createdAt: Date.now(),
      video: p.video,
    }));
}

/** A new list with `count` phrases from `index` replaced by `withSegs`. */
export function replaceAt(
  list: readonly Segment[],
  index: number,
  count: number,
  withSegs: readonly Segment[],
): Segment[] {
  const out = list.slice();
  out.splice(index, count, ...withSegs);
  return out;
}

/** A new list with `segs` inserted before position `at` (`at === list.length` appends). */
export function insertAt(list: readonly Segment[], at: number, segs: readonly Segment[]): Segment[] {
  const out = list.slice();
  out.splice(Math.max(0, Math.min(list.length, at)), 0, ...segs);
  return out;
}

export function removeAt(list: readonly Segment[], index: number): Segment[] {
  const out = list.slice();
  out.splice(index, 1);
  return out;
}

/** A new list with the phrase at `index` shown on another slide. */
export function withSlide(list: readonly Segment[], index: number, slide: number): Segment[] {
  const seg = list[index];
  if (!seg || seg.slide === slide) return list.slice();
  return replaceAt(list, index, 1, [{ ...seg, slide }]);
}

export interface TimelineHit {
  /** Index into `timeline.items`. */
  index: number;
  /** Seconds into the phrase; negative while still inside the silence before it. */
  offset: number;
}

/** Which phrase is playing at `sec` on the timeline (the last one once the end is reached). */
export function itemAt(timeline: Timeline, sec: number): TimelineHit | null {
  const items = timeline.items;
  if (items.length === 0) return null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it && sec < it.end) return { index: i, offset: sec - it.start };
  }
  const last = items[items.length - 1];
  return last ? { index: items.length - 1, offset: sec - last.start } : null;
}

/** Peak amplitude (0 to 1) for each of `columns` equal slices of the phrase, for drawing a waveform. */
export function peaks(pcm: Int16Array, columns: number): Float32Array {
  const out = new Float32Array(Math.max(0, columns));
  if (columns <= 0 || pcm.length === 0) return out;
  const per = pcm.length / columns;
  for (let c = 0; c < columns; c++) {
    const from = Math.floor(c * per);
    const to = Math.max(from + 1, Math.floor((c + 1) * per));
    let max = 0;
    for (let i = from; i < to && i < pcm.length; i++) {
      const v = Math.abs(pcm[i] ?? 0);
      if (v > max) max = v;
    }
    out[c] = max / 32768;
  }
  return out;
}
