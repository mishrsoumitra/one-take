export interface MeterInput {
  armed: boolean;
  muted: boolean;
  speaking: boolean;
  level: number;
  threshold: number;
  noise: number;
  settingThreshold: number;
}

/** The colours the canvas draws with; set on #meter in the stylesheet from grauity's tokens. */
const COLOUR_PROPS = {
  tick: '--meter-tick',
  noise: '--meter-noise',
  line: '--meter-line',
  idle: '--meter-idle',
  loud: '--meter-loud',
  speaking: '--meter-speaking',
  muted: '--meter-muted',
} as const;
const FALLBACK: Record<keyof typeof COLOUR_PROPS, string> = {
  tick: 'rgba(255,255,255,.12)',
  noise: 'rgba(255,255,255,.2)',
  line: '#fff',
  idle: '#0673f9',
  loud: '#feb000',
  speaking: '#d22d3a',
  muted: '#5b6271',
};

/** The microphone level bar with the room-noise and speech-line markers. */
export class LevelMeter {
  private shown = -90;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly note: HTMLElement,
  ) {}

  private colours(): Record<keyof typeof COLOUR_PROPS, string> {
    const style = getComputedStyle(this.canvas);
    const out = { ...FALLBACK };
    for (const key of Object.keys(COLOUR_PROPS) as (keyof typeof COLOUR_PROPS)[]) {
      const value = style.getPropertyValue(COLOUR_PROPS[key]).trim();
      if (value) out[key] = value;
    }
    return out;
  }

  draw(input: MeterInput): void {
    const c = this.canvas;
    const w = c.clientWidth || 300;
    if (c.width !== w) c.width = w;
    const h = c.height;
    const g = c.getContext('2d');
    if (!g) return;
    const colour = this.colours();
    g.clearRect(0, 0, w, h);
    const x = (v: number) => ((Math.max(-70, Math.min(0, v)) + 70) / 70) * w;
    g.fillStyle = colour.tick;
    for (let d = -60; d < 0; d += 10) g.fillRect(x(d), 0, 1, h);
    const level = input.armed ? input.level : -90;
    this.shown = Math.max(level, this.shown - 1.2);
    const loud = input.armed && !input.muted && level > input.threshold;
    g.fillStyle = input.muted
      ? colour.muted
      : loud
        ? input.speaking
          ? colour.speaking
          : colour.loud
        : colour.idle;
    g.fillRect(0, 7, x(this.shown), h - 14);
    if (input.armed) {
      g.fillStyle = colour.noise;
      g.fillRect(x(input.noise), 0, 2, h);
    }
    g.fillStyle = colour.line;
    g.fillRect(x(input.armed ? input.threshold : input.settingThreshold) - 1, 0, 3, h);
    this.note.textContent = input.armed
      ? `speech line ${Math.round(input.threshold)} dB · room ${Math.round(input.noise)} dB`
      : 'Start the mic to see your level. Your voice should cross the white line.';
  }
}
