/**
 * The pen's drawings on a stage: a canvas laid over the slide image exactly where the strokes land
 * in the video, showing the board (and the stroke being drawn) while recording, and the recorded
 * strokes while playing.
 *
 * The layer follows the slide image's rendered rectangle, like the camera box (`cam-stage.ts`), and
 * draws with the same `drawInk` as the export, so what the user sees is what they get. While the
 * stage is drawable it takes the pointer: a press starts a stroke, movement adds points (coalesced,
 * so a fast pen leaves no corners), release ends it. The points handed out are fractions of the
 * slide's area; the layer itself knows nothing about clips.
 */
import { drawInk, type InkStroke } from '../core/ink.js';
import { type Rect } from '../core/overlay.js';

import { h } from './dom.js';

export interface InkStageDeps {
  /** The stage the slide image sits on; the layer is positioned within it. */
  stage: HTMLElement;
  /** The slide image; the layer follows its rendered box. */
  img: HTMLImageElement;
  /** The pen went down at (x, y), fractions of the slide; false refuses the stroke (the mic is off, say). */
  onStrokeStart?: (x: number, y: number) => boolean;
  onPoint?: (x: number, y: number) => void;
  onStrokeEnd?: () => void;
}

export class InkStage {
  readonly layer: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  private area: Rect | null = null;
  private strokes: readonly InkStroke[] = [];
  private drawable = false;
  private pointer: number | null = null;
  private readonly observer: ResizeObserver | null;

  constructor(private readonly deps: InkStageDeps) {
    this.canvas = h('canvas', { class: 'ink', attrs: { 'aria-label': 'Drawings on the slide' } });
    this.layer = h('div', { class: 'ink-layer', hidden: true }, this.canvas);
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

  /** Whether the layer takes the pointer right now. */
  get canDraw(): boolean {
    return this.drawable;
  }

  /** The slide's box within the stage, as last measured. */
  get slideArea(): Rect | null {
    return this.area;
  }

  /** The strokes shown right now. */
  get shown(): readonly InkStroke[] {
    return this.strokes;
  }

  /** Lets the user draw (true) or only look (false). */
  setDrawable(on: boolean): void {
    if (this.drawable === on) return;
    this.drawable = on;
    this.layer.classList.toggle('drawing', on);
    if (!on && this.pointer !== null) this.endStroke();
    this.relayout();
  }

  /** Shows these strokes (an empty list clears the slide). */
  show(strokes: readonly InkStroke[]): void {
    this.strokes = strokes;
    this.paint();
  }

  hide(): void {
    this.strokes = [];
    this.paint();
  }

  /** The slide image moved or resized: measure it again and redraw. */
  relayout(): void {
    const stage = this.deps.stage.getBoundingClientRect();
    const img = this.deps.img.getBoundingClientRect();
    if (img.width < 2 || img.height < 2 || this.deps.img.style.display === 'none' || this.deps.img.hidden) {
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
    this.paint();
  }

  private paint(): void {
    const area = this.area;
    const visible = area !== null && (this.drawable || this.strokes.length > 0);
    this.layer.hidden = !visible;
    if (!area || !visible) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(area.width * dpr));
    const hgt = Math.max(1, Math.round(area.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== hgt) {
      this.canvas.width = w;
      this.canvas.height = hgt;
    }
    const g = this.canvas.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, w, hgt);
    drawInk(g, this.strokes, { x: 0, y: 0, width: w, height: hgt });
  }

  /* ---------------------------------------------------------------- pointer */

  private at(ev: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: r.width > 0 ? (ev.clientX - r.left) / r.width : 0,
      y: r.height > 0 ? (ev.clientY - r.top) / r.height : 0,
    };
  }

  private wire(): void {
    this.canvas.addEventListener('pointerdown', (ev) => {
      if (!this.drawable || this.pointer !== null) return;
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      const p = this.at(ev);
      if (this.deps.onStrokeStart && !this.deps.onStrokeStart(p.x, p.y)) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.pointer = ev.pointerId;
      try {
        this.canvas.setPointerCapture(ev.pointerId);
      } catch {
        /* a synthetic pointer */
      }
    });
    this.canvas.addEventListener('pointermove', (ev) => {
      if (this.pointer !== ev.pointerId) return;
      ev.preventDefault();
      // every sample the pen made since the last event, not just the last one
      const events: PointerEvent[] =
        typeof ev.getCoalescedEvents === 'function' && ev.getCoalescedEvents().length > 0
          ? ev.getCoalescedEvents()
          : [ev];
      for (const e of events) {
        const p = this.at(e);
        this.deps.onPoint?.(p.x, p.y);
      }
    });
    const up = (ev: PointerEvent) => {
      if (this.pointer !== ev.pointerId) return;
      ev.preventDefault();
      this.endStroke();
    };
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
    this.canvas.addEventListener('lostpointercapture', (ev) => {
      if (this.pointer === ev.pointerId) this.endStroke();
    });
    this.canvas.addEventListener('contextmenu', (ev) => {
      if (this.drawable) ev.preventDefault();
    });
    window.addEventListener('blur', () => {
      if (this.pointer !== null) this.endStroke();
    });
  }

  private endStroke(): void {
    const id = this.pointer;
    this.pointer = null;
    if (id !== null) {
      try {
        this.canvas.releasePointerCapture(id);
      } catch {
        /* already released */
      }
    }
    this.deps.onStrokeEnd?.();
  }
}
