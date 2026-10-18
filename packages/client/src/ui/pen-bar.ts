/**
 * The pen's toolbar on the stage: the tool (pen or highlighter), the colour, the width, taking back
 * the last stroke and clearing the slide. Shown in the "voice + camera + pen" mode.
 */
import { PEN_COLORS, PEN_WIDTHS, type InkTool, type PenSettings } from '../core/ink.js';

import { h } from './dom.js';
import { icon } from './icon.js';

export interface PenBarDeps {
  /** The stage the toolbar floats on. */
  stage: HTMLElement;
  pen: () => PenSettings;
  onPen: (pen: PenSettings) => void;
  /** Take back the last stroke of the drawing being made. */
  onUndo: () => void;
  /** Clear the slide: everything drawn on it so far goes, as a step in the video. */
  onClear: () => void;
}

export interface PenBarState {
  /** A drawing is being made right now: strokes can be taken back. */
  canUndo: boolean;
  /** Something is on the slide: it can be cleared. */
  canClear: boolean;
  /** Drawing is possible (the mic is on). */
  enabled: boolean;
}

const TOOLS: readonly { tool: InkTool; label: string; title: string }[] = [
  { tool: 'pen', label: 'Pen', title: 'Pen: a solid line' },
  { tool: 'highlighter', label: 'Highlighter', title: 'Highlighter: a wide, translucent mark' },
];

export class PenBar {
  readonly el: HTMLElement;
  private readonly tools = new Map<InkTool, HTMLButtonElement>();
  private readonly colors = new Map<string, HTMLButtonElement>();
  private readonly widths = new Map<number, HTMLButtonElement>();
  private readonly btnUndo: HTMLButtonElement;
  private readonly btnClear: HTMLButtonElement;
  private readonly note: HTMLElement;

  constructor(private readonly deps: PenBarDeps) {
    const toolGroup = h('div', { class: 'group', attrs: { role: 'radiogroup', 'aria-label': 'Tool' } });
    for (const t of TOOLS) {
      const b = h(
        'button',
        {
          class: `tool ${t.tool}`,
          id: `pen-${t.tool}`,
          title: t.title,
          attrs: { role: 'radio', 'aria-checked': 'false', 'aria-label': t.label },
        },
        t.tool === 'pen' ? icon('pen', 16) : h('i', { class: 'marker', attrs: { 'aria-hidden': 'true' } }),
      );
      b.onclick = () => {
        this.deps.onPen({ ...this.deps.pen(), tool: t.tool });
        b.blur();
      };
      this.tools.set(t.tool, b);
      toolGroup.appendChild(b);
    }
    const colorGroup = h('div', { class: 'group', attrs: { role: 'radiogroup', 'aria-label': 'Colour' } });
    for (const c of PEN_COLORS) {
      const b = h('button', {
        class: 'swatch',
        id: `pen-color-${c.value.slice(1)}`,
        title: c.label,
        style: `--swatch: ${c.value}`,
        attrs: { role: 'radio', 'aria-checked': 'false', 'aria-label': c.label },
      });
      b.onclick = () => {
        this.deps.onPen({ ...this.deps.pen(), color: c.value });
        b.blur();
      };
      this.colors.set(c.value, b);
      colorGroup.appendChild(b);
    }
    const widthGroup = h('div', { class: 'group', attrs: { role: 'radiogroup', 'aria-label': 'Width' } });
    for (const w of PEN_WIDTHS) {
      const b = h(
        'button',
        {
          class: 'width',
          id: `pen-width-${w.label.toLowerCase()}`,
          title: w.label,
          attrs: { role: 'radio', 'aria-checked': 'false', 'aria-label': w.label },
        },
        h('i', {
          style: `--dot: ${Math.round(4 + (w.value / 0.01) * 10)}px`,
          attrs: { 'aria-hidden': 'true' },
        }),
      );
      b.onclick = () => {
        this.deps.onPen({ ...this.deps.pen(), width: w.value });
        b.blur();
      };
      this.widths.set(w.value, b);
      widthGroup.appendChild(b);
    }
    this.btnUndo = h(
      'button',
      {
        class: 'act',
        id: 'penUndo',
        title: 'Take back the last stroke (⌘Z while drawing)',
        attrs: { 'aria-label': 'Undo stroke' },
      },
      icon('reply', 16),
    );
    this.btnUndo.onclick = () => {
      this.deps.onUndo();
      this.btnUndo.blur();
    };
    this.btnClear = h(
      'button',
      {
        class: 'act',
        id: 'penClear',
        title: 'Clear the slide: everything drawn on it goes, as a step in the video',
        attrs: { 'aria-label': 'Clear the slide' },
      },
      icon('bin', 16),
    );
    this.btnClear.onclick = () => {
      this.deps.onClear();
      this.btnClear.blur();
    };
    this.note = h('span', { class: 'note', id: 'penNote' });
    this.el = h(
      'div',
      { id: 'penBar', hidden: true, attrs: { role: 'toolbar', 'aria-label': 'Pen' } },
      toolGroup,
      colorGroup,
      widthGroup,
      h('div', { class: 'group' }, this.btnUndo, this.btnClear),
      this.note,
    );
    deps.stage.appendChild(this.el);
    this.render({ canUndo: false, canClear: false, enabled: false });
  }

  /** Shows the toolbar (in the pen mode, with slides loaded) or hides it. */
  show(on: boolean): void {
    this.el.hidden = !on;
  }

  /** Marks the chosen tool, colour and width, and enables what can be done right now. */
  render(state: PenBarState): void {
    const pen = this.deps.pen();
    for (const [tool, b] of this.tools) b.setAttribute('aria-checked', String(tool === pen.tool));
    for (const [color, b] of this.colors) b.setAttribute('aria-checked', String(color === pen.color));
    for (const [width, b] of this.widths) {
      b.setAttribute('aria-checked', String(Math.abs(width - pen.width) < 1e-6));
    }
    for (const b of [...this.tools.values(), ...this.colors.values(), ...this.widths.values()]) {
      b.style.setProperty('--pen', pen.color);
    }
    this.btnUndo.disabled = !state.canUndo;
    this.btnClear.disabled = !state.canClear || !state.enabled;
    this.el.classList.toggle('off', !state.enabled);
    this.note.textContent = state.enabled ? 'Draw on the slide' : 'Start mic to draw';
  }
}
