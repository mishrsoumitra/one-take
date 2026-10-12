import { describe, expect, it } from 'vitest';

import { Recorder, type CaptureMode, type Phrase, type PhraseReview } from '../src/core/recorder.js';
import { LIVE_HOLD_MS, type VadSettings } from '../src/core/vad.js';

import { levelReview } from './review.js';

const settings: VadSettings = {
  threshold: -45,
  hangoverMs: 700,
  prerollMs: 200,
  tailMs: 150,
  minSpeechMs: 200,
};
const BLOCK = 480; // 10 ms at 48 kHz
/** Quiet long enough to end a live phrase: the hold plus a little. */
const HOLD = LIVE_HOLD_MS + 100;

function loud(): Float32Array {
  const b = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) b[i] = 0.3 * Math.sin(i / 3);
  return b;
}
function quiet(): Float32Array {
  const b = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) b[i] = 0.0005 * Math.sin(i / 7);
  return b;
}

function harness(mode: CaptureMode, slide = 0, review: PhraseReview | null = levelReview(settings, 10)) {
  const phrases: (Phrase & { id: string })[] = [];
  const speaking: boolean[] = [];
  let n = 0;
  const rec = new Recorder(
    10,
    settings,
    { mode, slide, review: review ?? undefined },
    {
      onPhrase: (p) => {
        const id = `p${++n}`;
        phrases.push({ ...p, id });
        return id;
      },
      onSpeakingChange: (on) => speaking.push(on),
    },
  );
  const feed = (block: () => Float32Array, ms: number) => {
    for (let i = 0; i < ms / 10; i++) rec.process(block());
  };
  return { rec, phrases, speaking, feed };
}

describe('Recorder in auto mode', () => {
  it('turns speech into phrases without any key', async () => {
    const h = harness('auto');
    expect(h.rec.gateOpen).toBe(true);
    h.feed(quiet, 500);
    h.feed(loud, 800);
    h.feed(quiet, HOLD);
    await h.rec.settled();
    expect(h.phrases).toHaveLength(1);
    expect(h.phrases[0]?.slide).toBe(0);
    expect(h.phrases[0]?.joined).toBe(false);
    // 800 ms of speech, up to 200 ms (+3 blocks) of pre-roll and the 150 ms tail; none of the hold
    expect(h.phrases[0]?.blocks.length).toBeGreaterThanOrEqual(80 + 15);
    expect(h.phrases[0]?.blocks.length).toBeLessThanOrEqual(80 + 23 + 15);
    expect(h.speaking).toEqual([true, false]);
  });

  it('ignores the talk key', () => {
    const h = harness('auto');
    expect(h.rec.hold(true)).toBe(false);
    expect(h.rec.held).toBe(false);
    expect(h.rec.gateOpen).toBe(true);
  });

  it('keeps nothing from a muted stretch, not even as pre-roll', async () => {
    const h = harness('auto');
    h.rec.setMuted(true);
    h.feed(loud, 2000);
    expect(h.rec.speaking).toBe(false);
    h.rec.setMuted(false);
    h.feed(loud, 500);
    h.rec.end();
    await h.rec.settled();
    expect(h.phrases).toHaveLength(1);
    // 500 ms of speech, no pre-roll from the muted part
    expect(h.phrases[0]?.blocks).toHaveLength(50);
  });
});

describe('the second listen on finished phrases', () => {
  it('cuts a pause longer than the hangover that the live detector held through', async () => {
    const h = harness('auto');
    h.feed(loud, 500);
    h.feed(quiet, 1500); // longer than the hangover, shorter than the hold: one live phrase
    expect(h.rec.speaking).toBe(true);
    h.feed(loud, 500);
    h.feed(quiet, HOLD);
    await h.rec.settled();
    expect(h.phrases).toHaveLength(2);
    expect(h.phrases.every((p) => !p.joined)).toBe(true);
    // the first piece ends with the tail, the second begins with the pre-roll
    expect(h.phrases[0]?.blocks.length).toBeLessThanOrEqual(23 + 50 + 15);
    expect(h.phrases[1]?.blocks.length).toBeLessThanOrEqual(20 + 50 + 15);
    expect(h.phrases[1]?.blocks.length).toBeGreaterThanOrEqual(50 + 15);
  });

  it('keeps a pause shorter than the hangover inside the phrase', async () => {
    const h = harness('auto');
    h.feed(loud, 500);
    h.feed(quiet, 400);
    h.feed(loud, 500);
    h.feed(quiet, HOLD);
    await h.rec.settled();
    expect(h.phrases).toHaveLength(1);
    expect(h.phrases[0]?.blocks.length).toBeGreaterThanOrEqual(50 + 40 + 50 + 15);
  });

  it('drops a phrase it finds no voice in', async () => {
    const h = harness('auto', 0, () => Promise.resolve({ keep: [], startCut: true, endCut: true }));
    h.feed(loud, 1000);
    h.feed(quiet, HOLD);
    await h.rec.settled();
    expect(h.phrases).toHaveLength(0);
    expect(h.speaking).toEqual([true, false]);
  });

  it('stores phrases in the order they were spoken, however long each review takes', async () => {
    const delays = [30, 0, 10];
    let k = 0;
    const review: PhraseReview = (blocks) =>
      new Promise((resolve) =>
        setTimeout(
          () => resolve({ keep: [{ from: 0, to: blocks.length }], startCut: false, endCut: false }),
          delays[k++ % delays.length],
        ),
      );
    const h = harness('auto', 0, review);
    for (let i = 0; i < 3; i++) {
      h.feed(loud, 300 + i * 100);
      h.feed(quiet, HOLD);
    }
    expect(h.rec.pending).toBe(3);
    await h.rec.settled();
    expect(h.rec.pending).toBe(0);
    expect(h.phrases.map((p) => p.blocks.length)).toEqual(
      h.phrases
        .map((p) => p.blocks.length)
        .slice()
        .sort((a, b) => a - b),
    );
    expect(h.phrases).toHaveLength(3);
  });

  it('keeps the phrase as heard when the review fails', async () => {
    const h = harness('auto', 0, () => Promise.reject(new Error('no')));
    h.feed(loud, 500);
    h.feed(quiet, HOLD);
    await h.rec.settled();
    expect(h.phrases).toHaveLength(1);
    expect(h.phrases[0]?.blocks.length).toBeGreaterThanOrEqual(50 + 15);
  });

  it('discard drops the phrase being spoken, or else the newest one still being reviewed', async () => {
    const releases: (() => void)[] = [];
    const review: PhraseReview = (blocks) =>
      new Promise((resolve) => {
        releases.push(() =>
          resolve({ keep: [{ from: 0, to: blocks.length }], startCut: false, endCut: false }),
        );
      });
    const h = harness('auto', 0, review);
    h.feed(loud, 500);
    expect(h.rec.discard()).toBe(true); // the phrase being spoken
    expect(h.rec.speaking).toBe(false);
    h.feed(quiet, 300);
    h.feed(loud, 500);
    h.feed(quiet, HOLD); // finished: its review begins (and sticks)
    await new Promise((r) => setTimeout(r, 0));
    expect(releases).toHaveLength(1);
    h.feed(loud, 600);
    h.feed(quiet, HOLD); // finished: waits behind the first
    expect(h.rec.pending).toBe(2);
    expect(h.rec.discard()).toBe(true); // the newest one waiting
    expect(h.rec.discard()).toBe(true); // then the one whose review is under way
    expect(h.rec.discard()).toBe(false); // nothing left to drop
    releases[0]!();
    await h.rec.settled();
    expect(h.phrases).toHaveLength(0);
    expect(h.rec.pending).toBe(0);
    // and a phrase finished after that is stored as usual
    h.feed(loud, 500);
    h.feed(quiet, HOLD);
    await new Promise((r) => setTimeout(r, 0));
    releases[1]!();
    await h.rec.settled();
    expect(h.phrases).toHaveLength(1);
  });

  it('stores phrases as they are without a review', () => {
    const h = harness('auto', 0, null);
    h.feed(loud, 500);
    h.feed(quiet, HOLD);
    expect(h.phrases).toHaveLength(1); // synchronously
    expect(h.rec.pending).toBe(0);
  });
});

describe('Recorder in press-to-speak mode', () => {
  it('hears nothing while the key is up', () => {
    const h = harness('hold');
    expect(h.rec.gateOpen).toBe(false);
    h.feed(loud, 3000);
    expect(h.rec.speaking).toBe(false);
    expect(h.phrases).toHaveLength(0);
    expect(h.speaking).toHaveLength(0);
  });

  it('records exactly what was held: no audio from before the press', async () => {
    const h = harness('hold');
    h.feed(loud, 1000); // talking to someone in the room
    expect(h.rec.hold(true)).toBe(true);
    expect(h.rec.held).toBe(true);
    expect(h.rec.gateOpen).toBe(true);
    h.feed(loud, 500);
    expect(h.rec.hold(false)).toBe(true);
    expect(h.rec.speaking).toBe(false);
    await h.rec.settled();
    expect(h.phrases).toHaveLength(1);
    expect(h.phrases[0]?.blocks).toHaveLength(50);
  });

  it('trims the dead air at both ends of a press', async () => {
    const h = harness('hold');
    h.rec.hold(true);
    h.feed(quiet, 600); // reaction time before speaking
    h.feed(loud, 500);
    h.feed(quiet, 400); // reaction time before letting go (shorter than the hangover)
    h.rec.hold(false);
    await h.rec.settled();
    expect(h.phrases).toHaveLength(1);
    const blocks = h.phrases[0]?.blocks.length ?? 0;
    // up to 200 ms (+3 blocks) of pre-roll, the 500 ms, and a 150 ms tail
    expect(blocks).toBeGreaterThanOrEqual(50 + 15);
    expect(blocks).toBeLessThanOrEqual(23 + 50 + 15);
  });

  it('still cuts a long pause inside one press', async () => {
    const h = harness('hold');
    h.rec.hold(true);
    h.feed(loud, 500);
    h.feed(quiet, 1500);
    h.feed(loud, 500);
    h.rec.hold(false);
    await h.rec.settled();
    expect(h.phrases).toHaveLength(2);
    expect(h.phrases.every((p) => !p.joined)).toBe(true);
  });

  it('drops a press that only caught the key click', async () => {
    const h = harness('hold');
    h.rec.hold(true);
    h.feed(loud, 50);
    h.feed(quiet, 300);
    h.rec.hold(false);
    await h.rec.settled();
    expect(h.phrases).toHaveLength(0);
  });

  it('treats repeated downs and ups as one', async () => {
    const h = harness('hold');
    expect(h.rec.hold(true)).toBe(true);
    expect(h.rec.hold(true)).toBe(false);
    h.feed(loud, 400);
    expect(h.rec.hold(false)).toBe(true);
    expect(h.rec.hold(false)).toBe(false);
    await h.rec.settled();
    expect(h.phrases).toHaveLength(1);
  });

  it('splits a phrase on a slide change and joins the continuation', async () => {
    const h = harness('hold', 3);
    h.rec.hold(true);
    h.feed(loud, 600);
    h.rec.setSlide(4);
    h.feed(loud, 400);
    h.rec.hold(false);
    await h.rec.settled();
    expect(h.phrases).toHaveLength(2);
    expect(h.phrases[0]).toMatchObject({ slide: 3, joined: false, prevId: null });
    expect(h.phrases[1]).toMatchObject({ slide: 4, joined: true, prevId: 'p1' });
    expect(h.rec.slide).toBe(4);
  });

  it('chains the parts of a sentence that crosses several slides', async () => {
    const h = harness('hold', 0);
    h.rec.hold(true);
    h.feed(loud, 600);
    h.rec.setSlide(1);
    h.feed(loud, 600);
    h.rec.setSlide(2);
    h.feed(loud, 600);
    h.rec.hold(false);
    await h.rec.settled();
    expect(h.phrases.map((p) => [p.slide, p.joined, p.prevId])).toEqual([
      [0, false, null],
      [1, true, 'p1'],
      [2, true, 'p2'],
    ]);
  });

  it('does not join a continuation when the second listen cut the seam', async () => {
    // the part before the slide change ends in silence the live detector held through
    const h = harness('hold', 0);
    h.rec.hold(true);
    h.feed(loud, 600);
    h.feed(quiet, 1000); // not enough for the live detector to let go, more than the hangover
    h.rec.setSlide(1); // the speaker has been quiet longer than the tail: the phrase ends here
    h.feed(loud, 600);
    h.rec.hold(false);
    await h.rec.settled();
    expect(h.phrases).toHaveLength(2);
    expect(h.phrases[1]?.joined).toBe(false);
    expect(h.phrases[1]?.prevId).toBeNull();
    // the cut goes the other way too: a continuation that starts with a long silence is not joined
    const g = harness('hold', 0);
    g.rec.hold(true);
    g.feed(loud, 600);
    g.feed(quiet, 100);
    g.rec.setSlide(1); // within the tail, so this is a split
    g.feed(quiet, 1200); // a pause the second listen cuts, right at the seam
    g.feed(loud, 600);
    g.rec.hold(false);
    await g.rec.settled();
    expect(g.phrases).toHaveLength(2);
    expect(g.phrases[0]?.slide).toBe(0);
    expect(g.phrases[1]?.slide).toBe(1);
    expect(g.phrases[1]?.joined).toBe(false);
  });

  it('does not join a continuation to a part the second listen dropped', async () => {
    let calls = 0;
    const review: PhraseReview = (blocks) => {
      calls++;
      return Promise.resolve(
        calls === 1
          ? { keep: [], startCut: true, endCut: true }
          : { keep: [{ from: 0, to: blocks.length }], startCut: false, endCut: false },
      );
    };
    const h = harness('hold', 0, review);
    h.rec.hold(true);
    h.feed(loud, 600);
    h.rec.setSlide(1);
    h.feed(loud, 600);
    h.rec.hold(false);
    await h.rec.settled();
    expect(h.phrases).toHaveLength(1);
    expect(h.phrases[0]).toMatchObject({ slide: 1, joined: false, prevId: null });
  });

  it('does not leave a silent stub when the slide changes right at the end of a sentence', async () => {
    const h = harness('hold');
    h.rec.hold(true);
    h.feed(loud, 600);
    h.feed(quiet, 100); // within the tail: the detector is still "speaking"
    h.rec.setSlide(1);
    h.feed(quiet, 1000);
    h.rec.hold(false);
    await h.rec.settled();
    expect(h.phrases).toHaveLength(1);
    expect(h.phrases[0]?.slide).toBe(0);
  });

  it('ends the phrase when the mode changes and lets go of the key', async () => {
    const h = harness('hold');
    h.rec.hold(true);
    h.feed(loud, 500);
    h.rec.setMode('auto');
    await h.rec.settled();
    expect(h.phrases).toHaveLength(1);
    expect(h.rec.held).toBe(false);
    expect(h.rec.mode).toBe('auto');
    expect(h.rec.gateOpen).toBe(true);
    h.feed(loud, 500);
    h.rec.setMode('hold');
    await h.rec.settled();
    expect(h.phrases).toHaveLength(2);
    expect(h.rec.gateOpen).toBe(false);
  });

  it('is paused by preview and export even while held', async () => {
    const h = harness('hold');
    h.rec.hold(true);
    h.feed(loud, 400);
    h.rec.setPaused(true);
    await h.rec.settled();
    expect(h.phrases).toHaveLength(1);
    h.feed(loud, 1000);
    expect(h.rec.speaking).toBe(false);
    h.rec.setPaused(false);
    expect(h.rec.gateOpen).toBe(true); // the key is still down
    h.feed(loud, 400);
    h.rec.hold(false);
    await h.rec.settled();
    expect(h.phrases).toHaveLength(2);
  });

  it('discards the phrase being spoken', async () => {
    const h = harness('hold');
    h.rec.hold(true);
    h.feed(loud, 500);
    expect(h.rec.discard()).toBe(true);
    expect(h.rec.speaking).toBe(false);
    h.rec.hold(false);
    await h.rec.settled();
    expect(h.phrases).toHaveLength(0);
    expect(h.speaking).toEqual([true, false]);
  });
});
