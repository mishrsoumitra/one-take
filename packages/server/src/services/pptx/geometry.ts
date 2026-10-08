/** Colours and SVG path arithmetic for the slide renderer. Pure functions, no PDF involved. */

export interface Rgba {
  /** `#rrggbb` */
  hex: string;
  /** 0..1 */
  alpha: number;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function channel(n: number): string {
  return Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, '0');
}

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()`; null for anything else (including "transparent"). */
export function parseColor(input: string | null | undefined): Rgba | null {
  if (!input) return null;
  const value = input.trim().toLowerCase();
  if (value === 'transparent' || value === 'none') return null;
  const hex = /^#([0-9a-f]{3,8})$/.exec(value)?.[1];
  if (hex) {
    if (hex.length === 3 || hex.length === 4) {
      const [r = '0', g = '0', b = '0', a] = hex;
      return {
        hex: `#${r}${r}${g}${g}${b}${b}`,
        alpha: a === undefined ? 1 : Number.parseInt(a + a, 16) / 255,
      };
    }
    if (hex.length === 6) return { hex: `#${hex}`, alpha: 1 };
    if (hex.length === 8)
      return { hex: `#${hex.slice(0, 6)}`, alpha: Number.parseInt(hex.slice(6), 16) / 255 };
    return null;
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+%?)\s*)?\)$/.exec(value);
  if (rgb) {
    const alphaRaw = rgb[4];
    const alpha =
      alphaRaw === undefined
        ? 1
        : alphaRaw.endsWith('%')
          ? Number(alphaRaw.slice(0, -1)) / 100
          : Number(alphaRaw);
    return {
      hex: `#${channel(Number(rgb[1]))}${channel(Number(rgb[2]))}${channel(Number(rgb[3]))}`,
      alpha: clamp01(Number.isFinite(alpha) ? alpha : 1),
    };
  }
  return null;
}

/** Mixes a colour towards black (amount < 0) or white (amount > 0); used for simple shadows and charts. */
export function shade(hex: string, amount: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const mix = (c: number) => (amount >= 0 ? c + (255 - c) * amount : c * (1 + amount));
  return `#${channel(mix((n >> 16) & 255))}${channel(mix((n >> 8) & 255))}${channel(mix(n & 255))}`;
}

/* ------------------------------------------------------------------ */
/* SVG paths                                                           */
/* ------------------------------------------------------------------ */

const PARAMS: Record<string, number> = { M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7, Z: 0 };
const TOKEN = /[a-df-zA-DF-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, '');
}

/**
 * Scales a path from its own view box into a box of the wanted size, moving it to (dx, dy). Done on the
 * numbers rather than with a transform so that stroke widths stay what the deck asked for.
 */
export function scalePath(path: string, sx: number, sy: number, dx = 0, dy = 0): string {
  const tokens = path.match(TOKEN) ?? [];
  const out: string[] = [];
  let command = '';
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] ?? '';
    if (/^[a-zA-Z]$/.test(token)) {
      command = token;
      i += 1;
      if (command.toUpperCase() === 'Z') {
        out.push('Z');
        continue;
      }
    } else if (!command) {
      i += 1;
      continue;
    }
    const upper = command.toUpperCase();
    const count = PARAMS[upper] ?? 0;
    if (count === 0) break;
    const nums = tokens.slice(i, i + count).map(Number);
    if (nums.length < count || nums.some((n) => !Number.isFinite(n))) break;
    i += count;
    const relative = command !== upper;
    const ox = relative ? 0 : dx;
    const oy = relative ? 0 : dy;
    let scaled: number[];
    switch (upper) {
      case 'H':
        scaled = [(nums[0] ?? 0) * sx + ox];
        break;
      case 'V':
        scaled = [(nums[0] ?? 0) * sy + oy];
        break;
      case 'A':
        scaled = [
          (nums[0] ?? 0) * Math.abs(sx),
          (nums[1] ?? 0) * Math.abs(sy),
          nums[2] ?? 0,
          nums[3] ?? 0,
          nums[4] ?? 0,
          (nums[5] ?? 0) * sx + ox,
          (nums[6] ?? 0) * sy + oy,
        ];
        break;
      default:
        scaled = nums.map((n, k) => (k % 2 === 0 ? n * sx + ox : n * sy + oy));
    }
    out.push(`${command} ${scaled.map(fmt).join(' ')}`);
    // further coordinate groups after M/m continue as L/l
    if (upper === 'M') command = relative ? 'l' : 'L';
  }
  return out.join(' ');
}

export interface Point {
  x: number;
  y: number;
}

/** The two end points when the path is a plain "M x y L x y" segment (after scaling); null otherwise. */
export function straightLine(path: string): { start: Point; end: Point } | null {
  const m = /^M\s+(-?[\d.]+)\s+(-?[\d.]+)\s+L\s+(-?[\d.]+)\s+(-?[\d.]+)\s*(?:Z)?$/i.exec(path.trim());
  if (!m) return null;
  return {
    start: { x: Number(m[1]), y: Number(m[2]) },
    end: { x: Number(m[3]), y: Number(m[4]) },
  };
}

/** A closed path for the common preset shapes, so images can be clipped to them. */
export function presetPath(geom: string, w: number, h: number): string | null {
  switch (geom) {
    case 'ellipse':
      return `M 0 ${fmt(h / 2)} A ${fmt(w / 2)} ${fmt(h / 2)} 0 1 0 ${fmt(w)} ${fmt(h / 2)} A ${fmt(w / 2)} ${fmt(h / 2)} 0 1 0 0 ${fmt(h / 2)} Z`;
    case 'roundRect': {
      const r = Math.min(w, h) * 0.1667;
      return `M ${fmt(r)} 0 L ${fmt(w - r)} 0 Q ${fmt(w)} 0 ${fmt(w)} ${fmt(r)} L ${fmt(w)} ${fmt(h - r)} Q ${fmt(w)} ${fmt(h)} ${fmt(w - r)} ${fmt(h)} L ${fmt(r)} ${fmt(h)} Q 0 ${fmt(h)} 0 ${fmt(h - r)} L 0 ${fmt(r)} Q 0 0 ${fmt(r)} 0 Z`;
    }
    default:
      return null;
  }
}
