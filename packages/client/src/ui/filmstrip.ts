import { type Slide } from '../app/types.js';
import { fmtSec } from '../core/format.js';

import { clear, h } from './dom.js';

export class Filmstrip {
  private thumbs: HTMLElement[] = [];

  constructor(
    private readonly container: HTMLElement,
    private readonly info: HTMLElement,
    private readonly onSelect: (index: number) => void,
  ) {}

  render(slides: readonly Slide[]): void {
    clear(this.container);
    this.thumbs = slides.map((s, i) => {
      const el = h(
        'div',
        { class: 'thumb', dataset: { i: String(i) }, on: { click: () => this.onSelect(i) } },
        h('img', { src: s.thumbUrl, alt: `slide ${i + 1}` }),
        h('span', { class: 'n' }, String(i + 1)),
        h('span', { class: 't' }),
      );
      this.container.appendChild(el);
      return el;
    });
    if (slides.length === 0) {
      this.container.appendChild(
        h('div', { id: 'filmEmpty' }, 'Your slides appear here. Click one to jump to it.'),
      );
    }
    this.info.textContent = slides.length ? `${slides.length} slides` : '';
  }

  update(current: number, perSlide: readonly number[]): void {
    this.thumbs.forEach((el, i) => {
      el.classList.toggle('cur', i === current);
      const t = el.querySelector('.t');
      const sec = perSlide[i] ?? 0;
      if (t) {
        t.textContent = fmtSec(sec);
        t.classList.toggle('on', sec > 0);
      }
    });
    this.thumbs[current]?.scrollIntoView({ block: 'nearest' });
  }
}
