import { describe, expect, it } from 'vitest';

import { rgbaToI420 } from '../src/core/yuv.js';

function solid(width: number, height: number, r: number, g: number, b: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) out.set([r, g, b, 255], i * 4);
  return out;
}

describe('rgbaToI420', () => {
  it('maps white and black to the limited-range extremes with neutral chroma', () => {
    const white = rgbaToI420(solid(4, 2, 255, 255, 255), 4, 2);
    expect(white.data.length).toBe(4 * 2 + 2 * 2);
    expect([...white.data.subarray(0, 8)]).toEqual(Array<number>(8).fill(235));
    expect([...white.data.subarray(8)]).toEqual([128, 128, 128, 128]);
    const black = rgbaToI420(solid(4, 2, 0, 0, 0), 4, 2);
    expect([...black.data.subarray(0, 8)]).toEqual(Array<number>(8).fill(16));
    expect([...black.data.subarray(8)]).toEqual([128, 128, 128, 128]);
  });

  it('gives pure blue a high Cb and pure red a high Cr', () => {
    const blue = rgbaToI420(solid(2, 2, 0, 0, 255), 2, 2);
    expect(blue.data[0]).toBe(32); // 16 + 219 * 0.0722
    expect(blue.data[4]).toBe(240); // Cb
    expect(blue.data[5]).toBe(118); // Cr
    const red = rgbaToI420(solid(2, 2, 255, 0, 0), 2, 2);
    expect(red.data[0]).toBe(63);
    expect(red.data[4]).toBe(102);
    expect(red.data[5]).toBe(240);
  });

  it('averages 2×2 blocks for chroma and lays planes out contiguously', () => {
    const px = new Uint8ClampedArray(2 * 2 * 4);
    px.set([255, 0, 0, 255], 0); // red
    px.set([0, 0, 255, 255], 4); // blue
    px.set([0, 0, 0, 255], 8); // black
    px.set([255, 255, 255, 255], 12); // white
    const planes = rgbaToI420(px, 2, 2);
    expect(planes.layout).toEqual([
      { offset: 0, stride: 2 },
      { offset: 4, stride: 1 },
      { offset: 5, stride: 1 },
    ]);
    expect(planes.codedWidth).toBe(2);
    expect(planes.codedHeight).toBe(2);
    // the block averages to a mid grey with a slight blue-red balance: chroma near neutral
    expect(Math.abs((planes.data[4] ?? 0) - 128)).toBeLessThan(40);
    expect(Math.abs((planes.data[5] ?? 0) - 128)).toBeLessThan(40);
  });

  it('refuses odd sizes and short buffers', () => {
    expect(() => rgbaToI420(solid(3, 2, 0, 0, 0), 3, 2)).toThrow(/even/);
    expect(() => rgbaToI420(new Uint8ClampedArray(4), 2, 2)).toThrow(/too small/);
  });
});
