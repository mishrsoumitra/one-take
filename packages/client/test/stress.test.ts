/**
 * Long-session stress: hours of simulated speaking driven through the recorder, with slide changes in
 * both directions (many of them mid-sentence), switches between auto and press to speak, holds with
 * human reaction times, mutes, preview pauses, coughs and discards.
 *
 * Every 10 ms block carries its position in the session, so each phrase can be checked exactly: the
 * blocks are consecutive, all of them were heard while the gate was open, none is shared with another
 * phrase, and they sit on the slide that was showing. The total recorded is bounded from both sides by
 * the speech that was fed. The timeline built from thousands of phrases is checked for consistency.
 *
 * Blocks are 48 samples (4.8 kHz) so four hours cost a few seconds; the detector only looks at levels.
 */
import { describe, expect, it } from 'vitest';

import { rmsDb } from '../src/core/pcm.js';
import { Recorder, type CaptureMode, type Phrase } from '../src/core/recorder.js';
import { buildTimeline, durationPerSlide, totalDuration, type Segment } from '../src/core/timeline.js';
import { type VadSettings } from '../src/core/vad.js';

const settings: VadSettings = {
  threshold: -45,
  hangoverMs: 700,
  prerollMs: 200,
  tailMs: 150,
  minSpeechMs: 200,
};
const timelineSettings = { gapMs: 150, slideGapMs: 250 };
const BLOCK_MS = 10;
const BLOCK = 48;
/** Blocks the detector may keep in front of a phrase: the pre-roll plus three blocks of slack. */
const PREROLL_BLOCKS = settings.prerollMs / BLOCK_MS + 3;
const TAIL_BLOCKS = settings.tailMs / BLOCK_MS;
const HOUR = 3600_000 / BLOCK_MS;
const MINUTE = 60_000 / BLOCK_MS;

/** mulberry32: a small seeded generator so a failure can be replayed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A block that knows its position in the session. */
type Tagged = Float32Array & { i: number };

function tone(amplitude: number, seed: number): Float32Array {
  const b = new Float32Array(BLOCK);
  for (let k = 0; k < BLOCK; k++) b[k] = amplitude * Math.sin(k / 2.3 + seed) * (1 + 0.2 * Math.sin(k / 7));
  return b;
}
// speech between -29 and -10 dBFS, room noise between -70 and -52 dBFS, a cough at -16 dBFS
const LOUD = [0.04, 0.08, 0.15, 0.25, 0.4].map((a, i) => tone(a, i));
const QUIET = [0.0003, 0.0008, 0.0015, 0.0025].map((a, i) => tone(a, 10 + i));
const COUGH = tone(0.2, 99);
for (const b of LOUD) expect(rmsDb(b)).toBeGreaterThan(-32);
for (const b of QUIET) expect(rmsDb(b)).toBeLessThan(-50);

interface Stored {
  id: string;
  slide: number;
  joined: boolean;
  prevId: string | null;
  first: number;
  last: number;
  blocks: number;
  /** Blocks that were speech (by the session's own account) and where the first one sits. */
  loud: number;
  leadIn: number;
}

/** Feeds a session block by block, remembers the truth about every block and checks each phrase. */
class Session {
  readonly rec: Recorder;
  readonly stored: Stored[] = [];
  readonly problems: string[] = [];
  /** Per block: slide showing, gate open, loud (speech or cough). */
  readonly slideAt: Uint16Array;
  readonly openAt: Uint8Array;
  readonly loudAt: Uint8Array;
  readonly heldAt: Uint8Array;
  t = 0;
  /** Loud blocks fed while the gate was open: they must all end up in phrases. */
  speechOpen = 0;
  /** Quiet blocks inside a phrase (short pauses) fed while the gate was open. */
  shortPauseOpen = 0;
  /** Quiet blocks of any kind fed while the gate was open (the loose upper bound). */
  quietOpen = 0;
  starts = 0;
  ends = 0;
  private n = 0;
  private lastEnd = -1;

  constructor(
    mode: CaptureMode,
    readonly capacity: number,
    readonly slides: number,
    readonly random: () => number,
  ) {
    this.slideAt = new Uint16Array(capacity);
    this.openAt = new Uint8Array(capacity);
    this.loudAt = new Uint8Array(capacity);
    this.heldAt = new Uint8Array(capacity);
    this.rec = new Recorder(
      BLOCK_MS,
      settings,
      { mode, slide: 0 },
      {
        onPhrase: (p) => this.onPhrase(p),
        onSpeakingChange: (on) => {
          if (on) this.starts++;
          else this.ends++;
        },
      },
    );
  }

  get recorded(): number {
    return this.stored.reduce((a, s) => a + s.blocks, 0);
  }

  /** Checks what can be checked the moment a phrase arrives; `verify()` adds what needs its neighbours. */
  private onPhrase(p: Phrase): string {
    const id = `s${++this.n}`;
    const idx = (p.blocks as Tagged[]).map((b) => b.i);
    const first = idx[0] ?? -1;
    const last = idx[idx.length - 1] ?? -1;
    const fail = (why: string) =>
      this.problems.push(`${id} (slide ${p.slide + 1}, ${idx.length} blocks): ${why}`);
    if (idx.length === 0) fail('empty phrase');
    for (let k = 1; k < idx.length; k++) {
      if (idx[k] !== (idx[k - 1] ?? -2) + 1) {
        fail(`blocks not consecutive at ${k}`);
        break;
      }
    }
    if (first <= this.lastEnd) fail(`overlaps the previous phrase (${first} <= ${this.lastEnd})`);
    this.lastEnd = last;
    let loud = 0;
    let firstLoud = -1;
    let lastLoud = -1;
    for (const i of idx) {
      if (!this.openAt[i]) {
        fail(`block ${i} was heard while the gate was closed`);
        break;
      }
      if (this.loudAt[i]) {
        loud++;
        if (firstLoud < 0) firstLoud = i;
        lastLoud = i;
      }
    }
    // the slide: every block from the first loud one on was fed on this slide; the pre-roll before it
    // may straddle a slide change that happened in the 200 ms before speech began
    for (const i of idx) {
      if (i >= firstLoud && this.slideAt[i] !== p.slide) {
        fail(`block ${i} was fed on slide ${(this.slideAt[i] ?? -1) + 1}`);
        break;
      }
    }
    const trailing = lastLoud < 0 ? idx.length : last - lastLoud;
    if (trailing > TAIL_BLOCKS) fail(`${trailing} blocks of trailing quiet`);
    if (!p.joined && p.prevId !== null) fail('prevId set on a phrase that is not joined');
    this.stored.push({
      id,
      slide: p.slide,
      joined: p.joined,
      prevId: p.prevId,
      first,
      last,
      blocks: idx.length,
      loud,
      leadIn: firstLoud < 0 ? idx.length : firstLoud - first,
    });
    return id;
  }

  /**
   * The checks that need a phrase's neighbours. A phrase that opens a sentence may carry at most the
   * pre-roll of quiet; a continuation may start with a breath that the slide change landed in front of
   * (kept because it was shorter than the hangover). A phrase shorter than the minimum is allowed only
   * as the stub before a mid-sentence slide change, that is when the next phrase continues it.
   */
  verify(): string[] {
    const problems = [...this.problems];
    for (const [k, s] of this.stored.entries()) {
      const prev = this.stored[k - 1];
      const next = this.stored[k + 1];
      const fail = (why: string) =>
        problems.push(`${s.id} (slide ${s.slide + 1}, ${s.blocks} blocks): ${why}`);
      if (s.joined) {
        if (s.prevId !== prev?.id) fail('joined but does not continue the previous phrase');
        else if (prev.last + 1 !== s.first) fail(`gap between the split parts (${prev.last} -> ${s.first})`);
        if (s.loud === 0) fail('a silent continuation');
        if (s.leadIn > settings.hangoverMs / BLOCK_MS) fail(`${s.leadIn} blocks of lead-in`);
      } else {
        if (s.leadIn > PREROLL_BLOCKS) fail(`${s.leadIn} blocks of lead-in`);
        const continued = next?.joined === true && next.prevId === s.id;
        if (s.loud * BLOCK_MS < settings.minSpeechMs && !continued)
          fail(`only ${s.loud * BLOCK_MS} ms of speech`);
      }
    }
    return problems;
  }

  private feed(template: Float32Array, loud: boolean, blocks: number, shortPause = false): void {
    for (let k = 0; k < blocks; k++) {
      const i = this.t++;
      if (i >= this.capacity) throw new Error('session longer than planned');
      const open = this.rec.gateOpen;
      this.slideAt[i] = this.rec.slide;
      this.openAt[i] = open ? 1 : 0;
      this.loudAt[i] = loud ? 1 : 0;
      this.heldAt[i] = this.rec.held ? 1 : 0;
      if (open) {
        if (loud) this.speechOpen++;
        else {
          this.quietOpen++;
          if (shortPause) this.shortPauseOpen++;
        }
      }
      const block = template.subarray() as Tagged; // a new view per block, so it can carry its index
      block.i = i;
      this.rec.process(block);
    }
  }

  /**
   * Speech as syllables: 150 ms voiced, a 60 ms dip between them, like the e2e fixture. The dips keep
   * the detector's noise floor where the room is (it falls fast, rises slowly), as real speech does.
   * A burst always ends on a voiced block, so the trailing quiet of a phrase is the tail alone.
   */
  speak(ms: number): void {
    const level = LOUD[Math.floor(this.random() * LOUD.length)] ?? LOUD[0]!;
    const dip = QUIET[QUIET.length - 1]!;
    let left = Math.max(1, Math.round(ms / BLOCK_MS));
    while (left > 0) {
      const voiced = Math.min(left, 15);
      this.feed(level, true, voiced);
      left -= voiced;
      if (left > 6) {
        this.feed(dip, false, 6, true);
        left -= 6;
      } else if (left > 0) {
        this.feed(level, true, left);
        left = 0;
      }
    }
  }

  quiet(ms: number, shortPause = false): void {
    this.feed(
      QUIET[Math.floor(this.random() * QUIET.length)] ?? QUIET[0]!,
      false,
      Math.round(ms / BLOCK_MS),
      shortPause,
    );
  }

  cough(ms: number): void {
    this.feed(COUGH, true, Math.round(ms / BLOCK_MS));
  }

  between(lo: number, hi: number): number {
    return lo + this.random() * (hi - lo);
  }

  /** Mostly forward, sometimes back, now and then a jump. */
  nextSlide(): number {
    const cur = this.rec.slide;
    const r = this.random();
    let next: number;
    if (r < 0.6) next = cur + 1;
    else if (r < 0.85) next = cur - 1;
    else next = Math.floor(this.random() * this.slides);
    if (next < 0) next = 1;
    if (next >= this.slides) next = this.slides - 2;
    return next === cur ? (cur + 1) % this.slides : next;
  }

  /** The phrases as timeline segments: one "sample" per block, so a two-hour session weighs nothing. */
  segments(): Segment[] {
    return this.stored.map((s) => ({
      id: s.id,
      slide: s.slide,
      sampleRate: 1000 / BLOCK_MS,
      pcm: new Int16Array(s.blocks),
      joined: s.joined,
      prevId: s.prevId,
      createdAt: s.first,
    }));
  }
}

/** Checks a timeline built from the session's phrases, in both orders. */
function checkTimeline(session: Session): void {
  const segments = session.segments();
  const total = totalDuration(segments);
  expect(total).toBeCloseTo((session.recorded * BLOCK_MS) / 1000, 6);
  const perSlide = durationPerSlide(segments, session.slides);
  expect(perSlide.reduce((a, b) => a + b, 0)).toBeCloseTo(total, 6);
  expect(perSlide.every((d) => d >= 0 && Number.isFinite(d))).toBe(true);
  for (const order of ['recorded', 'slide'] as const) {
    const started = performance.now();
    const tl = buildTimeline(segments, order, timelineSettings);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(tl.items).toHaveLength(segments.length);
    let t = 0;
    let joined = 0;
    for (const [k, it] of tl.items.entries()) {
      expect(it.from).toBeCloseTo(t, 6);
      expect(it.start).toBeCloseTo(t + it.gap, 6);
      expect(it.end).toBeCloseTo(it.start + it.dur, 6);
      expect(it.dur).toBeGreaterThan(0);
      if (it.joined) {
        joined++;
        expect(it.gap).toBe(0);
        expect(tl.items[k - 1]?.seg.id).toBe(it.seg.prevId);
        expect(tl.items[k - 1]?.fadeOut).toBe(false);
        expect(it.fadeIn).toBe(false);
      } else if (k > 0) {
        const prev = tl.items[k - 1]?.seg;
        const expectedGap =
          timelineSettings.gapMs / 1000 +
          (prev && prev.slide !== it.seg.slide ? timelineSettings.slideGapMs / 1000 : 0);
        expect(it.gap).toBeCloseTo(expectedGap, 6);
      }
      t = it.end;
    }
    expect(tl.total).toBeCloseTo(t, 6);
    expect(Number.isFinite(tl.total)).toBe(true);
    if (order === 'recorded') {
      expect(joined).toBe(session.stored.filter((s) => s.joined).length);
    } else {
      // grouped by slide, every phrase of a slide comes before any phrase of the next slide
      for (let k = 1; k < tl.items.length; k++) {
        expect(tl.items[k]!.seg.slide).toBeGreaterThanOrEqual(tl.items[k - 1]!.seg.slide);
      }
    }
  }
}

/**
 * A lecture as thoughts: a thinking pause, then one to four bursts of speech with short pauses between
 * them. Slide changes land anywhere, including mid-sentence. In press to speak the key goes down a
 * little before the first word and comes up a little after the last; in auto mode the mic just listens.
 * Mutes, preview pauses and coughs happen while nothing is being said, so every block can be accounted for.
 */
function lecture(
  session: Session,
  blocks: number,
  startMode: CaptureMode,
): { thoughts: number; modeSwitches: number; slideChanges: number; midSentence: number } {
  const s = session;
  let mode = startMode;
  let nextSwitch = s.t + s.between(5, 15) * MINUTE;
  const counts = { thoughts: 0, modeSwitches: 0, slideChanges: 0, midSentence: 0 };
  const change = (mid: boolean) => {
    s.rec.setSlide(s.nextSlide());
    counts.slideChanges++;
    if (mid) counts.midSentence++;
  };
  while (s.t < blocks) {
    counts.thoughts++;
    // thinking: long enough that the hangover always ends the phrase before it
    const pause = s.between(1200, 6000);
    const r = s.random();
    if (r < 0.06 && pause > 3200) {
      // a cough in the middle of a long pause, alone; dropped as too short
      s.quiet(pause / 2 - 100);
      s.cough(s.between(40, 150));
      s.quiet(pause / 2 - 100);
    } else if (r < 0.1 && mode === 'auto') {
      // talking to someone in the room with the mic muted
      s.quiet(pause / 2);
      s.rec.setMuted(true);
      s.speak(s.between(1000, 5000));
      s.rec.setMuted(false);
      s.quiet(Math.max(1200, pause / 2));
    } else if (r < 0.13) {
      // a preview (or an export) pauses the mic
      s.quiet(pause / 2);
      s.rec.setPaused(true);
      s.speak(s.between(500, 3000)); // the preview's own sound, or the speaker reacting to it
      s.rec.setPaused(false);
      s.quiet(Math.max(1200, pause / 2));
    } else {
      // some slide changes happen while nothing is said
      if (s.random() < 0.15) {
        s.quiet(pause / 2);
        change(false);
        s.quiet(pause / 2);
      } else {
        s.quiet(pause);
      }
    }
    if (s.t >= nextSwitch && !s.rec.speaking) {
      mode = mode === 'auto' ? 'hold' : 'auto';
      s.rec.setMode(mode);
      counts.modeSwitches++;
      nextSwitch = s.t + s.between(5, 15) * MINUTE;
    }
    // the thought itself
    const bursts = 1 + Math.floor(s.random() * 4);
    const slideMoment = s.random() < 0.3 ? Math.floor(s.random() * bursts) : -1;
    if (mode === 'hold') {
      s.rec.hold(true);
      s.quiet(s.between(50, 500)); // reaction time before the first word
    }
    for (let b = 0; b < bursts; b++) {
      const len = s.between(400, 6000);
      if (slideMoment === b && s.random() < 0.7) {
        // mid-sentence
        const at = s.between(100, len - 100);
        s.speak(at);
        change(true);
        s.speak(len - at);
      } else {
        s.speak(len);
        if (slideMoment === b) change(false);
      }
      if (b < bursts - 1) s.quiet(s.between(100, 500), true); // a breath, kept inside the phrase
    }
    if (mode === 'hold') {
      s.quiet(s.between(50, 900)); // reaction time before letting go
      s.rec.hold(false);
    }
  }
  s.rec.end();
  return counts;
}

describe('a long lecture through the recorder', () => {
  it(
    'four hours, auto and press to speak alternating, with slides going back and forth',
    { timeout: 120_000 },
    () => {
      const capacity = 4 * HOUR + 2 * MINUTE;
      const session = new Session('auto', capacity, 60, rng(20261009));
      const started = performance.now();
      const counts = lecture(session, 4 * HOUR, 'auto');
      const elapsed = performance.now() - started;
      const rec = session.rec;
      const phrases = session.stored.length;
      const recorded = session.recorded;
      console.info(
        `4 h simulated in ${(elapsed / 1000).toFixed(1)} s: ${counts.thoughts} thoughts, ${phrases} phrases, ` +
          `${counts.slideChanges} slide changes (${counts.midSentence} mid-sentence), ${counts.modeSwitches} mode switches; ` +
          `${((recorded * BLOCK_MS) / 60000).toFixed(1)} min recorded from ${((session.speechOpen * BLOCK_MS) / 60000).toFixed(1)} min of speech`,
      );
      expect(session.verify()).toEqual([]);
      expect(counts.modeSwitches).toBeGreaterThanOrEqual(10);
      expect(counts.midSentence).toBeGreaterThan(50);
      expect(phrases).toBeGreaterThan(1000);
      // every loud block heard with the gate open is in a phrase; the overhead is bounded per phrase
      expect(recorded).toBeGreaterThanOrEqual(session.speechOpen);
      expect(recorded).toBeLessThanOrEqual(
        session.speechOpen + session.shortPauseOpen + phrases * (PREROLL_BLOCKS + TAIL_BLOCKS),
      );
      // the pauses were really removed: far less than four hours was kept
      expect(recorded).toBeLessThan(0.8 * 4 * HOUR);
      // the detector is idle and holds nothing but a pre-roll
      expect(rec.speaking).toBe(false);
      expect(rec.held).toBe(false);
      expect(rec.vad.bufferedMs).toBeLessThanOrEqual(settings.prerollMs + 3 * BLOCK_MS);
      expect(session.starts).toBe(session.ends);
      // the stored slides cover the deck, and continuations chain correctly
      const slidesUsed = new Set(session.stored.map((s) => s.slide));
      expect(slidesUsed.size).toBeGreaterThan(20);
      const joined = session.stored.filter((s) => s.joined);
      expect(joined.length).toBeGreaterThan(50);
      for (const [k, s] of session.stored.entries()) {
        if (s.joined) expect(session.stored[k - 1]?.id).toBe(s.prevId);
      }
      checkTimeline(session);
    },
  );

  it('press to speak never records with the key up, however much is said', { timeout: 60_000 }, () => {
    const session = new Session('hold', 70 * MINUTE, 12, rng(7));
    // an hour of talk with the key never touched
    for (let m = 0; m < 60; m++) {
      session.speak(session.between(1000, 20000));
      session.quiet(session.between(200, 3000));
      if (m % 7 === 0) session.rec.setSlide(session.nextSlide());
    }
    expect(session.stored).toHaveLength(0);
    expect(session.starts).toBe(0);
    expect(session.rec.vad.bufferedMs).toBe(0);
    // then one press, and only that press is kept
    session.rec.hold(true);
    session.speak(3000);
    session.rec.hold(false);
    session.speak(5000);
    expect(session.stored).toHaveLength(1);
    expect(session.stored[0]?.blocks).toBe(300);
    expect(session.verify()).toEqual([]);
  });

  it(
    'a twenty-minute sentence held the whole time, split across slides every minute or so',
    { timeout: 60_000 },
    () => {
      const session = new Session('hold', 21 * MINUTE, 30, rng(42));
      session.rec.hold(true);
      let spoken = 0;
      const total = 20 * MINUTE * BLOCK_MS;
      while (spoken < total) {
        const part = Math.min(total - spoken, Math.round(session.between(3000, 9000)) * BLOCK_MS);
        session.speak(part);
        spoken += part;
        if (spoken < total) session.rec.setSlide(session.nextSlide());
      }
      session.rec.hold(false);
      expect(session.verify()).toEqual([]);
      expect(session.recorded).toBe(20 * MINUTE); // every block kept, nothing added
      expect(session.stored.length).toBeGreaterThanOrEqual(14);
      expect(session.stored.slice(1).every((s) => s.joined)).toBe(true);
      expect(session.stored[0]?.joined).toBe(false);
      checkTimeline(session);
      // the whole sentence plays as one piece: no gaps anywhere
      const tl = buildTimeline(session.segments(), 'recorded', timelineSettings);
      expect(tl.items.every((it) => it.gap === 0)).toBe(true);
      expect(tl.total).toBeCloseTo(20 * 60, 6);
    },
  );

  it(
    'survives an hour of chaos: keys, modes, mutes and discards at random moments',
    { timeout: 60_000 },
    () => {
      const session = new Session('auto', 61 * MINUTE, 25, rng(1234));
      const s = session;
      let discards = 0;
      while (s.t < 60 * MINUTE) {
        const r = s.random();
        if (r < 0.3) s.speak(s.between(50, 4000));
        else if (r < 0.55) s.quiet(s.between(50, 3000));
        else if (r < 0.65) s.rec.setSlide(s.nextSlide());
        else if (r < 0.72) s.rec.hold(s.random() < 0.6);
        else if (r < 0.78) s.rec.setMode(s.random() < 0.5 ? 'auto' : 'hold');
        else if (r < 0.84) s.rec.setMuted(s.random() < 0.4);
        else if (r < 0.88) s.rec.setPaused(s.random() < 0.3);
        else if (r < 0.92) s.cough(s.between(20, 200));
        else if (r < 0.95) {
          if (s.rec.speaking) discards++;
          s.rec.discard();
        } else s.speak(s.between(4000, 15000));
      }
      s.rec.setPaused(false);
      s.rec.setMuted(false);
      s.rec.hold(false);
      s.rec.end();
      expect(s.verify()).toEqual([]);
      expect(discards).toBeGreaterThanOrEqual(5);
      expect(s.stored.length).toBeGreaterThan(100);
      expect(s.recorded).toBeLessThanOrEqual(s.speechOpen + s.quietOpen);
      expect(s.rec.speaking).toBe(false);
      expect(s.starts).toBe(s.ends);
      expect(s.rec.vad.bufferedMs).toBeLessThanOrEqual(settings.prerollMs + 3 * BLOCK_MS);
      checkTimeline(session);
    },
  );
});
