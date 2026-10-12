/** One second-order filter section (RBJ cookbook), direct form 1, run sample by sample. */
export class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  private constructor(
    private readonly b0: number,
    private readonly b1: number,
    private readonly b2: number,
    private readonly a1: number,
    private readonly a2: number,
  ) {}

  /** A low-pass; `cutoff` is a fraction of the sample rate. */
  static lowPass(cutoff: number, q: number): Biquad {
    const { cos, alpha, a0 } = poles(cutoff, q);
    const b0 = (1 - cos) / 2 / a0;
    return new Biquad(b0, (1 - cos) / a0, b0, (-2 * cos) / a0, (1 - alpha) / a0);
  }

  /** A high-pass; `cutoff` is a fraction of the sample rate. */
  static highPass(cutoff: number, q: number): Biquad {
    const { cos, alpha, a0 } = poles(cutoff, q);
    const b0 = (1 + cos) / 2 / a0;
    return new Biquad(b0, -(1 + cos) / a0, b0, (-2 * cos) / a0, (1 - alpha) / a0);
  }

  step(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** The two Q values that make a 4th-order Butterworth out of two sections. */
export const BUTTERWORTH_4 = [0.5412, 1.3066] as const;

function poles(cutoff: number, q: number): { cos: number; alpha: number; a0: number } {
  const w0 = 2 * Math.PI * cutoff;
  const alpha = Math.sin(w0) / (2 * q);
  return { cos: Math.cos(w0), alpha, a0: 1 + alpha };
}
