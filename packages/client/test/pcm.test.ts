import { describe, expect, it } from 'vitest';

import { applyFades, floatBlocksToInt16, int16ToFloat, resampleLinear, rmsDb } from '../src/core/pcm.js';

describe('pcm', () => {
  it('round-trips floats through int16', () => {
    const a = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]);
    const i16 = floatBlocksToInt16([a]);
    expect([...i16]).toEqual([0, 16383, -16384, 32767, -32768, 32767, -32768]);
    const back = int16ToFloat(i16);
    expect(back[1]).toBeCloseTo(0.5, 3);
    expect(back[4]).toBe(-1);
  });

  it('concatenates blocks', () => {
    expect(floatBlocksToInt16([new Float32Array([0.1]), new Float32Array([0.2, 0.3])]).length).toBe(3);
  });

  it('resamples to the right length and keeps a DC level', () => {
    const input = new Float32Array(4410).fill(0.25);
    const out = resampleLinear(input, 44100, 48000);
    expect(out.length).toBe(4800);
    expect(out[2400]).toBeCloseTo(0.25, 5);
    expect(resampleLinear(input, 48000, 48000)).toBe(input);
  });

  it('fades edges only', () => {
    const s = new Float32Array(1000).fill(1);
    applyFades(s, 48000, true, true, 8);
    expect(s[0]).toBe(0);
    expect(s[500]).toBe(1);
    expect(s[999]).toBe(0);
    expect(s[384]).toBe(1);
    expect(s[383]).toBeLessThan(1);
  });

  it('measures levels', () => {
    expect(rmsDb(new Float32Array(100))).toBeLessThan(-100);
    expect(rmsDb(new Float32Array(100).fill(1))).toBeCloseTo(0, 1);
    expect(rmsDb(new Float32Array(100).fill(0.1))).toBeCloseTo(-20, 1);
  });
});
