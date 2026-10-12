/**
 * A second listen for the tests that drive the recorder with synthetic blocks: a block is a voice
 * when its level is over the speech line, and from there on the same rules as the real second
 * listen (the hangover, the pre-roll, the tail, the minimum phrase, the slack at the ends).
 */
import { rmsDb } from '../src/core/pcm.js';
import { type PhraseReview } from '../src/core/recorder.js';
import { cutRanges, speechRanges, type SilenceSettings } from '../src/core/silence.js';

export function levelReview(
  settings: SilenceSettings & { threshold: number },
  blockMs: number,
): PhraseReview {
  const blockSec = blockMs / 1000;
  return (blocks) => {
    const probs = Float32Array.from(blocks, (b) => (rmsDb(b) > settings.threshold ? 1 : 0));
    const total = blocks.length * blockSec;
    const cut = cutRanges(speechRanges(probs, total, settings, blockSec), total);
    const keep = cut.keep.map((r) => ({
      from: Math.round(r.from / blockSec),
      to: Math.round(r.to / blockSec),
    }));
    return Promise.resolve({ keep, startCut: cut.startCut, endCut: cut.endCut });
  };
}
