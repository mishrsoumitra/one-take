/**
 * RGBA to planar I420 (BT.709, limited range), done once per slide in plain JavaScript.
 *
 * Why: a frame captured from a canvas stays RGBA on the GPU and the browser converts it again for every
 * `encode()` call, which capped every WebCodecs encoder at about 370 fps for 1080p on an M2 Max. A
 * planar frame built from this buffer is cloned per video frame without any conversion, and Chrome's
 * software H.264 encoder then reaches about 700 fps. Chrome refuses `VideoFrame.copyTo` with a format
 * change, so the conversion lives here (about 30 ms for 1080p).
 */

export interface I420Planes {
  data: Uint8Array;
  layout: { offset: number; stride: number }[];
  codedWidth: number;
  codedHeight: number;
}

export const BT709_LIMITED: VideoColorSpaceInit = {
  primaries: 'bt709',
  transfer: 'bt709',
  matrix: 'bt709',
  fullRange: false,
};

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Converts `width × height` RGBA pixels (even dimensions) to I420 planes in one buffer. */
export function rgbaToI420(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): I420Planes {
  if (width % 2 !== 0 || height % 2 !== 0) throw new Error('I420 needs even dimensions');
  if (rgba.length < width * height * 4) throw new Error('RGBA buffer is too small');
  const cw = width >> 1;
  const ch = height >> 1;
  const ySize = width * height;
  const cSize = cw * ch;
  const data = new Uint8Array(ySize + 2 * cSize);
  const uOffset = ySize;
  const vOffset = ySize + cSize;
  // Luma: Y = 16 + 219 * (0.2126 R + 0.7152 G + 0.0722 B) / 255
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = (row + x) * 4;
      const r = rgba[i] ?? 0;
      const g = rgba[i + 1] ?? 0;
      const b = rgba[i + 2] ?? 0;
      data[row + x] = clamp8(Math.round(16 + ((0.2126 * r + 0.7152 * g + 0.0722 * b) * 219) / 255));
    }
  }
  // Chroma from the average of each 2×2 block: Cb = 128 + 224 * (-0.1146 R - 0.3854 G + 0.5 B) / 255,
  // Cr = 128 + 224 * (0.5 R - 0.4542 G - 0.0458 B) / 255
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const i = ((2 * y + dy) * width + 2 * x + dx) * 4;
          r += rgba[i] ?? 0;
          g += rgba[i + 1] ?? 0;
          b += rgba[i + 2] ?? 0;
        }
      }
      r /= 4;
      g /= 4;
      b /= 4;
      const k = y * cw + x;
      data[uOffset + k] = clamp8(Math.round(128 + ((-0.1146 * r - 0.3854 * g + 0.5 * b) * 224) / 255));
      data[vOffset + k] = clamp8(Math.round(128 + ((0.5 * r - 0.4542 * g - 0.0458 * b) * 224) / 255));
    }
  }
  return {
    data,
    layout: [
      { offset: 0, stride: width },
      { offset: uOffset, stride: cw },
      { offset: vOffset, stride: cw },
    ],
    codedWidth: width,
    codedHeight: height,
  };
}
