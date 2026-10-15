/**
 * The verdict on a phrase: was it the speaker, or another voice?
 *
 * Two checks say what they saw and heard, and the verdict is read off the pair:
 *
 * - **The lip check** (`lips.ts`): the camera's view of the speaker's mouth during the phrase.
 *   Moving lips with a voice means the speaker was talking. Still lips with a voice means someone
 *   else was. No face in view, or no camera, and the lips say nothing.
 * - **The voice check** (`speaker.ts`): how close the phrase's voice is to the enrolled profile. Over
 *   the top bar it is the speaker's own voice, under the bottom bar it is another, and between the
 *   two it is in doubt. Without a profile the voice says nothing.
 *
 * When the two agree, that is the verdict. When one is silent, the other decides, a voice in doubt
 * by itself staying in doubt. When they disagree (a voice unlike the profile with the lips moving,
 * or the profile's voice over still lips) neither is trusted alone and the phrase is marked as in
 * doubt, with both reasons, so the speaker can listen and decide. With nothing to go on there is no
 * verdict at all.
 */
import { lipOpinion, type LipActivity, type LipOpinion } from './lips.js';
import { voiceOpinion, type VoiceOpinion } from './speaker.js';

export type Verdict = 'you' | 'other' | 'unsure';

/** What is stored on a phrase once it has been judged. */
export interface SpeakerVerdict {
  verdict: Verdict;
  /** The cosine against the profile, or null without a profile or enough speech. */
  similarity: number | null;
  /** What the camera said, or null without a camera. */
  lips: LipOpinion | null;
  /** Why, one short sentence per check, for the tooltip. */
  reasons: string[];
}

/** What the checks had to say about one phrase. */
export interface Evidence {
  /** The cosine between the phrase and the profile; null without a profile or with too little speech. */
  similarity: number | null;
  /** What the camera saw over the phrase; null while the camera is off. */
  lips: LipActivity | null;
}

const VERDICTS: Record<VoiceOpinion | 'none', Record<LipOpinion | 'none', Verdict | null>> = {
  you: { moving: 'you', still: 'unsure', unseen: 'you', none: 'you' },
  other: { moving: 'unsure', still: 'other', unseen: 'other', none: 'other' },
  unsure: { moving: 'you', still: 'other', unseen: 'unsure', none: 'unsure' },
  none: { moving: 'you', still: 'other', unseen: null, none: null },
};

function percent(similarity: number): string {
  return `${Math.round(Math.max(0, Math.min(1, similarity)) * 100)}% match`;
}

function voiceReason(similarity: number | null, opinion: VoiceOpinion | 'none'): string {
  if (similarity === null) return 'No voice profile to compare with';
  switch (opinion) {
    case 'you':
      return `Voice like yours (${percent(similarity)})`;
    case 'other':
      return `Voice unlike yours (${percent(similarity)})`;
    case 'unsure':
      return `Voice in between (${percent(similarity)})`;
    case 'none':
      return 'No voice profile to compare with';
  }
}

function lipReason(opinion: LipOpinion | 'none'): string {
  switch (opinion) {
    case 'moving':
      return 'Your lips were moving';
    case 'still':
      return 'Your lips were still';
    case 'unseen':
      return 'No face in view';
    case 'none':
      return 'Camera off';
  }
}

/** The verdict for a phrase, or null when neither check had anything to go on. */
export function judgeSpeaker(evidence: Evidence): SpeakerVerdict | null {
  const voice: VoiceOpinion | 'none' =
    evidence.similarity === null ? 'none' : voiceOpinion(evidence.similarity);
  const lips: LipOpinion | 'none' = evidence.lips === null ? 'none' : lipOpinion(evidence.lips);
  const verdict = VERDICTS[voice][lips];
  if (verdict === null) return null;
  return {
    verdict,
    similarity: evidence.similarity,
    lips: lips === 'none' ? null : lips,
    reasons: [voiceReason(evidence.similarity, voice), lipReason(lips)],
  };
}

/** What a verdict is called in the timeline. */
export function verdictLabel(verdict: Verdict): string {
  switch (verdict) {
    case 'you':
      return 'Your voice';
    case 'other':
      return 'Another voice';
    case 'unsure':
      return 'Not sure whose voice';
  }
}
