/**
 * Finding and removing the pauses inside clips that are already recorded.
 *
 * The live detector should have cut them, but a recording made before the voice detector was there,
 * or in a room loud enough to fool a level-only detector, can carry minutes of silence inside a clip.
 * This takes the voice detector's score for every frame of a clip, finds the stretches with a voice in
 * them (padded with the same pre-roll and tail the live detector keeps) and rebuilds the clip from
 * those stretches alone, as several clips when a pause longer than the hangover sat between them.
 *
 * Pure functions: the scores come from `scoreClip` in `speech.ts`, the editor does the commit.
 */
import { type IdFactory } from './edit.js';
import { SPEECH_FRAME_SEC, SPEECH_KEEP, SPEECH_START } from './speech.js';
import { segmentDuration, type Segment } from './timeline.js';
import { type VadSettings } from './vad.js';

/** Seconds into a clip. */
export interface Range {
  from: number;
  to: number;
}

export type SilenceSettings = Pick<VadSettings, 'hangoverMs' | 'prerollMs' | 'tailMs' | 'minSpeechMs'>;

/**
 * Silence at either end of a clip up to this long is left alone: it is the pre-roll and tail the live
 * detector keeps on purpose, and cutting it would only churn clips that are already right.
 */
export const EDGE_SLACK_SEC = 0.3;

/**
 * The stretches of a clip that hold a voice, from one score per frame of `frameSec` seconds. A
 * stretch starts at the first frame scored as voice, ends when `hangoverMs` of frames without one
 * follow, is padded with `prerollMs` in front and `tailMs` behind, and is dropped when it held less
 * than `minSpeechMs` of voice: the live detector's rules, applied after the fact.
 */
export function speechRanges(
  probs: ArrayLike<number>,
  totalSec: number,
  settings: SilenceSettings,
  frameSec = SPEECH_FRAME_SEC,
): Range[] {
  const hang = settings.hangoverMs / 1000;
  const pre = settings.prerollMs / 1000;
  const tail = settings.tailMs / 1000;
  const min = settings.minSpeechMs / 1000;
  const out: Range[] = [];
  const push = (from: number, to: number) => {
    const range = { from: Math.max(0, from - pre), to: Math.min(totalSec, to + tail) };
    const last = out[out.length - 1];
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else out.push(range);
  };
  let speaking = false;
  let start = 0;
  let lastVoice = 0;
  let voiced = 0;
  for (let k = 0; k < probs.length; k++) {
    const t0 = k * frameSec;
    const t1 = Math.min(totalSec, t0 + frameSec);
    if (t1 <= t0) break;
    const p = probs[k] ?? 0;
    const voice = speaking ? p >= SPEECH_KEEP : p >= SPEECH_START;
    if (!speaking) {
      if (voice) {
        speaking = true;
        start = t0;
        lastVoice = t1;
        voiced = t1 - t0;
      }
      continue;
    }
    if (voice) {
      lastVoice = t1;
      voiced += t1 - t0;
    } else if (t1 - lastVoice >= hang) {
      if (voiced >= min) push(start, lastVoice);
      speaking = false;
    }
  }
  if (speaking && voiced >= min) push(start, lastVoice);
  return out;
}

export interface TrimResult {
  segments: Segment[];
  /** Seconds of audio removed altogether. */
  removedSec: number;
  /** Clips that were trimmed, split or removed. */
  changed: number;
}

/**
 * Rebuilds every clip that has ranges in `ranges` from those ranges alone. A clip whose ranges cover
 * it already is kept as the same object; one with no range at all (nothing but silence) goes. The
 * last piece of a clip keeps its id, so a clip that continued it still does; the first piece keeps
 * the join to the clip before it only when nothing was cut in front of it. A clip that continued
 * one whose end was cut, or that was removed, now gets the normal pause before it instead.
 */
export function trimSilences(
  list: readonly Segment[],
  ranges: ReadonlyMap<string, readonly Range[]>,
  nextId: IdFactory,
): TrimResult {
  const out: Segment[] = [];
  let removedSec = 0;
  let changed = 0;
  /** The clip before, when its end was cut or it was removed: nothing can continue it seamlessly now. */
  let brokenJoin: string | null = null;
  for (const seg of list) {
    const base: Segment =
      brokenJoin !== null && seg.joined && seg.prevId === brokenJoin
        ? { ...seg, joined: false, prevId: null }
        : seg;
    brokenJoin = null;
    const total = segmentDuration(seg);
    const found = ranges.get(seg.id);
    if (!found) {
      out.push(base);
      continue;
    }
    const keep = snapEdges(found, total);
    const first = keep[0];
    if (keep.length === 1 && first?.from === 0 && first.to >= total) {
      out.push(base);
      continue;
    }
    changed++;
    removedSec += total - keep.reduce((sum, r) => sum + (r.to - r.from), 0);
    if (keep.length === 0) {
      brokenJoin = seg.id;
      continue;
    }
    const sr = seg.sampleRate;
    keep.forEach((range, i) => {
      const last = i === keep.length - 1;
      const seamless = i === 0 && range.from === 0;
      out.push({
        ...base,
        id: last ? seg.id : nextId(),
        pcm: seg.pcm.slice(Math.round(range.from * sr), Math.round(range.to * sr)),
        joined: seamless ? base.joined : false,
        prevId: seamless ? base.prevId : null,
      });
    });
    if ((keep[keep.length - 1]?.to ?? total) < total) brokenJoin = seg.id;
  }
  return { segments: out, removedSec, changed };
}

/** Ranges clamped to the clip, with a sliver of silence at either end left in place. */
function snapEdges(ranges: readonly Range[], totalSec: number): Range[] {
  const out = ranges
    .map((r) => ({ from: Math.max(0, r.from), to: Math.min(totalSec, r.to) }))
    .filter((r) => r.to > r.from);
  const first = out[0];
  const last = out[out.length - 1];
  if (first && first.from < EDGE_SLACK_SEC) first.from = 0;
  if (last && totalSec - last.to < EDGE_SLACK_SEC) last.to = totalSec;
  return out;
}
