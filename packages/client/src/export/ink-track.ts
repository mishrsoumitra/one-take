/**
 * The pen's drawings over the slides as the video is rendered: which strokes are on screen at each
 * moment of the timeline (see `core/ink.ts` for the board and the clips).
 *
 * During a voice clip the board stands still: the strokes drawn by earlier clips on its slide. During
 * a drawing clip the strokes appear point by point. The track hands back a serial number that changes
 * exactly when the picture does, so a renderer redraws a frame only when a point has been added or
 * the clip has changed, and the gap before a clip shows the board as the clip will find it.
 */
import { boardBefore, inkAt, pointsShown, type InkStroke } from '../core/ink.js';
import { type Timeline } from '../core/timeline.js';

export interface InkPicture {
  strokes: readonly InkStroke[];
  /** Bumped every time the strokes on screen change. */
  serial: number;
}

export class InkTrack {
  private itemIndex = -1;
  private board: InkStroke[] = [];
  private key = '';
  private serial = 0;
  private last: InkPicture | null = null;

  constructor(private readonly timeline: Timeline) {}

  /** Whether any clip of the timeline draws or wipes anything. */
  static hasInk(timeline: Timeline): boolean {
    return timeline.items.some((it) => it.seg.ink && (it.seg.ink.strokes.length > 0 || it.seg.ink.wipe));
  }

  /** The strokes on screen at `sec` of the timeline while item `index` plays; null when the slide is bare. */
  at(index: number, sec: number): InkPicture | null {
    const it = this.timeline.items[index];
    if (!it) return null;
    if (index !== this.itemIndex) {
      this.itemIndex = index;
      this.board = boardBefore(
        this.timeline.items.map((x) => x.seg),
        index,
        it.seg.slide,
      );
    }
    const ink = it.seg.ink;
    const intoMs = (sec - it.start) * 1000;
    let strokes: readonly InkStroke[];
    let key: string;
    if (!ink || intoMs < 0) {
      // a voice clip, or the pause before a drawing: the board as it stands
      strokes = this.board;
      key = `${index}`;
    } else {
      const shown = pointsShown(ink, intoMs);
      key = `${index}:${shown}`;
      if (key === this.key && this.last) return this.last;
      strokes = inkAt(this.board, ink, intoMs);
    }
    if (key !== this.key) {
      this.key = key;
      this.serial++;
      this.last = strokes.length > 0 ? { strokes, serial: this.serial } : null;
    }
    return this.last;
  }
}
