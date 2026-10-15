/** The verdict table: every way the lip check and the voice check can combine. */
import { describe, expect, it } from 'vitest';

import { judgeSpeaker, verdictLabel, type Verdict } from '../src/core/identity.js';
import { type LipActivity } from '../src/core/lips.js';

const moving: LipActivity = { frames: 60, faceFrames: 60, swing: 0.2, motion: 0.05 };
const stillLips: LipActivity = { frames: 60, faceFrames: 60, swing: 0.01, motion: 0.004 };
const noFace: LipActivity = { frames: 60, faceFrames: 0, swing: 0, motion: 0 };

const LIPS = { moving, still: stillLips, unseen: noFace, off: null } as const;
const VOICE = { you: 0.8, other: 0.1, unsure: 0.42, none: null } as const;

describe('judgeSpeaker', () => {
  const table: [keyof typeof VOICE, keyof typeof LIPS, Verdict | null][] = [
    ['you', 'moving', 'you'],
    ['you', 'still', 'unsure'],
    ['you', 'unseen', 'you'],
    ['you', 'off', 'you'],
    ['other', 'moving', 'unsure'],
    ['other', 'still', 'other'],
    ['other', 'unseen', 'other'],
    ['other', 'off', 'other'],
    ['unsure', 'moving', 'you'],
    ['unsure', 'still', 'other'],
    ['unsure', 'unseen', 'unsure'],
    ['unsure', 'off', 'unsure'],
    ['none', 'moving', 'you'],
    ['none', 'still', 'other'],
    ['none', 'unseen', null],
    ['none', 'off', null],
  ];
  for (const [voice, lips, expected] of table) {
    it(`voice ${voice} + lips ${lips} → ${expected ?? 'no verdict'}`, () => {
      const verdict = judgeSpeaker({ similarity: VOICE[voice], lips: LIPS[lips] });
      expect(verdict?.verdict ?? null).toBe(expected);
    });
  }

  it('explains itself with one reason per check', () => {
    const v = judgeSpeaker({ similarity: 0.12, lips: stillLips });
    expect(v?.reasons).toEqual(['Voice unlike yours (12% match)', 'Your lips were still']);
    expect(v?.similarity).toBe(0.12);
    expect(v?.lips).toBe('still');
    expect(judgeSpeaker({ similarity: 0.8, lips: null })?.reasons).toEqual([
      'Voice like yours (80% match)',
      'Camera off',
    ]);
    expect(judgeSpeaker({ similarity: null, lips: moving })?.reasons).toEqual([
      'No voice profile to compare with',
      'Your lips were moving',
    ]);
    expect(judgeSpeaker({ similarity: 0.42, lips: noFace })?.reasons).toEqual([
      'Voice in between (42% match)',
      'No face in view',
    ]);
  });

  it('names the verdicts', () => {
    expect(verdictLabel('you')).toBe('Your voice');
    expect(verdictLabel('other')).toBe('Another voice');
    expect(verdictLabel('unsure')).toBe('Not sure whose voice');
  });
});
