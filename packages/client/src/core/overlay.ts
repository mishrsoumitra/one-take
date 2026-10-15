/**
 * Where the camera's picture sits on the slide, and how big it is.
 *
 * The user chooses a corner, or drags the picture anywhere on the slide, and sets its size. The
 * choice is kept as fractions, not pixels, so the same layout works on the stage (whatever size the
 * window is), in the preview and in the exported video at any resolution:
 *
 * - `size` is the picture's width as a fraction of the slide's width.
 * - `x` and `y` say where the picture is within the room it has: 0 is flush with the left or top
 *   margin, 1 with the right or bottom one, and anything between is a spot in between. The four
 *   corners are (0,0), (1,0), (0,1) and (1,1).
 *
 * The picture always stays on the slide, a small margin in from its edge.
 */

export interface CameraLayout {
  /** 0 (left) to 1 (right). */
  x: number;
  /** 0 (top) to 1 (bottom). */
  y: number;
  /** Width as a fraction of the slide's width, between {@link CAMERA_SIZE_MIN} and {@link CAMERA_SIZE_MAX}. */
  size: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const CAMERA_SIZE_MIN = 0.12;
export const CAMERA_SIZE_MAX = 0.5;
export const CAMERA_SIZE_DEFAULT = 0.24;
/** The gap between the picture and the slide's edge, as a fraction of the slide's width. */
export const CAMERA_MARGIN = 0.025;
/** The picture is never taller than this much of the slide, however wide it was asked to be. */
const MAX_HEIGHT = 0.9;

export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export const CORNERS: Record<Corner, { x: number; y: number }> = {
  'top-left': { x: 0, y: 0 },
  'top-right': { x: 1, y: 0 },
  'bottom-left': { x: 0, y: 1 },
  'bottom-right': { x: 1, y: 1 },
};

export const CORNER_LABELS: Record<Corner, string> = {
  'top-left': 'Top left',
  'top-right': 'Top right',
  'bottom-left': 'Bottom left',
  'bottom-right': 'Bottom right',
};

export const DEFAULT_CAMERA_LAYOUT: CameraLayout = { ...CORNERS['bottom-right'], size: CAMERA_SIZE_DEFAULT };

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function clampSize(size: number): number {
  return Math.max(CAMERA_SIZE_MIN, Math.min(CAMERA_SIZE_MAX, size));
}

/** A layout read back from storage: numbers clamped into range, anything else the default. */
export function normalizeLayout(raw: unknown): CameraLayout {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_CAMERA_LAYOUT };
  const r = raw as Partial<Record<keyof CameraLayout, unknown>>;
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  return {
    x: clamp01(num(r.x, DEFAULT_CAMERA_LAYOUT.x)),
    y: clamp01(num(r.y, DEFAULT_CAMERA_LAYOUT.y)),
    size: clampSize(num(r.size, DEFAULT_CAMERA_LAYOUT.size)),
  };
}

/** The corner the layout sits in, or null when it was dragged somewhere else. */
export function cornerOf(layout: CameraLayout): Corner | null {
  for (const [name, c] of Object.entries(CORNERS) as [Corner, { x: number; y: number }][]) {
    if (Math.abs(layout.x - c.x) < 0.02 && Math.abs(layout.y - c.y) < 0.02) return name;
  }
  return null;
}

/** How the layout reads: `Bottom right` or `Anywhere (dragged)`. */
export function describeLayout(layout: CameraLayout): string {
  const corner = cornerOf(layout);
  return `${corner ? CORNER_LABELS[corner] : 'Where you dragged it'} · ${Math.round(layout.size * 100)} % of the slide's width`;
}

/** The picture's box within `area` (the slide on the stage or in the frame), for a camera of `aspect` (width / height). */
export function overlayRect(layout: CameraLayout, area: Rect, aspect: number): Rect {
  const ratio = aspect > 0 && Number.isFinite(aspect) ? aspect : 16 / 9;
  const margin = CAMERA_MARGIN * area.width;
  let width = clampSize(layout.size) * area.width;
  let height = width / ratio;
  const maxHeight = Math.min(area.height * MAX_HEIGHT, area.height - 2 * margin);
  if (height > maxHeight) {
    height = Math.max(1, maxHeight);
    width = height * ratio;
  }
  const roomX = Math.max(0, area.width - 2 * margin - width);
  const roomY = Math.max(0, area.height - 2 * margin - height);
  return {
    x: area.x + margin + clamp01(layout.x) * roomX,
    y: area.y + margin + clamp01(layout.y) * roomY,
    width,
    height,
  };
}

/**
 * The reverse of {@link overlayRect} for dragging: the `x` and `y` that put the picture's top-left
 * corner at (`left`, `top`) within `area`, clamped so it stays on the slide.
 */
export function layoutAt(
  layout: CameraLayout,
  area: Rect,
  aspect: number,
  left: number,
  top: number,
): CameraLayout {
  const box = overlayRect(layout, area, aspect);
  const margin = CAMERA_MARGIN * area.width;
  const roomX = area.width - 2 * margin - box.width;
  const roomY = area.height - 2 * margin - box.height;
  return {
    ...layout,
    x: roomX > 0 ? clamp01((left - area.x - margin) / roomX) : 0,
    y: roomY > 0 ? clamp01((top - area.y - margin) / roomY) : 0,
  };
}

/** Snaps a dragged layout to a corner when it is within `snap` of one (a fraction of the room). */
export function snapToCorner(layout: CameraLayout, snap = 0.06): CameraLayout {
  const x = layout.x < snap ? 0 : layout.x > 1 - snap ? 1 : layout.x;
  const y = layout.y < snap ? 0 : layout.y > 1 - snap ? 1 : layout.y;
  return { ...layout, x, y };
}

/** The size that makes the picture `width` wide within `area`, for the resize handle. */
export function sizeForWidth(width: number, area: Rect): number {
  return area.width > 0 ? clampSize(width / area.width) : CAMERA_SIZE_DEFAULT;
}
