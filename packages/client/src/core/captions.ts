/**
 * From words with times to subtitles: cues of one or two short lines that stay on screen long enough
 * to read, break where the speaker paused or a sentence ended, and never overlap. Plus the writers
 * for SubRip (.srt), WebVTT (.vtt) and a plain transcript (.txt). Pure functions, tested in Node.
 */

/** One word as the recogniser heard it, in seconds on the final video's timeline. */
export interface TranscriptWord {
  text: string;
  start: number;
  end: number;
}

export interface Cue {
  start: number;
  end: number;
  lines: string[];
}

export interface CueOptions {
  /** Characters per line, the usual broadcast figure. */
  maxChars: number;
  maxLines: number;
  /** Seconds a cue may stay, and must stay at least (when the next cue allows). */
  maxDuration: number;
  minDuration: number;
  /** A silence this long between two words starts a new cue. */
  gapBreak: number;
  /** Seconds kept clear between one cue leaving and the next arriving. */
  gapBetween: number;
}

export const DEFAULT_CUES: CueOptions = {
  maxChars: 42,
  maxLines: 2,
  maxDuration: 6,
  minDuration: 1,
  gapBreak: 0.7,
  gapBetween: 0.04,
};

const SENTENCE_END = /[.!?…]["')\]]?$/;
const CLAUSE_END = /[,;:]["')\]]?$/;

/** Greedy line breaks at spaces, then the last two lines balanced when there are two. */
export function wrapLines(words: readonly string[], maxChars: number, maxLines: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    const next = current ? `${current} ${w}` : w;
    if (next.length <= maxChars || current === '') {
      current = next;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  if (lines.length === 2 && maxLines >= 2) {
    // move words from the first line to the second while that makes the lines more even
    const a = (lines[0] ?? '').split(' ');
    const b = (lines[1] ?? '').split(' ');
    while (a.length > 1) {
      const moved = a[a.length - 1] ?? '';
      const newA = a.slice(0, -1).join(' ');
      const newB = [moved, ...b].join(' ');
      if (newB.length > maxChars) break;
      if (Math.abs(newA.length - newB.length) >= Math.abs(a.join(' ').length - b.join(' ').length)) break;
      a.pop();
      b.unshift(moved);
    }
    lines[0] = a.join(' ');
    lines[1] = b.join(' ');
  }
  return lines.slice(0, maxLines);
}

/** Groups words into cues. Words are expected in time order; empty ones are skipped. */
export function buildCues(words: readonly TranscriptWord[], options: CueOptions = DEFAULT_CUES): Cue[] {
  const cues: Cue[] = [];
  let group: TranscriptWord[] = [];
  const capacity = options.maxChars * options.maxLines;
  const flush = () => {
    if (group.length === 0) return;
    const first = group[0];
    const last = group[group.length - 1];
    if (!first || !last) return;
    cues.push({
      start: first.start,
      end: Math.max(last.end, first.start + 0.1),
      lines: wrapLines(
        group.map((w) => w.text),
        options.maxChars,
        options.maxLines,
      ),
    });
    group = [];
  };
  for (const raw of words) {
    const text = raw.text.trim();
    if (!text) continue;
    const word = { text, start: raw.start, end: Math.max(raw.end, raw.start) };
    const first = group[0];
    const prev = group[group.length - 1];
    if (first && prev) {
      const chars = group.reduce((sum, w) => sum + w.text.length + 1, 0) + text.length;
      const tooLong = chars > capacity;
      const tooSlow = word.end - first.start > options.maxDuration;
      const pause = word.start - prev.end >= options.gapBreak;
      const sentence = SENTENCE_END.test(prev.text);
      // a clause end is a good place to break once the cue is more than half full
      const clause = CLAUSE_END.test(prev.text) && chars > capacity / 2;
      if (tooLong || tooSlow || pause || sentence || clause) flush();
    }
    group.push(word);
  }
  flush();
  // each cue stays at least `minDuration`, as far as the next cue allows, and never overlaps the next
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const next = cues[i + 1];
    if (!cue) continue;
    const wanted = Math.max(cue.end, cue.start + options.minDuration);
    const limit = next ? next.start - options.gapBetween : Infinity;
    cue.end = Math.max(cue.start + 0.1, Math.min(wanted, limit));
  }
  return cues;
}

/** The cue showing at `sec`, searched from `from` (the index of the last answer) for a forward scan. */
export function cueIndexAt(cues: readonly Cue[], sec: number, from = 0): number {
  for (let i = Math.max(0, from); i < cues.length; i++) {
    const cue = cues[i];
    if (!cue) break;
    if (sec < cue.start) return -1;
    if (sec < cue.end) return i;
  }
  return -1;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** `HH:MM:SS,mmm` for SubRip, `HH:MM:SS.mmm` for WebVTT. */
export function formatTimestamp(sec: number, separator: ',' | '.'): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${separator}${pad(ms % 1000, 3)}`;
}

export function toSrt(cues: readonly Cue[]): string {
  return cues
    .map(
      (cue, i) =>
        `${i + 1}\n${formatTimestamp(cue.start, ',')} --> ${formatTimestamp(cue.end, ',')}\n${cue.lines.join('\n')}\n`,
    )
    .join('\n');
}

export function toVtt(cues: readonly Cue[]): string {
  const body = cues
    .map(
      (cue) =>
        `${formatTimestamp(cue.start, '.')} --> ${formatTimestamp(cue.end, '.')}\n${cue.lines.join('\n')}\n`,
    )
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

/**
 * A plain transcript: one paragraph per stretch of speech, a new one after a silence of `paragraphGap`
 * seconds, each headed with the minute and second it starts at.
 */
export function toTranscript(words: readonly TranscriptWord[], paragraphGap = 2): string {
  const paragraphs: { start: number; words: string[] }[] = [];
  let prevEnd = -Infinity;
  for (const w of words) {
    const text = w.text.trim();
    if (!text) continue;
    const last = paragraphs[paragraphs.length - 1];
    if (!last || w.start - prevEnd >= paragraphGap) paragraphs.push({ start: w.start, words: [text] });
    else last.words.push(text);
    prevEnd = w.end;
  }
  return paragraphs
    .map((p) => {
      const total = Math.floor(p.start);
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      const stamp = h > 0 ? `${h}:${pad(m, 2)}:${pad(s, 2)}` : `${m}:${pad(s, 2)}`;
      return `[${stamp}] ${p.words.join(' ')}`;
    })
    .join('\n\n');
}
