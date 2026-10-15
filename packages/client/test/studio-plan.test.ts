import { type StudioInfo } from '@one-take/shared';
import { describe, expect, it } from 'vitest';

import { faceTrack } from '../src/core/faces.js';
import { type Segment } from '../src/core/timeline.js';
import { describeStudio, planStudio, studioEstimate, studioInput, wantsVoice } from '../src/export/studio.js';

const READY: StudioInfo = {
  python: '/x/python',
  device: 'mps',
  models: { denoise: true, separate: true, extract: true },
  speaker: true,
  denoise: true,
  voice: true,
  note: 'ready',
};

function seg(id: string, extra: Partial<Segment> = {}): Segment {
  return {
    id,
    slide: 0,
    sampleRate: 48000,
    pcm: new Int16Array(48000),
    joined: false,
    prevId: null,
    createdAt: 0,
    ...extra,
  };
}

const other = { verdict: 'other' as const, similarity: 0.1, lips: null, reasons: [] };
const you = { verdict: 'you' as const, similarity: 0.9, lips: null, reasons: [] };

describe('planStudio', () => {
  it('cleans every clip without a deep version, keeps the voice of flagged or chosen clips, by faces when it has them', () => {
    const segments = [
      seg('a'),
      seg('b', { deep: new Int16Array(48000) }),
      seg('c', { speaker: other }),
      seg('d', { speaker: { ...other, verdict: 'unsure' }, faces: faceTrack([Uint8Array.from([1])]) }),
      seg('e', { speaker: you, choice: 'voice' }),
      seg('f', { speaker: other, choice: 'cleaned' }),
      seg('g', { speaker: other, voice: new Int16Array(48000) }),
    ];
    const plan = planStudio(segments, {
      settings: { denoise: true, voice: true, findOverlap: false },
      info: READY,
    });
    const byId = Object.fromEntries(plan.clips.map((c) => [c.seg.id, c]));
    expect(byId.a).toMatchObject({ denoise: true, voice: 'off' });
    expect(byId.b).toBeUndefined(); // already cleaned, nothing else wanted
    expect(byId.c).toMatchObject({ denoise: true, voice: 'profile' });
    expect(byId.d).toMatchObject({ denoise: true, voice: 'faces' });
    expect(byId.e).toMatchObject({ denoise: true, voice: 'profile' });
    expect(byId.f).toMatchObject({ denoise: true, voice: 'off' }); // switched to Cleaned on purpose
    expect(byId.g).toMatchObject({ denoise: true, voice: 'off' }); // its voice is already kept
    expect(plan.denoiseSec).toBeCloseTo(6);
    expect(plan.voiceSec).toBeCloseTo(3);
  });

  it('measures the rest for a second voice when asked, skips dropped clips, and does nothing without the studio', () => {
    const segments = [seg('a'), seg('b', { speaker: other })];
    const plan = planStudio(segments, {
      settings: { denoise: false, voice: true, findOverlap: true },
      info: READY,
      dropped: new Set(['b']),
    });
    expect(plan.clips.map((c) => [c.seg.id, c.voice])).toEqual([['a', 'measure']]);
    const off = planStudio(segments, {
      settings: { denoise: true, voice: true, findOverlap: true },
      info: { ...READY, denoise: false, voice: false },
    });
    expect(off.clips).toEqual([]);
    expect(
      planStudio(segments, { settings: { denoise: true, voice: true, findOverlap: false }, info: null })
        .clips,
    ).toEqual([]);
  });

  it('can do the work again', () => {
    const segments = [
      seg('a', { deep: new Int16Array(48000), voice: new Int16Array(48000), speaker: other }),
    ];
    const again = planStudio(segments, {
      settings: { denoise: true, voice: true, findOverlap: false },
      info: READY,
      redo: true,
    });
    expect(again.clips[0]).toMatchObject({ denoise: true, voice: 'profile' });
  });
});

describe('wantsVoice and the input', () => {
  it('wants the voice of a flagged clip unless it was switched away, and of any clip switched to it', () => {
    expect(wantsVoice(seg('a', { speaker: other }))).toBe(true);
    expect(wantsVoice(seg('a', { speaker: other, choice: 'original' }))).toBe(false);
    expect(wantsVoice(seg('a', { speaker: you }))).toBe(false);
    expect(wantsVoice(seg('a', { speaker: you, choice: 'voice' }))).toBe(true);
    expect(wantsVoice(seg('a', { speaker: other }), new Set(['a']))).toBe(false);
  });

  it('sends the microphone as it was, or the live version without one', () => {
    const raw = new Int16Array(48000);
    expect(studioInput(seg('a', { raw }))).toBe(raw);
    const live = seg('a');
    expect(studioInput(live)).toBe(live.pcm);
  });
});

describe('the estimate and the summary', () => {
  it('starts from the device’s speed plus the model load', () => {
    const plan = planStudio([seg('a'), seg('b', { speaker: other })], {
      settings: { denoise: true, voice: true, findOverlap: false },
      info: READY,
    });
    const est = studioEstimate(plan, READY);
    expect(est.denoiseSec).toBe(Math.round(4 + 2 * 0.08));
    expect(est.voiceSec).toBe(Math.round(4 + 1 * 0.35));
    expect(studioEstimate({ clips: [], denoiseSec: 0, voiceSec: 0 }, READY)).toEqual({
      denoiseSec: null,
      voiceSec: null,
    });
  });

  it('says what was done in one line', () => {
    const plan = planStudio([seg('a'), seg('b', { speaker: other })], {
      settings: { denoise: true, voice: true, findOverlap: false },
      info: READY,
    });
    const clip = (id: string, deep: boolean, voice: boolean, method: 'faces' | 'profile' | null) => ({
      id,
      deep,
      voice,
      method,
      similarity: null,
      faceFrames: null,
      overlap: null,
      otherShare: null,
      otherLevelDb: null,
      otherRunSec: null,
      error: null,
    });
    const line = describeStudio(
      {
        job: {
          id: 'j',
          state: 'done',
          createdAt: '',
          updatedAt: '',
          durationSec: 2,
          denoiseSec: 2,
          voiceSec: 1,
          progress: { stage: 'done', clip: null, done: 2, total: 2, fraction: 1, message: 'Done' },
          clips: [clip('a', true, false, null), clip('b', true, true, 'faces')],
          error: null,
        },
        stopped: false,
        failed: [],
      },
      plan,
    );
    expect(line).toBe('Studio: deep clean on 2 phrases, your voice kept in 1 phrase (1 by the camera).');
    expect(describeStudio({ job: null, stopped: false, failed: [] }, plan)).toBeNull();
  });
});
