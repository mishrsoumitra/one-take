/**
 * Exposure and colour for the camera's picture, by arithmetic alone.
 *
 * A webcam in a lecture room is often a little dark, a little flat, and tinted by the lights. Three
 * readings of a frame say how much:
 *
 * 1. **Where the light sits.** The 2nd and 98th percentiles of the pixels' brightness say how much
 *    of the range the picture uses; stretching them to near black and near white gives the picture
 *    its contrast back, never by more than two to one, so noise in a dim frame is not blown up.
 * 2. **How bright it is overall.** The mean brightness after the stretch is brought towards a
 *    middle grey with a gamma curve (a power on the 0..1 scale), within limits, so a dark room is
 *    lifted without a bright one being crushed.
 * 3. **What colour the light is.** The grey-world assumption: over a whole frame the average
 *    colour is grey, so the red and blue channels are scaled to match the green one, within limits.
 *    A warm bulb or a blue window loses its cast; a deliberately coloured wall is only partly
 *    corrected, which is the price of having no reference.
 *
 * The three become one lookup table per channel (the gain first, then the curve), applied to
 * every pixel. The readings are followed
 * slowly from frame to frame so the picture never flickers as the speaker moves.
 *
 * Nothing in this file touches the browser; the tests run it in Node.
 */

export interface ToneMeasure {
  /** Mean brightness (0..1) over the sampled pixels. */
  mean: number;
  /** The 2nd and 98th percentiles of brightness. */
  low: number;
  high: number;
  /** Mean of each channel (0..1). */
  r: number;
  g: number;
  b: number;
}

export interface Correction {
  /** Channel gains, green held at 1. */
  gainR: number;
  gainB: number;
  /** Brightness mapped to black and to white before the gamma. */
  black: number;
  white: number;
  gamma: number;
}

export const NO_CORRECTION: Correction = { gainR: 1, gainB: 1, black: 0, white: 1, gamma: 1 };

/** Where the stretch sends the dark and bright percentiles. */
const TARGET_BLACK = 0.03;
const TARGET_WHITE = 0.97;
/** The stretch never makes the range more than this much wider. */
const MAX_STRETCH = 2;
/** Where the mean brightness is brought towards, and how far the gamma may go either way. */
const TARGET_MEAN = 0.45;
const GAMMA_MIN = 0.7;
const GAMMA_MAX = 1.4;
/** How far a colour channel may be scaled. */
const GAIN_MIN = 0.75;
const GAIN_MAX = 1.35;
/** How fast the correction follows a new reading: the share of the way it moves per frame. */
export const FOLLOW_RATE = 0.08;

/** Reads a frame's RGBA pixels, every `step`th one, for the three readings. */
export function measureTone(data: Uint8ClampedArray | Uint8Array, step = 4): ToneMeasure {
  const histogram = new Uint32Array(256);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i + 3 < data.length; i += 4 * step) {
    const pr = data[i] ?? 0;
    const pg = data[i + 1] ?? 0;
    const pb = data[i + 2] ?? 0;
    r += pr;
    g += pg;
    b += pb;
    const luma = Math.round(0.299 * pr + 0.587 * pg + 0.114 * pb);
    histogram[luma] = (histogram[luma] ?? 0) + 1;
    n++;
  }
  if (n === 0) return { mean: 0.5, low: 0, high: 1, r: 0.5, g: 0.5, b: 0.5 };
  const percentile = (p: number): number => {
    const target = p * n;
    let seen = 0;
    for (let v = 0; v < 256; v++) {
      seen += histogram[v] ?? 0;
      if (seen >= target) return v / 255;
    }
    return 1;
  };
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * (histogram[v] ?? 0);
  return {
    mean: sum / n / 255,
    low: percentile(0.02),
    high: percentile(0.98),
    r: r / n / 255,
    g: g / n / 255,
    b: b / n / 255,
  };
}

/** The correction the readings call for. */
export function planCorrection(
  m: ToneMeasure,
  options: { exposure?: boolean; colour?: boolean } = {},
): Correction {
  const exposure = options.exposure ?? true;
  const colour = options.colour ?? true;
  let black = 0;
  let white = 1;
  let gamma = 1;
  if (exposure) {
    const span = Math.max(0.05, m.high - m.low);
    const wanted = TARGET_WHITE - TARGET_BLACK;
    const stretch = Math.min(MAX_STRETCH, wanted / span);
    // black and white are the brightness levels sent to the targets, with the stretch limited
    const mid = (m.low + m.high) / 2;
    const halfWidth = wanted / stretch / 2;
    black = Math.max(0, mid - halfWidth - TARGET_BLACK / stretch);
    white = Math.min(1, mid + halfWidth + (1 - TARGET_WHITE) / stretch);
    const meanAfter = clamp01((m.mean - black) / Math.max(1e-3, white - black));
    // a gamma under 1 lifts the middle; the one that puts the mean on target is log(target)/log(mean)
    gamma = meanAfter > 0.01 && meanAfter < 0.99 ? Math.log(TARGET_MEAN) / Math.log(meanAfter) : 1;
    gamma = Math.max(GAMMA_MIN, Math.min(GAMMA_MAX, gamma));
  }
  let gainR = 1;
  let gainB = 1;
  if (colour && m.g > 0.02) {
    gainR = Math.max(GAIN_MIN, Math.min(GAIN_MAX, m.g / Math.max(0.02, m.r)));
    gainB = Math.max(GAIN_MIN, Math.min(GAIN_MAX, m.g / Math.max(0.02, m.b)));
  }
  return { gainR, gainB, black, white, gamma };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** The correction moved part of the way from `previous` towards `next`, so frames never flicker. */
export function followCorrection(
  previous: Correction | null,
  next: Correction,
  rate = FOLLOW_RATE,
): Correction {
  if (!previous) return next;
  const mix = (a: number, b: number) => a + (b - a) * rate;
  return {
    gainR: mix(previous.gainR, next.gainR),
    gainB: mix(previous.gainB, next.gainB),
    black: mix(previous.black, next.black),
    white: mix(previous.white, next.white),
    gamma: mix(previous.gamma, next.gamma),
  };
}

export interface Lut {
  r: Uint8Array;
  g: Uint8Array;
  b: Uint8Array;
}

/** One table of 256 entries per channel: the channel's gain, then the stretch and the gamma. */
export function buildLut(c: Correction): Lut {
  const span = Math.max(1e-3, c.white - c.black);
  const tone = (v: number): number => Math.pow(clamp01((v - c.black) / span), c.gamma);
  const channel = (gain: number): Uint8Array => {
    const out = new Uint8Array(256);
    for (let v = 0; v < 256; v++) out[v] = Math.round(tone(clamp01((v / 255) * gain)) * 255);
    return out;
  };
  return { r: channel(c.gainR), g: channel(1), b: channel(c.gainB) };
}

/** Applies the tables to RGBA pixels in place. */
export function applyLut(data: Uint8ClampedArray | Uint8Array, lut: Lut): void {
  for (let i = 0; i + 3 < data.length; i += 4) {
    data[i] = lut.r[data[i] ?? 0] ?? 0;
    data[i + 1] = lut.g[data[i + 1] ?? 0] ?? 0;
    data[i + 2] = lut.b[data[i + 2] ?? 0] ?? 0;
  }
}

/** Whether a correction changes anything worth the work. */
export function isIdentity(c: Correction): boolean {
  return (
    Math.abs(c.gainR - 1) < 0.01 &&
    Math.abs(c.gainB - 1) < 0.01 &&
    c.black < 0.005 &&
    c.white > 0.995 &&
    Math.abs(c.gamma - 1) < 0.01
  );
}
