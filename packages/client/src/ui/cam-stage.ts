/**
 * The camera picture on a stage: a box laid over the slide image exactly where the picture will be
 * in the video, showing the live camera while recording and the recorded picture while playing.
 *
 * The box follows the slide image's rendered rectangle (not the stage, which has black bars) and
 * the same `overlayRect` arithmetic as the export, so what the user sees is what they get. Dragging
 * the box moves the picture anywhere on the slide and snaps it into a corner when it comes close;
 * dragging the handle on its free corner resizes it, within the limits.
 */
import {
  layoutAt,
  overlayRect,
  sizeForWidth,
  snapToCorner,
  type CameraLayout,
  type Rect,
} from '../core/overlay.js';

import { h } from './dom.js';

export interface CamStageDeps {
  /** The stage the slide image sits on; the layer is positioned within it. */
  stage: HTMLElement;
  /** The slide image; the layer follows its rendered box. */
  img: HTMLImageElement;
  layout: () => CameraLayout;
  /** The user moved or resized the picture; `final` once the pointer is up. */
  onLayout: (layout: CameraLayout, final: boolean) => void;
}

type Mode = 'hidden' | 'live' | 'play';

/** A pointer that moved less than this is a click, which does nothing. */
const DRAG_PX = 2;

export class CamStage {
  readonly layer: HTMLElement;
  readonly box: HTMLElement;
  readonly video: HTMLVideoElement;
  readonly canvas: HTMLCanvasElement;
  private readonly handle: HTMLElement;
  private readonly badge: HTMLElement;
  private mode: Mode = 'hidden';
  private aspect = 16 / 9;
  private area: Rect | null = null;
  private readonly observer: ResizeObserver | null;
  private painted = false;

  constructor(private readonly deps: CamStageDeps) {
    this.video = h('video', { class: 'live', attrs: { autoplay: '', muted: '', playsinline: '' } });
    this.video.muted = true;
    this.canvas = h('canvas', { class: 'play', hidden: true });
    this.handle = h('span', {
      class: 'handle',
      title: 'Drag to resize the picture',
      attrs: { role: 'presentation' },
    });
    this.badge = h('span', { class: 'badge' }, 'Camera');
    this.box = h(
      'div',
      {
        class: 'cam-box',
        title:
          'Your camera picture, where it will be in the video. Drag it anywhere on the slide; drag the corner to resize it.',
        attrs: { role: 'group', 'aria-label': 'Camera picture' },
      },
      this.video,
      this.canvas,
      this.badge,
      this.handle,
    );
    this.layer = h('div', { class: 'cam-layer', hidden: true }, this.box);
    deps.stage.appendChild(this.layer);
    this.wire();
    this.observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            this.relayout();
          });
    this.observer?.observe(deps.img);
    this.observer?.observe(deps.stage);
    deps.img.addEventListener('load', () => this.relayout());
    window.addEventListener('resize', () => this.relayout());
  }

  get shown(): boolean {
    return this.mode !== 'hidden';
  }

  /** Shows the live camera. */
  showLive(stream: MediaStream, aspect: number): void {
    this.mode = 'live';
    this.aspect = aspect;
    if (this.video.srcObject !== stream) {
      this.video.srcObject = stream;
      this.video.play().catch(() => undefined);
    }
    this.video.hidden = false;
    this.canvas.hidden = true;
    this.badge.textContent = 'Camera';
    this.layer.hidden = false;
    this.relayout();
  }

  /** Shows recorded frames, painted with {@link paint}; nothing is drawn until the first one. */
  showPlayback(aspect: number): void {
    this.mode = 'play';
    this.aspect = aspect;
    this.video.hidden = true;
    this.canvas.hidden = false;
    this.painted = false;
    this.badge.textContent = '';
    this.layer.hidden = true;
    this.relayout();
  }

  /** The frame to show now; null clears the picture (a phrase recorded without the camera). */
  paint(frame: VideoFrame | null, aspect?: number): void {
    if (this.mode !== 'play') return;
    if (!frame) {
      this.layer.hidden = true;
      this.painted = false;
      return;
    }
    if (aspect && Math.abs(aspect - this.aspect) > 1e-3) {
      this.aspect = aspect;
      this.relayout();
    }
    const w = frame.displayWidth;
    const hgt = frame.displayHeight;
    if (this.canvas.width !== w || this.canvas.height !== hgt) {
      this.canvas.width = w;
      this.canvas.height = hgt;
    }
    const g = this.canvas.getContext('2d');
    if (!g) return;
    g.drawImage(frame, 0, 0, w, hgt);
    if (!this.painted) {
      this.painted = true;
      this.layer.hidden = false;
      this.relayout();
    }
  }

  hide(): void {
    this.mode = 'hidden';
    this.layer.hidden = true;
    this.video.hidden = true;
    this.canvas.hidden = true;
    if (this.video.srcObject) {
      this.video.pause();
      this.video.srcObject = null;
    }
  }

  /** The layout changed elsewhere (a corner button, the size slider). */
  relayout(): void {
    if (this.mode === 'hidden') return;
    const stage = this.deps.stage.getBoundingClientRect();
    const img = this.deps.img.getBoundingClientRect();
    if (img.width < 2 || img.height < 2 || this.deps.img.style.display === 'none') {
      this.area = null;
      this.layer.hidden = true;
      return;
    }
    this.area = { x: img.left - stage.left, y: img.top - stage.top, width: img.width, height: img.height };
    const a = this.area;
    this.layer.style.left = `${a.x}px`;
    this.layer.style.top = `${a.y}px`;
    this.layer.style.width = `${a.width}px`;
    this.layer.style.height = `${a.height}px`;
    if (this.mode === 'live' || this.painted) this.layer.hidden = false;
    this.place(this.deps.layout());
  }

  /** Puts the box where `layout` says, within the measured slide area. */
  private place(layout: CameraLayout): void {
    const area = this.area;
    if (!area) return;
    const local = { x: 0, y: 0, width: area.width, height: area.height };
    const r = overlayRect(layout, local, this.aspect);
    this.box.style.left = `${r.x}px`;
    this.box.style.top = `${r.y}px`;
    this.box.style.width = `${r.width}px`;
    this.box.style.height = `${r.height}px`;
    // the resize handle goes on the corner that is free to move: away from the edge the box hugs
    this.box.classList.toggle('handle-left', layout.x >= 0.5);
    this.box.classList.toggle('handle-top', layout.y >= 0.5);
  }

  /* ---------------------------------------------------------------- pointer */

  private wire(): void {
    let drag: {
      id: number;
      kind: 'move' | 'size';
      startX: number;
      startY: number;
      box: Rect;
      layout: CameraLayout;
      moved: boolean;
    } | null = null;
    const down = (kind: 'move' | 'size') => (ev: PointerEvent) => {
      if (ev.button !== 0 || !this.area) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.box.setPointerCapture(ev.pointerId);
      drag = {
        id: ev.pointerId,
        kind,
        startX: ev.clientX,
        startY: ev.clientY,
        box: {
          x: parseFloat(this.box.style.left) || 0,
          y: parseFloat(this.box.style.top) || 0,
          width: parseFloat(this.box.style.width) || 1,
          height: parseFloat(this.box.style.height) || 1,
        },
        layout: this.deps.layout(),
        moved: false,
      };
      this.box.classList.add('dragging');
    };
    this.box.addEventListener('pointerdown', down('move'));
    this.handle.addEventListener('pointerdown', down('size'));
    this.box.addEventListener('pointermove', (ev) => {
      const d = drag;
      const area = this.area;
      if (d?.id !== ev.pointerId || !area) return;
      const dx = ev.clientX - d.startX;
      const dy = ev.clientY - d.startY;
      if (!d.moved && Math.abs(dx) < DRAG_PX && Math.abs(dy) < DRAG_PX) return;
      d.moved = true;
      const local = { x: 0, y: 0, width: area.width, height: area.height };
      let next: CameraLayout;
      if (d.kind === 'move') {
        next = snapToCorner(layoutAt(d.layout, local, this.aspect, d.box.x + dx, d.box.y + dy));
      } else {
        // the handle sits on the free corner, so pulling it away from the anchored corner grows the box
        const left = this.box.classList.contains('handle-left');
        const top = this.box.classList.contains('handle-top');
        const dw = left ? -dx : dx;
        const dh = top ? -dy : dy;
        const width = Math.max(d.box.width + dw, (d.box.height + dh) * this.aspect);
        next = { ...d.layout, size: sizeForWidth(width, local) };
      }
      this.place(next);
      this.deps.onLayout(next, false);
    });
    const up = (ev: PointerEvent) => {
      const d = drag;
      if (d?.id !== ev.pointerId) return;
      drag = null;
      this.box.classList.remove('dragging');
      try {
        this.box.releasePointerCapture(ev.pointerId);
      } catch {
        /* already released */
      }
      if (d.moved) this.deps.onLayout(this.deps.layout(), true);
    };
    this.box.addEventListener('pointerup', up);
    this.box.addEventListener('pointercancel', up);
    this.box.addEventListener('dblclick', (ev) => ev.stopPropagation());
    this.box.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }
}
