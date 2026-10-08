import { type Slide } from '../app/types.js';
import { fmtSec } from '../core/format.js';

import { clear, h } from './dom.js';

/**
 * The slide filmstrip: one column of slide previews, each with its number in a gutter on the left,
 * like the thumbnail pane in Google Slides. The current slide is ringed; the gutter also shows how
 * much speech is recorded on a slide.
 */
export class Filmstrip {
  private rows: HTMLElement[] = [];
  private current = -1;

  constructor(
    private readonly container: HTMLElement,
    private readonly info: HTMLElement,
    private readonly onSelect: (index: number) => void,
  ) {}

  render(slides: readonly Slide[]): void {
    clear(this.container);
    this.current = -1;
    this.rows = slides.map((s, i) => {
      const select = () => this.onSelect(i);
      const row = h(
        'div',
        {
          class: 'fs-slide',
          title: `Slide ${i + 1}`,
          dataset: { i: String(i) },
          attrs: { role: 'button', tabindex: '0', 'aria-label': `Slide ${i + 1}` },
          on: {
            click: select,
            keydown: (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                select();
              }
            },
          },
        },
        h('div', { class: 'gutter' }, h('span', { class: 'n' }, String(i + 1)), h('span', { class: 't' })),
        h(
          'div',
          { class: 'card', style: `aspect-ratio: ${s.width} / ${s.height}` },
          h('img', { src: s.thumbUrl, alt: '', attrs: { draggable: 'false', loading: 'lazy' } }),
        ),
      );
      this.container.appendChild(row);
      return row;
    });
    if (slides.length === 0) {
      this.container.appendChild(
        h(
          'div',
          { class: 'fs-slide ghost', id: 'filmEmpty' },
          h('div', { class: 'gutter' }, h('span', { class: 'n' }, '1')),
          h('div', { class: 'card' }, h('span', null, 'Your slides appear here. Click one to jump to it.')),
        ),
      );
    }
    this.info.textContent = slides.length ? String(slides.length) : '';
  }

  update(current: number, perSlide: readonly number[]): void {
    this.rows.forEach((row, i) => {
      const isCurrent = i === current;
      row.classList.toggle('cur', isCurrent);
      if (isCurrent) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
      const t = row.querySelector('.t');
      const sec = perSlide[i] ?? 0;
      if (t) {
        t.textContent = sec > 0 ? fmtSec(sec) : '';
        t.classList.toggle('on', sec > 0);
      }
    });
    if (current !== this.current) {
      this.current = current;
      // keep the current slide in view, like the thumbnail pane follows the slide you are on
      this.rows[current]?.scrollIntoView({ block: 'nearest' });
    }
  }
}
