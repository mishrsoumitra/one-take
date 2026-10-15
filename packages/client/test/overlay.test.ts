import { describe, expect, it } from 'vitest';

import {
  CAMERA_MARGIN,
  CAMERA_SIZE_MAX,
  CAMERA_SIZE_MIN,
  cornerOf,
  DEFAULT_CAMERA_LAYOUT,
  describeLayout,
  layoutAt,
  normalizeLayout,
  overlayRect,
  sizeForWidth,
  snapToCorner,
} from '../src/core/overlay.js';

const area = { x: 100, y: 50, width: 1600, height: 900 };

describe('overlayRect', () => {
  it('puts a 16:9 picture of the asked width in each corner, a margin in from the edge', () => {
    const margin = CAMERA_MARGIN * 1600;
    const br = overlayRect({ x: 1, y: 1, size: 0.25 }, area, 16 / 9);
    expect(br.width).toBeCloseTo(400);
    expect(br.height).toBeCloseTo(225);
    expect(br.x + br.width).toBeCloseTo(100 + 1600 - margin);
    expect(br.y + br.height).toBeCloseTo(50 + 900 - margin);
    const tl = overlayRect({ x: 0, y: 0, size: 0.25 }, area, 16 / 9);
    expect(tl.x).toBeCloseTo(100 + margin);
    expect(tl.y).toBeCloseTo(50 + margin);
    const mid = overlayRect({ x: 0.5, y: 0.5, size: 0.25 }, area, 16 / 9);
    expect(mid.x + mid.width / 2).toBeCloseTo(100 + 800);
    expect(mid.y + mid.height / 2).toBeCloseTo(50 + 450);
  });

  it('follows the camera aspect and never grows taller than the slide allows', () => {
    const square = overlayRect({ x: 1, y: 1, size: 0.25 }, area, 1);
    expect(square.width).toBeCloseTo(400);
    expect(square.height).toBeCloseTo(400);
    // a tall camera at the largest size on a wide slide is held down to the slide's height
    const tall = overlayRect(
      { x: 1, y: 1, size: CAMERA_SIZE_MAX },
      { x: 0, y: 0, width: 1600, height: 500 },
      9 / 16,
    );
    expect(tall.height).toBeLessThanOrEqual(500 * 0.9 + 1e-6);
    expect(tall.width / tall.height).toBeCloseTo(9 / 16);
  });

  it('clamps sizes and positions it is given', () => {
    const tiny = overlayRect({ x: 2, y: -1, size: 0.01 }, area, 16 / 9);
    expect(tiny.width).toBeCloseTo(CAMERA_SIZE_MIN * 1600);
    expect(tiny.x + tiny.width).toBeCloseTo(1700 - CAMERA_MARGIN * 1600);
    expect(tiny.y).toBeCloseTo(50 + CAMERA_MARGIN * 1600);
  });
});

describe('layoutAt', () => {
  it('is the inverse of overlayRect for the picture’s top-left corner', () => {
    for (const layout of [
      { x: 0, y: 0, size: 0.3 },
      { x: 1, y: 1, size: 0.2 },
      { x: 0.3, y: 0.7, size: 0.4 },
    ]) {
      const box = overlayRect(layout, area, 16 / 9);
      const back = layoutAt(layout, area, 16 / 9, box.x, box.y);
      expect(back.x).toBeCloseTo(layout.x);
      expect(back.y).toBeCloseTo(layout.y);
      expect(back.size).toBe(layout.size);
    }
  });

  it('keeps a dragged picture on the slide', () => {
    const off = layoutAt({ x: 0.5, y: 0.5, size: 0.3 }, area, 16 / 9, -500, 5000);
    expect(off.x).toBe(0);
    expect(off.y).toBe(1);
  });
});

describe('corners, snapping and sizes', () => {
  it('names the corner a layout sits in', () => {
    expect(cornerOf(DEFAULT_CAMERA_LAYOUT)).toBe('bottom-right');
    expect(cornerOf({ x: 0.01, y: 0.99, size: 0.2 })).toBe('bottom-left');
    expect(cornerOf({ x: 0.5, y: 0, size: 0.2 })).toBeNull();
    expect(describeLayout({ x: 1, y: 0, size: 0.333 })).toBe(
      'Top right · 33 % of the slide’s width'.replace('’', "'"),
    );
    expect(describeLayout({ x: 0.5, y: 0.5, size: 0.2 })).toContain('Where you dragged it');
  });

  it('snaps to a corner only when close to one', () => {
    expect(snapToCorner({ x: 0.03, y: 0.97, size: 0.2 })).toEqual({ x: 0, y: 1, size: 0.2 });
    expect(snapToCorner({ x: 0.2, y: 0.5, size: 0.2 })).toEqual({ x: 0.2, y: 0.5, size: 0.2 });
  });

  it('turns a dragged width back into a size, within the limits', () => {
    expect(sizeForWidth(400, area)).toBeCloseTo(0.25);
    expect(sizeForWidth(10, area)).toBe(CAMERA_SIZE_MIN);
    expect(sizeForWidth(1600, area)).toBe(CAMERA_SIZE_MAX);
  });

  it('reads a stored layout back safely', () => {
    expect(normalizeLayout(null)).toEqual(DEFAULT_CAMERA_LAYOUT);
    expect(normalizeLayout({ x: 'left', y: 7, size: 9 })).toEqual({
      x: DEFAULT_CAMERA_LAYOUT.x,
      y: 1,
      size: CAMERA_SIZE_MAX,
    });
    expect(normalizeLayout({ x: 0.25, y: 0.5, size: 0.3 })).toEqual({ x: 0.25, y: 0.5, size: 0.3 });
  });
});
