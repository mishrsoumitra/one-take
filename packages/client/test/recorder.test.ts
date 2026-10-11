import { describe, expect, it } from 'vitest';

import { Recorder, type CaptureMode, type Phrase } from '../src/core/recorder.js';
import { type VadSettings } from '../src/core/vad.js';

const settings: VadSettings = {
  threshold: -45,
  hangoverMs: 700,
  prerollMs: 200,
  tailMs: 150,
  minSpeechMs: 200,
};
const BLOCK = 480; // 10 ms at 48 kHz

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

function harness(mode: CaptureMode, slide = 0) {
  const phrases: (Phrase & { id: string })[] = [];
  const speaking: boolean[] = [];
  let n = 0;
  const rec = new Recorder(
    10,
    settings,
    { mode, slide },
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
  it('turns speech into phrases without any key', () => {
    const h = harness('auto');
    expect(h.rec.gateOpen).toBe(true);
    h.feed(quiet, 500);
    h.feed(loud, 800);
    h.feed(quiet, 1000);
    expect(h.phrases).toHaveLength(1);
    expect(h.phrases[0]?.slide).toBe(0);
    expect(h.phrases[0]?.joined).toBe(false);
    expect(h.speaking).toEqual([true, false]);
  });

  it('ignores the talk key', () => {
    const h = harness('auto');
    expect(h.rec.hold(true)).toBe(false);
    expect(h.rec.held).toBe(false);
    expect(h.rec.gateOpen).toBe(true);
  });

  it('keeps nothing from a muted stretch, not even as pre-roll', () => {
    const h = harness('auto');
    h.rec.setMuted(true);
    h.feed(loud, 2000);
    expect(h.rec.speaking).toBe(false);
    h.rec.setMuted(false);
    h.feed(loud, 500);
    h.rec.end();
    expect(h.phrases).toHaveLength(1);
    // 500 ms of speech, no pre-roll from the muted part
    expect(h.phrases[0]?.blocks).toHaveLength(50);
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

  it('records exactly what was held: no audio from before the press', () => {
    const h = harness('hold');
    h.feed(loud, 1000); // talking to someone in the room
    expect(h.rec.hold(true)).toBe(true);
    expect(h.rec.held).toBe(true);
    expect(h.rec.gateOpen).toBe(true);
    h.feed(loud, 500);
    expect(h.rec.hold(false)).toBe(true);
    expect(h.rec.speaking).toBe(false);
    expect(h.phrases).toHaveLength(1);
    expect(h.phrases[0]?.blocks).toHaveLength(50);
  });

  it('trims the dead air at both ends of a press', () => {
    const h = harness('hold');
    h.rec.hold(true);
    h.feed(quiet, 600); // reaction time before speaking
    h.feed(loud, 500);
    h.feed(quiet, 400); // reaction time before letting go (shorter than the hangover)
    h.rec.hold(false);
    expect(h.phrases).toHaveLength(1);
    const blocks = h.phrases[0]?.blocks.length ?? 0;
    // up to 200 ms (+3 blocks) of pre-roll, the 500 ms, and a 150 ms tail
    expect(blocks).toBeGreaterThanOrEqual(50 + 15);
    expect(blocks).toBeLessThanOrEqual(23 + 50 + 15);
  });

  it('still cuts a long pause inside one press', () => {
    const h = harness('hold');
    h.rec.hold(true);
    h.feed(loud, 500);
    h.feed(quiet, 1500);
    h.feed(loud, 500);
    h.rec.hold(false);
    expect(h.phrases).toHaveLength(2);
    expect(h.phrases.every((p) => !p.joined)).toBe(true);
  });

  it('drops a press that only caught the key click', () => {
    const h = harness('hold');
    h.rec.hold(true);
    h.feed(loud, 50);
    h.feed(quiet, 300);
    h.rec.hold(false);
    expect(h.phrases).toHaveLength(0);
  });

  it('treats repeated downs and ups as one', () => {
    const h = harness('hold');
    expect(h.rec.hold(true)).toBe(true);
    expect(h.rec.hold(true)).toBe(false);
    h.feed(loud, 400);
    expect(h.rec.hold(false)).toBe(true);
    expect(h.rec.hold(false)).toBe(false);
    expect(h.phrases).toHaveLength(1);
  });

  it('splits a phrase on a slide change and joins the continuation', () => {
    const h = harness('hold', 3);
    h.rec.hold(true);
    h.feed(loud, 600);
    h.rec.setSlide(4);
    h.feed(loud, 400);
    h.rec.hold(false);
    expect(h.phrases).toHaveLength(2);
    expect(h.phrases[0]).toMatchObject({ slide: 3, joined: false, prevId: null });
    expect(h.phrases[1]).toMatchObject({ slide: 4, joined: true, prevId: 'p1' });
    expect(h.rec.slide).toBe(4);
  });

  it('does not leave a silent stub when the slide changes right at the end of a sentence', () => {
    const h = harness('hold');
    h.rec.hold(true);
    h.feed(loud, 600);
    h.feed(quiet, 100); // within the tail: the detector is still "speaking"
    h.rec.setSlide(1);
    h.feed(quiet, 1000);
    h.rec.hold(false);
    expect(h.phrases).toHaveLength(1);
    expect(h.phrases[0]?.slide).toBe(0);
  });

  it('ends the phrase when the mode changes and lets go of the key', () => {
    const h = harness('hold');
    h.rec.hold(true);
    h.feed(loud, 500);
    h.rec.setMode('auto');
    expect(h.phrases).toHaveLength(1);
    expect(h.rec.held).toBe(false);
    expect(h.rec.mode).toBe('auto');
    expect(h.rec.gateOpen).toBe(true);
    h.feed(loud, 500);
    h.rec.setMode('hold');
    expect(h.phrases).toHaveLength(2);
    expect(h.rec.gateOpen).toBe(false);
  });

  it('is paused by preview and export even while held', () => {
    const h = harness('hold');
    h.rec.hold(true);
    h.feed(loud, 400);
    h.rec.setPaused(true);
    expect(h.phrases).toHaveLength(1);
    h.feed(loud, 1000);
    expect(h.rec.speaking).toBe(false);
    h.rec.setPaused(false);
    expect(h.rec.gateOpen).toBe(true); // the key is still down
    h.feed(loud, 400);
    h.rec.hold(false);
    expect(h.phrases).toHaveLength(2);
  });

  it('discards the phrase being spoken', () => {
    const h = harness('hold');
    h.rec.hold(true);
    h.feed(loud, 500);
    h.rec.discard();
    expect(h.rec.speaking).toBe(false);
    h.rec.hold(false);
    expect(h.phrases).toHaveLength(0);
    expect(h.speaking).toEqual([true, false]);
  });
});
