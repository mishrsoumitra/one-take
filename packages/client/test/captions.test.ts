import { describe, expect, it } from 'vitest';

import {
  buildCues,
  cueIndexAt,
  DEFAULT_CUES,
  formatTimestamp,
  toSrt,
  toTranscript,
  toVtt,
  wrapLines,
  type TranscriptWord,
} from '../src/core/captions.js';

/** Words spoken one after another at `wps` words a second from `start`. */
function speak(text: string, start = 0, wps = 3): TranscriptWord[] {
  return text.split(' ').map((w, i) => ({ text: w, start: start + i / wps, end: start + (i + 0.8) / wps }));
}

describe('wrapLines', () => {
  it('breaks at spaces and balances two lines', () => {
    expect(wrapLines(['a', 'b'], 42, 2)).toEqual(['a b']);
    const words = 'the quick brown fox jumps over the lazy dog near the river bank'.split(' ');
    const lines = wrapLines(words, 42, 2);
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(42);
    expect(Math.abs((lines[0]?.length ?? 0) - (lines[1]?.length ?? 0))).toBeLessThan(12);
  });

  it('never splits a word, even one longer than a line', () => {
    expect(wrapLines(['supercalifragilisticexpialidocious', 'x'], 10, 2)).toEqual([
      'supercalifragilisticexpialidocious',
      'x',
    ]);
  });
});

describe('buildCues', () => {
  it('starts a new cue at a sentence end, a long pause or when the lines are full', () => {
    const words = [
      ...speak('The sky is blue.'),
      ...speak('Because the air scatters blue light more than red light does', 2),
      ...speak('and sunsets are red', 12),
    ];
    const cues = buildCues(words);
    expect(cues.length).toBeGreaterThanOrEqual(3);
    expect(cues[0]?.lines).toEqual(['The sky is blue.']);
    expect(cues[1]?.start).toBeCloseTo(2, 5);
    // the pause of several seconds before "and" makes its own cue
    const last = cues[cues.length - 1];
    expect(last?.lines.join(' ')).toBe('and sunsets are red');
    expect(last?.start).toBeCloseTo(12, 5);
    for (const c of cues) {
      expect(c.lines.length).toBeLessThanOrEqual(2);
      for (const l of c.lines) expect(l.length).toBeLessThanOrEqual(DEFAULT_CUES.maxChars);
    }
  });

  it('keeps every cue on for at least a second and never past the next one', () => {
    const words = [...speak('Yes.'), ...speak('No.', 0.5), ...speak('Maybe so.', 8)];
    const cues = buildCues(words);
    expect(cues).toHaveLength(3);
    expect(cues[0]?.end).toBeLessThanOrEqual((cues[1]?.start ?? 0) - DEFAULT_CUES.gapBetween + 1e-9);
    expect((cues[1]?.end ?? 0) - (cues[1]?.start ?? 0)).toBeCloseTo(1, 5);
    expect((cues[2]?.end ?? 0) - (cues[2]?.start ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it('splits a long cue by time', () => {
    const slow = speak('one two three four five six seven eight nine ten', 0, 0.8); // 12.5 s of words
    const cues = buildCues(slow);
    expect(cues.length).toBeGreaterThanOrEqual(2);
    for (const c of cues) expect(c.end - c.start).toBeLessThanOrEqual(DEFAULT_CUES.maxDuration + 1.5);
  });

  it('skips empty words and finds the cue at a time', () => {
    const cues = buildCues([{ text: '  ', start: 0, end: 0.1 }, ...speak('hello there', 1)]);
    expect(cues).toHaveLength(1);
    expect(cueIndexAt(cues, 0.5)).toBe(-1);
    expect(cueIndexAt(cues, 1.2)).toBe(0);
    expect(cueIndexAt(cues, 10)).toBe(-1);
  });
});

describe('writers', () => {
  const cues = buildCues([...speak('Hello there.'), ...speak('General Kenobi.', 3)]);

  it('formats timestamps', () => {
    expect(formatTimestamp(0, ',')).toBe('00:00:00,000');
    expect(formatTimestamp(3661.5, '.')).toBe('01:01:01.500');
  });

  it('writes SubRip', () => {
    const srt = toSrt(cues);
    expect(srt.startsWith('1\n00:00:00,000 --> ')).toBe(true);
    expect(srt).toContain('\n2\n00:00:03,000 --> ');
    expect(srt).toContain('Hello there.\n');
    expect(srt.endsWith('General Kenobi.\n')).toBe(true);
  });

  it('writes WebVTT', () => {
    const vtt = toVtt(cues);
    expect(vtt.startsWith('WEBVTT\n\n00:00:00.000 --> ')).toBe(true);
    expect(vtt).toContain('00:00:03.000 --> ');
    expect(vtt).not.toContain(',');
  });

  it('writes a transcript in paragraphs with a time at the start of each', () => {
    const words = [...speak('Hello there.'), ...speak('General Kenobi.', 65)];
    const txt = toTranscript(words);
    expect(txt).toBe('[0:00] Hello there.\n\n[1:05] General Kenobi.');
    expect(toTranscript(speak('a', 3700))).toBe('[1:01:40] a');
  });
});
