/**
 * What is done to the recording on the way out, before a single frame is encoded: filler words cut,
 * the volume evened out, the pace changed. Everything here is arithmetic on the stored phrases in the
 * browser; the phrases themselves are never changed, new ones are made for the export.
 *
 * It also keeps the arithmetic to carry a time on an original phrase over to the final video (for the
 * subtitles, which are transcribed from the original audio): subtract the cuts before it, divide by
 * the speed, add where the phrase starts on the final timeline.
 */
import { type Enhance, type TranscriptWord } from '@one-take/shared';

import { clipVideoAtSpeed } from '../core/clip-video.js';
import { cutRange } from '../core/edit.js';
import {
  FILLER_THRESHOLD,
  scoreFillers,
  toAnalysisRate,
  type FillerCandidate,
  type FillerSensitivity,
} from '../core/fillers.js';
import { Downsampler } from '../core/speech.js';
import { stretchedLength, stretchPcm } from '../core/stretch.js';
import {
  buildTimeline,
  segmentDuration,
  type PhraseOrder,
  type Segment,
  type Timeline,
  type TimelineSettings,
} from '../core/timeline.js';

/** One filler found in one phrase. The id is stable across scans, so the user's choices stick. */
export interface FillerHit {
  id: string;
  segmentId: string;
  candidate: FillerCandidate;
}

export interface FillerScan {
  hits: FillerHit[];
  /** Seconds the cuts would remove. */
  removedSec: number;
}

/** Every voiced run of a phrase, scored, kept per phrase object: a phrase never changes once stored. */
const scanned = new WeakMap<Segment, FillerCandidate[]>();

const yieldToPage = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Scans the phrases for fillers at `sensitivity`. The heavy part (one pass of the detector over each
 * phrase) runs once per phrase and is remembered; changing the sensitivity only re-reads the scores.
 */
export async function scanFillers(
  segments: readonly Segment[],
  sensitivity: FillerSensitivity,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<FillerScan> {
  const threshold = FILLER_THRESHOLD[sensitivity];
  const hits: FillerHit[] = [];
  let removedSec = 0;
  const total = segments.reduce((sum, s) => sum + segmentDuration(s), 0);
  let done = 0;
  for (const seg of segments) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    let candidates = scanned.get(seg);
    if (!candidates) {
      candidates = scoreFillers(toAnalysisRate(seg.pcm, seg.sampleRate));
      scanned.set(seg, candidates);
      await yieldToPage();
    }
    candidates.forEach((candidate, index) => {
      if (candidate.score < threshold) return;
      hits.push({ id: `${seg.id}:${index}`, segmentId: seg.id, candidate });
      removedSec += candidate.cutTo - candidate.cutFrom;
    });
    done += segmentDuration(seg);
    onProgress?.(total > 0 ? done / total : 1);
  }
  return { hits, removedSec };
}

/** Whether a request changes anything before the encode. */
export function needsPreparation(enhance: Enhance): boolean {
  return enhance.speed !== 1 || enhance.evenLoudness || enhance.fillers.remove;
}

/* ------------------------------------------------------------------ */
/* Loudness                                                            */
/* ------------------------------------------------------------------ */

/** Where every phrase's speech level is brought to, and how far a gain may go either way. */
const TARGET_DB = -20;
const GAIN_MIN = 0.5;
const GAIN_MAX = 8;
/** No sample is pushed past this after the gain. */
const PEAK_MAX = 0.98;
const LEVEL_BLOCK_SEC = 0.05;

/**
 * The gain that brings a phrase's speech level to the target: the level is the root mean square of
 * the loudest fifth of its 50 ms blocks (the words, not the pauses), and the gain never lets a peak
 * clip or swings more than 18 dB up or 6 dB down.
 */
export function evenGain(pcm: Int16Array, sampleRate: number): number {
  const block = Math.max(1, Math.round(sampleRate * LEVEL_BLOCK_SEC));
  const levels: number[] = [];
  let peak = 0;
  for (let at = 0; at + block <= pcm.length; at += block) {
    let sum = 0;
    for (let i = at; i < at + block; i++) {
      const v = (pcm[i] ?? 0) / 32768;
      sum += v * v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    levels.push(Math.sqrt(sum / block));
  }
  if (levels.length === 0) return 1;
  levels.sort((a, b) => b - a);
  const loudest = levels.slice(0, Math.max(1, Math.ceil(levels.length / 5)));
  const level = loudest.reduce((a, b) => a + b, 0) / loudest.length;
  if (level < 1e-5) return 1;
  let gain = 10 ** (TARGET_DB / 20) / level;
  gain = Math.max(GAIN_MIN, Math.min(GAIN_MAX, gain));
  if (peak * gain > PEAK_MAX) gain = PEAK_MAX / peak;
  return gain;
}

function withGain(pcm: Int16Array, gain: number): Int16Array {
  if (Math.abs(gain - 1) < 0.01) return pcm;
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    out[i] = Math.max(-32768, Math.min(32767, Math.round((pcm[i] ?? 0) * gain)));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Preparing                                                           */
/* ------------------------------------------------------------------ */

/** How a time on one original phrase is carried to the final timeline. */
export interface SegmentMap {
  /** The cuts made, in seconds on the original phrase, in order and not overlapping. */
  cuts: { from: number; to: number }[];
  speed: number;
  /** Where the phrase starts on the final timeline; null when nothing of it survived. */
  itemStart: number | null;
}

export interface PrepareOptions {
  enhance: Enhance;
  /** Ids of filler hits the user chose to keep after all. */
  keep?: ReadonlySet<string>;
  order: PhraseOrder;
  settings: TimelineSettings;
  signal?: AbortSignal;
  onProgress?: (fraction: number, message: string) => void;
}

export interface Prepared {
  segments: Segment[];
  timeline: Timeline;
  maps: Map<string, SegmentMap>;
  /** The fillers that were cut. */
  removed: FillerHit[];
}

/** The phrases as the export will hear them, plus the timeline built from them. */
export async function prepareSegments(
  segments: readonly Segment[],
  options: PrepareOptions,
): Promise<Prepared> {
  const { enhance, signal, onProgress } = options;
  const keep = options.keep ?? new Set<string>();
  const speed = enhance.speed;
  const maps = new Map<string, SegmentMap>();
  const removed: FillerHit[] = [];
  const out: Segment[] = [];
  let scan: FillerScan | null = null;
  if (enhance.fillers.remove) {
    onProgress?.(0, 'Looking for filler words…');
    scan = await scanFillers(
      segments,
      enhance.fillers.sensitivity,
      (f) => onProgress?.(f * 0.5, 'Looking for filler words…'),
      signal,
    );
  }
  const total = segments.reduce((sum, s) => sum + segmentDuration(s), 0);
  let done = 0;
  for (const seg of segments) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const map: SegmentMap = { cuts: [], speed, itemStart: null };
    maps.set(seg.id, map);
    let current: Segment | null = seg;
    // the cuts, last first, so the earlier times stay valid while cutting
    const hits = (scan?.hits ?? []).filter((h) => h.segmentId === seg.id && !keep.has(h.id));
    const cuts = hits
      .map((h) => ({ from: h.candidate.cutFrom, to: h.candidate.cutTo, hit: h }))
      .sort((a, b) => a.from - b.from);
    // overlapping cuts (two fillers in one pause) become one
    const merged: { from: number; to: number; hits: FillerHit[] }[] = [];
    for (const c of cuts) {
      const last = merged[merged.length - 1];
      if (last && c.from <= last.to) {
        last.to = Math.max(last.to, c.to);
        last.hits.push(c.hit);
      } else merged.push({ from: c.from, to: c.to, hits: [c.hit] });
    }
    for (let i = merged.length - 1; i >= 0 && current; i--) {
      const c = merged[i];
      if (!c) continue;
      current = cutRange(current, c.from, c.to);
    }
    map.cuts = merged.map((c) => ({ from: c.from, to: c.to }));
    for (const c of merged) removed.push(...c.hits);
    if (current) {
      if (enhance.evenLoudness)
        current = { ...current, pcm: withGain(current.pcm, evenGain(current.pcm, current.sampleRate)) };
      if (speed !== 1) {
        current = {
          ...current,
          pcm: stretchPcm(current.pcm, current.sampleRate, speed),
          // the picture keeps its frames and runs through them faster, in step with the voice
          video: current.video ? clipVideoAtSpeed(current.video, speed) : current.video,
        };
        await yieldToPage();
      }
      out.push(current);
    }
    done += segmentDuration(seg);
    onProgress?.(
      (scan ? 0.5 : 0) + (total > 0 ? done / total : 1) * (scan ? 0.5 : 1),
      'Preparing the audio…',
    );
  }
  // a phrase that continued one that is now gone gets an ordinary pause instead
  const ids = new Set(out.map((s) => s.id));
  const fixed = out.map((s) =>
    s.joined && s.prevId !== null && !ids.has(s.prevId) ? { ...s, joined: false, prevId: null } : s,
  );
  const timeline = buildTimeline(fixed, options.order, options.settings);
  for (const item of timeline.items) {
    const map = maps.get(item.seg.id);
    if (map) map.itemStart = item.start;
  }
  return { segments: fixed, timeline, maps, removed };
}

/** A time on the original phrase on the final timeline; null when it fell inside a cut or the phrase is gone. */
export function mapToFinal(map: SegmentMap, originalSec: number): number | null {
  if (map.itemStart === null) return null;
  let t = originalSec;
  let removedBefore = 0;
  for (const c of map.cuts) {
    if (originalSec >= c.from && originalSec < c.to) return null;
    if (c.to <= originalSec) removedBefore += c.to - c.from;
  }
  t -= removedBefore;
  return map.itemStart + t / map.speed;
}

/** The final video's length before the work is done: what the plan and the estimate use. */
export function plannedDuration(timeline: Timeline, enhance: Enhance, removedSec: number): number {
  const gaps = timeline.items.reduce((sum, it) => sum + it.gap, 0);
  const speech = Math.max(0, timeline.total - gaps - (enhance.fillers.remove ? removedSec : 0));
  return speech / enhance.speed + gaps;
}

/* ------------------------------------------------------------------ */
/* Audio for the recogniser                                            */
/* ------------------------------------------------------------------ */

export const TRANSCRIBE_RATE = 16000;
/** Silence put between phrases, so the recogniser never runs two phrases into one word. */
const TRANSCRIBE_GAP_SEC = 0.5;

export interface TranscriptionAudio {
  wav: Uint8Array;
  /** Where each phrase starts in the audio sent, in seconds. */
  offsets: { segmentId: string; start: number; durationSec: number }[];
  durationSec: number;
}

/** The original phrases as one 16 kHz mono WAV, half a second apart. */
export function transcriptionAudio(segments: readonly Segment[]): TranscriptionAudio {
  const pieces: Int16Array[] = [];
  const offsets: TranscriptionAudio['offsets'] = [];
  const gap = new Int16Array(Math.round(TRANSCRIBE_RATE * TRANSCRIBE_GAP_SEC));
  let position = 0;
  for (const seg of segments) {
    const floats = new Float32Array(seg.pcm.length);
    for (let i = 0; i < floats.length; i++) floats[i] = (seg.pcm[i] ?? 0) / 32768;
    const down =
      seg.sampleRate === TRANSCRIBE_RATE
        ? floats
        : new Downsampler(seg.sampleRate, TRANSCRIBE_RATE).process(floats);
    const pcm = new Int16Array(down.length);
    for (let i = 0; i < down.length; i++) {
      const v = Math.max(-1, Math.min(1, down[i] ?? 0));
      pcm[i] = Math.round(v < 0 ? v * 32768 : v * 32767);
    }
    offsets.push({
      segmentId: seg.id,
      start: position / TRANSCRIBE_RATE,
      durationSec: pcm.length / TRANSCRIBE_RATE,
    });
    pieces.push(pcm, gap);
    position += pcm.length + gap.length;
  }
  const samples = position;
  const wav = new Uint8Array(44 + samples * 2);
  const view = new DataView(wav.buffer);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TRANSCRIBE_RATE, true);
  view.setUint32(28, TRANSCRIBE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  let at = 44;
  for (const piece of pieces) {
    for (const sample of piece) {
      view.setInt16(at, sample, true);
      at += 2;
    }
  }
  return { wav, offsets, durationSec: samples / TRANSCRIBE_RATE };
}

/**
 * Words as the recogniser heard them in the audio that was sent, carried onto the final timeline:
 * words inside a cut filler vanish, the rest move with the cuts and the speed.
 */
export function mapWords(
  words: readonly TranscriptWord[],
  audio: TranscriptionAudio,
  maps: ReadonlyMap<string, SegmentMap>,
): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  let k = 0;
  const offsets = audio.offsets;
  for (const w of words) {
    const mid = (w.start + w.end) / 2;
    while (k + 1 < offsets.length && mid >= (offsets[k + 1]?.start ?? Infinity)) k++;
    // a word that fell into the silence between phrases goes to the earlier phrase, clamped
    const slot = offsets[k];
    if (!slot) continue;
    const map = maps.get(slot.segmentId);
    if (!map) continue;
    const local = (t: number) => Math.max(0, Math.min(slot.durationSec, t - slot.start));
    const start = mapToFinal(map, local(w.start));
    const end = mapToFinal(map, local(w.end));
    if (start === null && end === null) continue;
    const s = start ?? end ?? 0;
    const e = end ?? start ?? s;
    out.push({ text: w.text, start: s, end: Math.max(s, e) });
  }
  return out;
}

export { stretchedLength };
