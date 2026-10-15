/** The ordered list of phrases with the silence placed between them; shared by preview and export. */
import { type ClipVideo } from './clip-video.js';
import { type SpeakerVerdict } from './identity.js';

export interface Segment {
  id: string;
  /** Zero-based slide index the phrase was spoken on. */
  slide: number;
  sampleRate: number;
  pcm: Int16Array;
  /** Continues the previous phrase without a gap (the slide changed mid-sentence). */
  joined: boolean;
  prevId: string | null;
  createdAt: number;
  /** The camera's picture of the speaker while this was said; missing when the camera was off. */
  video?: ClipVideo | null;
  /** Whose voice it is, once the lip and voice checks have judged the phrase (see `identity.ts`). */
  speaker?: SpeakerVerdict;
}

export interface TimelineItem {
  seg: Segment;
  /** Silence inserted before this phrase, in seconds. */
  gap: number;
  joined: boolean;
  /** Start of the gap, start and end of the phrase, all in seconds from the beginning. */
  from: number;
  start: number;
  end: number;
  dur: number;
  fadeIn: boolean;
  fadeOut: boolean;
}

export interface Timeline {
  items: TimelineItem[];
  total: number;
}

export interface TimelineSettings {
  gapMs: number;
  slideGapMs: number;
}

export type PhraseOrder = 'recorded' | 'slide';

export function segmentDuration(seg: Segment): number {
  return seg.pcm.length / seg.sampleRate;
}

export function totalDuration(segments: readonly Segment[]): number {
  return segments.reduce((sum, s) => sum + segmentDuration(s), 0);
}

export function buildTimeline(
  segments: readonly Segment[],
  order: PhraseOrder,
  settings: TimelineSettings,
): Timeline {
  const indexed = segments.map((s, i) => ({ s, i }));
  if (order === 'slide') indexed.sort((a, b) => a.s.slide - b.s.slide || a.i - b.i);
  const items: TimelineItem[] = [];
  let t = 0;
  let prev: Segment | null = null;
  for (const { s: seg } of indexed) {
    let gap = 0;
    let joined = false;
    if (prev) {
      if (seg.joined && seg.prevId === prev.id) {
        joined = true;
      } else {
        gap = settings.gapMs / 1000;
        if (seg.slide !== prev.slide) gap += settings.slideGapMs / 1000;
      }
    }
    const dur = segmentDuration(seg);
    items.push({
      seg,
      gap,
      joined,
      from: t,
      start: t + gap,
      end: t + gap + dur,
      dur,
      fadeIn: !joined,
      fadeOut: true,
    });
    t += gap + dur;
    prev = seg;
  }
  items.forEach((it, k) => {
    const next = items[k + 1];
    it.fadeOut = !next?.joined;
  });
  return { items, total: t };
}

/** Seconds recorded per slide index (for the film strip badges). */
export function durationPerSlide(segments: readonly Segment[], slideCount: number): number[] {
  const per = new Array<number>(slideCount).fill(0);
  for (const s of segments) if (s.slide < slideCount) per[s.slide] = (per[s.slide] ?? 0) + segmentDuration(s);
  return per;
}
