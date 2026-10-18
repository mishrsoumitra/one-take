/**
 * Annotations: strokes drawn on a slide with the pen, kept as a clip of their own and drawn into the
 * video as they were made.
 *
 * A **drawing clip** is a segment with `ink` and silence for its sound: while it plays, its strokes
 * appear point by point at the pace they were drawn, and the microphone heard nothing, because the
 * pen and the voice are never recorded together (see `recorder.ts`: the pen going down ends the
 * phrase being spoken and closes the gate until the pen rests). A **wipe** is a drawing clip with no
 * strokes that clears the slide at its start.
 *
 * The strokes on a slide stay there. What is visible during any clip of the timeline is the
 * **board**: every stroke drawn in an earlier clip on the same slide, back to the last wipe on that
 * slide. So a voice clip recorded after a drawing shows the drawing, a clip moved in the editor shows
 * the drawings that come before it in its new place, and a slide revisited later still has its
 * annotations.
 *
 * Points are fractions of the slide's area (0..1 across and down), so the same stroke lands on the
 * same spot on the stage, in the preview and in the exported video at any resolution; a width is a
 * fraction of the slide's width. Times are milliseconds from the start of the clip.
 *
 * Everything here is plain arithmetic on plain objects, apart from `drawInk`, which draws onto any
 * 2D canvas; the rest runs in tests as well as in the browser.
 */
import { type Segment } from './timeline.js';

export type InkTool = 'pen' | 'highlighter';

export interface InkPoint {
  /** Across the slide, 0 (left) to 1 (right). */
  x: number;
  /** Down the slide, 0 (top) to 1 (bottom). */
  y: number;
  /** Milliseconds from the start of the clip. */
  t: number;
}

export interface InkStroke {
  tool: InkTool;
  /** A CSS colour. */
  color: string;
  /** The line's width as a fraction of the slide's width. */
  width: number;
  /** In the order drawn; never empty once stored. */
  points: InkPoint[];
}

/** What a drawing clip holds: the strokes it draws, and whether it clears the slide first. */
export interface ClipInk {
  /** The slide is wiped clean at the start of the clip. */
  wipe: boolean;
  strokes: InkStroke[];
}

/** The pen as the user set it: tool, colour and width. */
export interface PenSettings {
  tool: InkTool;
  color: string;
  width: number;
}

export const PEN_COLORS: readonly { value: string; label: string }[] = [
  { value: '#ff3b30', label: 'Red' },
  { value: '#ff9f0a', label: 'Orange' },
  { value: '#ffd60a', label: 'Yellow' },
  { value: '#34c759', label: 'Green' },
  { value: '#0673f9', label: 'Blue' },
  { value: '#111111', label: 'Black' },
  { value: '#ffffff', label: 'White' },
];

/** Line widths as fractions of the slide's width: thin, medium, thick. */
export const PEN_WIDTHS: readonly { value: number; label: string }[] = [
  { value: 0.0025, label: 'Thin' },
  { value: 0.005, label: 'Medium' },
  { value: 0.01, label: 'Thick' },
];

/** The highlighter is this many times wider than the pen at the same setting, and translucent. */
export const HIGHLIGHTER_SCALE = 4;
export const HIGHLIGHTER_ALPHA = 0.35;

export const DEFAULT_PEN: PenSettings = { tool: 'pen', color: '#ff3b30', width: 0.005 };

/** A pen read back from storage: a known tool, any colour string, a width within range. */
export function normalizePen(raw: unknown): PenSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_PEN };
  const r = raw as Partial<Record<keyof PenSettings, unknown>>;
  const tool: InkTool = r.tool === 'highlighter' ? 'highlighter' : 'pen';
  const color =
    typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color)
      ? r.color.toLowerCase()
      : DEFAULT_PEN.color;
  const width =
    typeof r.width === 'number' && Number.isFinite(r.width)
      ? Math.max(0.001, Math.min(0.03, r.width))
      : DEFAULT_PEN.width;
  return { tool, color, width };
}

/* ------------------------------------------------------------------ */
/* The live session: strokes as they are drawn                         */
/* ------------------------------------------------------------------ */

/** The pen resting this long after a stroke ends the drawing clip. */
export const INK_REST_MS = 1200;
/** A pause between two strokes inside one clip is kept, but never longer than this. */
export const INK_GAP_KEEP_MS = 400;
/** How long the last stroke stays alone on screen before the clip ends. */
export const INK_TAIL_MS = 150;
/** A wipe shows the clean slide for this long. */
export const WIPE_MS = 400;
/** Two points closer than this (as a fraction of the slide) are one point: a pen held still adds nothing. */
const MIN_STEP = 0.0005;

/**
 * One drawing in the making: from the first pen-down until the pen has rested. It keeps time from
 * the wall clock it is given (`performance.now()` in the browser, anything in tests) and hands back
 * the finished clip with its pauses shortened and the end trimmed.
 */
export class InkSession {
  private readonly strokes: InkStroke[] = [];
  private current: InkStroke | null = null;
  /** Wall time the pen last went up; null while it is down. */
  private restingSince: number | null = null;

  constructor(
    /** Wall time the session began: the first pen-down. */
    readonly startedAt: number,
    readonly slide: number,
  ) {}

  /** The pen is on the slide right now. */
  get down(): boolean {
    return this.current !== null;
  }

  /** Strokes finished so far, plus the one being drawn. */
  get all(): readonly InkStroke[] {
    return this.current ? [...this.strokes, this.current] : this.strokes;
  }

  get strokeCount(): number {
    return this.strokes.length + (this.current ? 1 : 0);
  }

  /** The pen has been up since `restingSince` and nothing was drawn for `INK_REST_MS`: the clip is over. */
  rested(now: number): boolean {
    return this.restingSince !== null && now - this.restingSince >= INK_REST_MS;
  }

  /** Wall time at which the rest will be over, or null while the pen is down. */
  get restEndsAt(): number | null {
    return this.restingSince === null ? null : this.restingSince + INK_REST_MS;
  }

  strokeStart(now: number, pen: PenSettings, x: number, y: number): void {
    if (this.current) this.strokeEnd(now);
    this.restingSince = null;
    this.current = {
      tool: pen.tool,
      color: pen.color,
      width: pen.width,
      points: [{ x: clamp01(x), y: clamp01(y), t: Math.max(0, now - this.startedAt) }],
    };
  }

  /** A point of the stroke being drawn; ignored while the pen is up or when it has not moved. */
  point(now: number, x: number, y: number): boolean {
    const s = this.current;
    if (!s) return false;
    const last = s.points[s.points.length - 1];
    const px = clamp01(x);
    const py = clamp01(y);
    if (last && Math.abs(last.x - px) < MIN_STEP && Math.abs(last.y - py) < MIN_STEP) return false;
    s.points.push({ x: px, y: py, t: Math.max(last?.t ?? 0, now - this.startedAt) });
    return true;
  }

  strokeEnd(now: number): void {
    const s = this.current;
    if (!s) return;
    this.current = null;
    this.strokes.push(s);
    this.restingSince = now;
  }

  /**
   * Takes back the last stroke (the one being drawn, else the last finished one); false when there
   * is none. Taking back the stroke being drawn lifts the pen: the rest starts now.
   */
  undoStroke(now: number): boolean {
    if (this.current) {
      this.current = null;
      this.restingSince = now;
      return true;
    }
    return this.strokes.pop() !== undefined;
  }

  /**
   * The finished clip: the pen's pauses between strokes shortened to `INK_GAP_KEEP_MS`, a short tail
   * after the last point, and nothing of the rest. Null when nothing was drawn.
   */
  finish(now: number): { ink: ClipInk; durationMs: number } | null {
    if (this.current) this.strokeEnd(now);
    if (this.strokes.length === 0) return null;
    const strokes: InkStroke[] = [];
    let shift = 0;
    let prevEnd = 0;
    for (const s of this.strokes) {
      const first = s.points[0];
      if (!first) continue;
      const gap = first.t - prevEnd;
      if (gap > INK_GAP_KEEP_MS) shift += gap - INK_GAP_KEEP_MS;
      const points = s.points.map((p) => ({ x: p.x, y: p.y, t: Math.round(p.t - shift) }));
      const lastPoint = points[points.length - 1];
      prevEnd = lastPoint ? lastPoint.t + shift : prevEnd;
      strokes.push({ ...s, points });
    }
    const lastT = strokes.reduce((m, s) => Math.max(m, s.points[s.points.length - 1]?.t ?? 0), 0);
    return { ink: { wipe: false, strokes }, durationMs: lastT + INK_TAIL_MS };
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
}

/* ------------------------------------------------------------------ */
/* Clips and the board                                                 */
/* ------------------------------------------------------------------ */

/** A drawing clip: silence with strokes (or a wipe) over it. */
export function isInk(seg: Pick<Segment, 'ink'>): boolean {
  return seg.ink !== undefined;
}

/** How long the clip's drawing takes, in seconds: the last point plus the tail. */
export function inkDuration(ink: ClipInk): number {
  let last = 0;
  for (const s of ink.strokes) last = Math.max(last, s.points[s.points.length - 1]?.t ?? 0);
  return (last + INK_TAIL_MS) / 1000;
}

/** `6 strokes` or `cleared the slide`. */
export function describeInk(ink: ClipInk): string {
  if (ink.strokes.length === 0) return ink.wipe ? 'cleared the slide' : 'empty drawing';
  const n = ink.strokes.length;
  return `${ink.wipe ? 'cleared, then ' : ''}${n} stroke${n === 1 ? '' : 's'}`;
}

/**
 * The strokes on `slide` when the clip at `index` begins: everything drawn by earlier clips on that
 * slide since the last wipe. With `index` equal to the list's length, the board as it is now.
 */
export function boardBefore(
  segments: readonly Pick<Segment, 'slide' | 'ink'>[],
  index: number,
  slide: number,
): InkStroke[] {
  let board: InkStroke[] = [];
  const end = Math.min(index, segments.length);
  for (let i = 0; i < end; i++) {
    const seg = segments[i];
    const ink = seg?.slide === slide ? seg.ink : undefined;
    if (!ink) continue;
    if (ink.wipe) board = [];
    if (ink.strokes.length > 0) board = board.concat(ink.strokes);
  }
  return board;
}

/** The part of a stroke drawn by `ms`: whole when it is over, cut short while it is being drawn, null before it starts. */
export function strokeUntil(stroke: InkStroke, ms: number): InkStroke | null {
  const pts = stroke.points;
  const first = pts[0];
  if (!first || first.t > ms) return null;
  if ((pts[pts.length - 1]?.t ?? Infinity) <= ms) return stroke;
  let n = 0;
  while (n < pts.length && (pts[n]?.t ?? Infinity) <= ms) n++;
  return { ...stroke, points: pts.slice(0, Math.max(1, n)) };
}

/**
 * What a drawing clip shows `ms` into itself, over `board` (the strokes already on the slide): the
 * board, unless the clip wipes it, then the clip's own strokes as far as they have got.
 */
export function inkAt(board: readonly InkStroke[], ink: ClipInk, ms: number): InkStroke[] {
  const out = ink.wipe ? [] : board.slice();
  for (const s of ink.strokes) {
    const part = strokeUntil(s, ms);
    if (part) out.push(part);
  }
  return out;
}

/** How many points of the clip are on screen `ms` in: a number that changes exactly when the picture does. */
export function pointsShown(ink: ClipInk, ms: number): number {
  let n = 0;
  for (const s of ink.strokes) for (const p of s.points) if (p.t <= ms) n++;
  return n;
}

/* ------------------------------------------------------------------ */
/* Edits: the same cuts as the sound                                   */
/* ------------------------------------------------------------------ */

/** The stretch `[fromMs, toMs)` of a drawing, times rebased to `fromMs`; a wipe survives only at the very start. */
export function sliceInk(ink: ClipInk, fromMs: number, toMs: number): ClipInk {
  const strokes: InkStroke[] = [];
  for (const s of ink.strokes) {
    const points = s.points
      .filter((p) => p.t >= fromMs && p.t < toMs)
      .map((p) => ({ ...p, t: p.t - fromMs }));
    if (points.length > 0) strokes.push({ ...s, points });
  }
  return { wipe: ink.wipe && fromMs <= 0, strokes };
}

/** The drawing with `[fromMs, toMs)` taken out: what came after moves up to close the hole. */
export function cutInk(ink: ClipInk, fromMs: number, toMs: number): ClipInk {
  const removed = Math.max(0, toMs - fromMs);
  const strokes: InkStroke[] = [];
  for (const s of ink.strokes) {
    const points: InkPoint[] = [];
    for (const p of s.points) {
      if (p.t < fromMs) points.push(p);
      else if (p.t >= toMs) points.push({ ...p, t: p.t - removed });
    }
    if (points.length > 0) strokes.push({ ...s, points });
  }
  return { wipe: ink.wipe, strokes };
}

/** `a` then `b`, with `b`'s times moved after `a`'s `durationMs`. */
export function concatInk(a: ClipInk, b: ClipInk, aDurationMs: number): ClipInk {
  return {
    wipe: a.wipe,
    strokes: [
      ...a.strokes,
      ...b.strokes.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p, t: p.t + aDurationMs })) })),
    ],
  };
}

/** The same strokes drawn `speed` times faster, to follow sound that was stretched. */
export function inkAtSpeed(ink: ClipInk, speed: number): ClipInk {
  if (Math.abs(speed - 1) < 0.005) return ink;
  return {
    wipe: ink.wipe,
    strokes: ink.strokes.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p, t: p.t / speed })) })),
  };
}

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface InkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Draws the strokes into `area` (the slide's box on a canvas). A pen stroke is a smooth line with
 * round ends; a highlighter is a wide translucent one with square ends, drawn under the pen strokes
 * so a mark never hides a line.
 */
export function drawInk(g: Canvas2D, strokes: readonly InkStroke[], area: InkArea): void {
  if (strokes.length === 0 || area.width <= 0 || area.height <= 0) return;
  g.save();
  g.lineJoin = 'round';
  for (const pass of ['highlighter', 'pen'] as const) {
    for (const s of strokes) {
      if (s.tool !== pass || s.points.length === 0) continue;
      drawStroke(g, s, area);
    }
  }
  g.restore();
}

function drawStroke(g: Canvas2D, s: InkStroke, area: InkArea): void {
  const px = (p: InkPoint) => area.x + p.x * area.width;
  const py = (p: InkPoint) => area.y + p.y * area.height;
  const highlighter = s.tool === 'highlighter';
  g.strokeStyle = s.color;
  g.fillStyle = s.color;
  g.globalAlpha = highlighter ? HIGHLIGHTER_ALPHA : 1;
  g.lineCap = highlighter ? 'butt' : 'round';
  const width = Math.max(1, s.width * area.width * (highlighter ? HIGHLIGHTER_SCALE : 1));
  g.lineWidth = width;
  const pts = s.points;
  const first = pts[0];
  if (!first) return;
  if (pts.length === 1) {
    // a tap: a dot the width of the line
    g.beginPath();
    g.arc(px(first), py(first), width / 2, 0, Math.PI * 2);
    g.fill();
    return;
  }
  g.beginPath();
  g.moveTo(px(first), py(first));
  if (pts.length === 2) {
    const second = pts[1];
    if (second) g.lineTo(px(second), py(second));
  } else {
    // through the midpoints, each point a control: smooth, and the line still passes close to every point
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      if (!p || !q) break;
      g.quadraticCurveTo(px(p), py(p), (px(p) + px(q)) / 2, (py(p) + py(q)) / 2);
    }
    const last = pts[pts.length - 1];
    if (last) g.lineTo(px(last), py(last));
  }
  g.stroke();
}
