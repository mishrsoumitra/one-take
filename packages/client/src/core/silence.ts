/**
 * Finding and removing the pauses in a phrase or a clip, with the second listen's scores.
 *
 * Every phrase the live detector finishes comes through `cutPhrase` before it is stored: the live
 * detector only decides that something which could be a voice is going on, so what it hands over
 * still holds the pauses longer than the hangover, the dead air at either end, and now and then a
 * sound that was never a voice at all. The second listen (`hindsight.ts`) scores the whole of it,
 * `speechRanges` turns the scores into the stretches with a voice (padded with the same pre-roll and
 * tail as always), and `cutRanges` says what to keep.
 *
 * The editor's **Remove pauses** applies the same rules to clips that are already recorded, through
 * `trimSilences`: every clip is scored from start to end and rebuilt from the stretches with a voice
 * alone, as several clips when a pause longer than the hangover sat between them.
 *
 * Pure functions apart from the scoring; the editor and the recorder do the commit.
 */
import { type IdFactory, sliceSegment } from './edit.js';
import { listenAgain } from './hindsight.js';
import { type PhraseVerdict } from './recorder.js';
import { SPEECH_FRAME_SEC, SPEECH_KEEP, SPEECH_START } from './speech.js';
import { segmentDuration, type Segment } from './timeline.js';
import { type VadSettings } from './vad.js';

/** Seconds into a clip. */
export interface Range {
  from: number;
  to: number;
}

export type SilenceSettings = Pick<VadSettings, 'hangoverMs' | 'prerollMs' | 'tailMs' | 'minSpeechMs'>;

/** What to keep of a clip, in seconds, and whether its ends were touched. */
export interface Cut {
  keep: Range[];
  startCut: boolean;
  endCut: boolean;
}

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
    const { keep } = cutRanges(found, total);
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
      // every version of the sound, the picture and the film, cut the same way
      const piece = sliceSegment(base, Math.round(range.from * sr), Math.round(range.to * sr));
      if (!piece) return;
      out.push({
        ...piece,
        id: last ? seg.id : nextId(),
        joined: seamless ? base.joined : false,
        prevId: seamless ? base.prevId : null,
      });
    });
    if ((keep[keep.length - 1]?.to ?? total) < total) brokenJoin = seg.id;
  }
  return { segments: out, removedSec, changed };
}

/**
 * What to keep of a clip from the stretches with a voice in it: the ranges clamped to the clip, with
 * a sliver of silence at either end left in place, and whether either end was cut.
 */
export function cutRanges(ranges: readonly Range[], totalSec: number): Cut {
  const keep = ranges
    .map((r) => ({ from: Math.max(0, r.from), to: Math.min(totalSec, r.to) }))
    .filter((r) => r.to > r.from);
  const first = keep[0];
  const last = keep[keep.length - 1];
  if (first && first.from < EDGE_SLACK_SEC) first.from = 0;
  if (last && totalSec - last.to < EDGE_SLACK_SEC) last.to = totalSec;
  return { keep, startCut: !first || first.from > 0, endCut: !last || last.to < totalSec };
}

/**
 * The second listen over a phrase the live detector has just finished: the blocks are scored as one
 * clip and the verdict says which blocks to keep. Block boundaries are where the cuts fall, so the
 * blocks themselves are handed on untouched.
 */
export async function cutPhrase(
  blocks: readonly Float32Array[],
  sampleRate: number,
  settings: SilenceSettings,
): Promise<PhraseVerdict> {
  const samples = new Float32Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of blocks) {
    samples.set(b, at);
    at += b.length;
  }
  const totalSec = samples.length / sampleRate;
  const probs = await listenAgain(samples, sampleRate);
  const cut = cutRanges(speechRanges(probs, totalSec, settings), totalSec);
  // seconds to block indices: a block is kept when the range covers its middle
  const middles: number[] = [];
  let t = 0;
  for (const b of blocks) {
    middles.push(t + b.length / sampleRate / 2);
    t += b.length / sampleRate;
  }
  const firstFrom = (sec: number): number => {
    let k = 0;
    while (k < middles.length && (middles[k] ?? 0) < sec) k++;
    return k;
  };
  const keep = cut.keep
    .map((r) => ({ from: firstFrom(r.from), to: firstFrom(r.to) }))
    .filter((r) => r.to > r.from);
  const first = keep[0];
  const last = keep[keep.length - 1];
  return { keep, startCut: !first || first.from > 0, endCut: !last || last.to < blocks.length };
}
