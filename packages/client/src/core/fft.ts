/**
 * A fast Fourier transform in plain code: radix-2, in place, on separate real and imaginary arrays.
 * Sizes are powers of two. The twiddle factors and the bit-reversed order are worked out once per
 * size and kept.
 */
interface Tables {
  cos: Float64Array;
  sin: Float64Array;
  rev: Uint32Array;
}

const tables = new Map<number, Tables>();

function tablesFor(n: number): Tables {
  const found = tables.get(n);
  if (found) return found;
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`FFT size must be a power of two, not ${n}`);
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / n);
    sin[k] = Math.sin((2 * Math.PI * k) / n);
  }
  const rev = new Uint32Array(n);
  const bits = Math.round(Math.log2(n));
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
    rev[i] = r;
  }
  const made = { cos, sin, rev };
  tables.set(n, made);
  return made;
}

/** Forward transform of the complex sequence (`re`, `im`), replaced in place by its spectrum. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (im.length !== n) throw new Error('FFT needs real and imaginary arrays of the same length');
  const { cos, sin, rev } = tablesFor(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i] ?? 0;
    if (j > i) {
      const tr = re[i] ?? 0;
      re[i] = re[j] ?? 0;
      re[j] = tr;
      const ti = im[i] ?? 0;
      im[i] = im[j] ?? 0;
      im[j] = ti;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0, w = 0; k < half; k++, w += step) {
        const wr = cos[w] ?? 0;
        const wi = -(sin[w] ?? 0);
        const a = start + k;
        const b = a + half;
        const br = re[b] ?? 0;
        const bi = im[b] ?? 0;
        const tr = br * wr - bi * wi;
        const ti = br * wi + bi * wr;
        const ar = re[a] ?? 0;
        const ai = im[a] ?? 0;
        re[b] = ar - tr;
        im[b] = ai - ti;
        re[a] = ar + tr;
        im[a] = ai + ti;
      }
    }
  }
}
