/**
 * The camera's picture over the slides as the video is rendered: which frame of the speaker goes
 * with each moment of the timeline, and how it is drawn.
 *
 * The overlay follows the phrases. During a phrase whose clip has a picture, the picture plays; in
 * the pause before the next phrase the last frame holds, so the speaker does not blink out between
 * sentences; a phrase recorded with the camera off has no picture, and the overlay goes away for it.
 */
import { type CameraLayout, overlayRect, type Rect } from '../core/overlay.js';
import { type Timeline } from '../core/timeline.js';
import { ClipReader } from '../video/reader.js';

/** The picture to draw right now, and a number that changes whenever it does. */
export interface OverlayPicture {
  frame: VideoFrame;
  /** Width over height of the frame as recorded. */
  aspect: number;
  /** Bumped every time the frame changes, so a renderer knows when the canvas needs a new capture. */
  serial: number;
}

type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Corner radius and border of the picture, as fractions of its width. */
const RADIUS = 0.04;
const BORDER = 0.006;

/** Draws the picture into `box`, with rounded corners and a thin light border. */
export function drawOverlay(g: Canvas2D, frame: CanvasImageSource, box: Rect): void {
  const x = Math.round(box.x);
  const y = Math.round(box.y);
  const w = Math.max(1, Math.round(box.width));
  const h = Math.max(1, Math.round(box.height));
  const r = Math.max(2, Math.round(w * RADIUS));
  const path = () => {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  };
  g.save();
  // a soft shadow lifts the picture off a light slide
  g.shadowColor = 'rgba(0, 0, 0, 0.35)';
  g.shadowBlur = Math.round(w * 0.04);
  g.shadowOffsetY = Math.round(w * 0.01);
  g.fillStyle = '#000';
  path();
  g.fill();
  g.restore();
  g.save();
  path();
  g.clip();
  g.drawImage(frame, x, y, w, h);
  g.restore();
  g.save();
  path();
  g.lineWidth = Math.max(1, Math.round(w * BORDER));
  g.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  g.stroke();
  g.restore();
}

/** The box the picture goes in for a frame of the video whose slide occupies `slideArea`. */
export function overlayBox(layout: CameraLayout, slideArea: Rect, aspect: number): Rect {
  return overlayRect(layout, slideArea, aspect);
}

/** Walks the timeline forward and says which camera frame is on screen at each moment. */
export class OverlayTrack {
  private itemIndex = -1;
  private reader: ClipReader | null = null;
  private aspect = 16 / 9;
  /** The frame held from the previous clip while the next has not started (a clone the track owns). */
  private held: VideoFrame | null = null;
  private last: VideoFrame | null = null;
  private serial = 0;

  constructor(private readonly timeline: Timeline) {}

  /** Whether any clip on the timeline has a picture at all. */
  static hasVideo(timeline: Timeline): boolean {
    return timeline.items.some((it) => it.seg.video && it.seg.video.pieces.length > 0);
  }

  /** The picture at `sec` of the timeline while `itemIndex` plays; calls go forward in time. */
  async pictureAt(itemIndex: number, sec: number): Promise<OverlayPicture | null> {
    if (itemIndex !== this.itemIndex) this.openItem(itemIndex);
    const it = this.timeline.items[itemIndex];
    const reader = this.reader;
    if (!it || !reader) return this.picture(this.held);
    const into = sec - it.start;
    if (into < 0) return this.picture(this.held);
    const frame = await reader.frameAt(into);
    if (frame) {
      if (frame !== this.last) {
        this.last = frame;
        this.serial++;
      }
      return { frame, aspect: this.aspect, serial: this.serial };
    }
    return this.picture(this.held);
  }

  private picture(frame: VideoFrame | null): OverlayPicture | null {
    if (!frame) return null;
    if (frame !== this.last) {
      this.last = frame;
      this.serial++;
    }
    return { frame, aspect: this.aspect, serial: this.serial };
  }

  private openItem(index: number): void {
    const it = this.timeline.items[index];
    // keep the last frame of the clip just finished until the next clip shows its own
    this.held?.close();
    this.held = this.last ? this.last.clone() : null;
    this.reader?.close();
    this.reader = null;
    this.itemIndex = index;
    const video = it?.seg.video;
    if (video && video.pieces.length > 0) {
      this.reader = new ClipReader(video);
      this.aspect = video.width / video.height;
    } else {
      // a clip without a picture: the overlay goes away
      this.held?.close();
      this.held = null;
      this.last = null;
      this.serial++;
    }
  }

  close(): void {
    this.reader?.close();
    this.reader = null;
    this.held?.close();
    this.held = null;
    this.last = null;
  }
}
