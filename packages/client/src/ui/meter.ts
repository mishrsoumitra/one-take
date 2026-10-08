export interface MeterInput {
  armed: boolean;
  muted: boolean;
  speaking: boolean;
  level: number;
  threshold: number;
  noise: number;
  settingThreshold: number;
}

/** The microphone level bar with the room-noise and speech-line markers. */
export class LevelMeter {
  private shown = -90;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly note: HTMLElement,
  ) {}

  draw(input: MeterInput): void {
    const c = this.canvas;
    const w = c.clientWidth || 300;
    if (c.width !== w) c.width = w;
    const h = c.height;
    const g = c.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, w, h);
    const x = (v: number) => ((Math.max(-70, Math.min(0, v)) + 70) / 70) * w;
    g.fillStyle = 'rgba(255,255,255,.07)';
    for (let d = -60; d < 0; d += 10) g.fillRect(x(d), 0, 1, h);
    const level = input.armed ? input.level : -90;
    this.shown = Math.max(level, this.shown - 1.2);
    const loud = input.armed && !input.muted && level > input.threshold;
    g.fillStyle = input.muted ? '#5a6070' : loud ? (input.speaking ? '#ff4b5c' : '#ffb020') : '#4f8cff';
    g.fillRect(0, 7, x(this.shown), h - 14);
    if (input.armed) {
      g.fillStyle = 'rgba(255,255,255,.3)';
      g.fillRect(x(input.noise), 0, 2, h);
    }
    g.fillStyle = '#fff';
    g.fillRect(x(input.armed ? input.threshold : input.settingThreshold) - 1, 0, 3, h);
    this.note.textContent = input.armed
      ? `speech line ${Math.round(input.threshold)} dB · room ${Math.round(input.noise)} dB`
      : 'Start the mic to see your level. Your voice should cross the white line.';
  }
}
