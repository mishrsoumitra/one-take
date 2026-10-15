import { type Slide } from '../app/types.js';
import { fmtSec, fmtTime } from '../core/format.js';
import { verdictLabel } from '../core/identity.js';
import { segmentDuration, totalDuration, type Segment } from '../core/timeline.js';

import { clear, h } from './dom.js';
import { icon } from './icon.js';

export interface TimelineListHandlers {
  onPlay: (index: number) => void;
  onDelete: (index: number) => void;
  onSelect: (index: number) => void;
  onMove: (from: number, to: number) => void;
}

/** The list of recorded phrases in playback order, with play, delete and drag-to-reorder. */
export class TimelineList {
  private rows: HTMLElement[] = [];
  private dragFrom: number | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly info: HTMLElement,
    private readonly handlers: TimelineListHandlers,
  ) {}

  render(segments: readonly Segment[], slides: readonly Slide[], scrollToEnd: boolean): void {
    const keep = this.container.scrollTop;
    clear(this.container);
    this.rows = [];
    if (segments.length === 0) {
      this.container.appendChild(
        h(
          'div',
          { id: 'segEmpty' },
          'Nothing recorded yet. Each phrase you say appears here, in the order it will play. Drag to reorder, ▶ to play from there, ✕ to delete.',
        ),
      );
      this.info.textContent = '';
      return;
    }
    const frag = document.createDocumentFragment();
    segments.forEach((seg, i) => {
      const slide = slides[seg.slide];
      // whose voice the checks said it was: a badge when it is not the speaker's, the reasons on hover
      const who = seg.speaker;
      const reasons = who ? `${verdictLabel(who.verdict)}: ${who.reasons.join(', ').toLowerCase()}` : '';
      const badge =
        who && who.verdict !== 'you'
          ? h('span', { class: `who ${who.verdict}`, title: reasons }, verdictLabel(who.verdict))
          : null;
      const row = h(
        'div',
        {
          class: `seg${who?.verdict === 'other' ? ' other' : ''}`,
          draggable: true,
          title: who?.verdict === 'you' ? reasons : undefined,
          dataset: { i: String(i) },
          on: {
            click: () => this.handlers.onSelect(i),
            dragstart: (e) => {
              this.dragFrom = i;
              if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
            },
            dragover: (e) => {
              e.preventDefault();
              row.classList.add('dragover');
            },
            dragleave: () => row.classList.remove('dragover'),
            drop: (e) => {
              e.preventDefault();
              row.classList.remove('dragover');
              if (this.dragFrom !== null && this.dragFrom !== i) this.handlers.onMove(this.dragFrom, i);
              this.dragFrom = null;
            },
          },
        },
        h('span', { class: 'i' }, String(i + 1)),
        h('img', { src: slide?.thumbUrl ?? '', alt: '' }),
        h(
          'div',
          { class: 'meta' },
          h('b', null, `Slide ${seg.slide + 1}`),
          h(
            'small',
            { class: seg.joined ? 'join' : '' },
            `${fmtSec(segmentDuration(seg))}${seg.joined ? ' · continues' : ''}`,
          ),
          badge,
        ),
        h(
          'button',
          {
            class: 'icon xs play',
            title: 'Play from here',
            attrs: { 'aria-label': `Play from phrase ${i + 1}` },
            on: {
              click: (e) => {
                e.stopPropagation();
                this.handlers.onPlay(i);
              },
            },
          },
          icon('play', 16),
        ),
        h(
          'button',
          {
            class: 'icon xs del',
            title: 'Delete this phrase',
            attrs: { 'aria-label': `Delete phrase ${i + 1}` },
            on: {
              click: (e) => {
                e.stopPropagation();
                this.handlers.onDelete(i);
              },
            },
          },
          icon('close', 16),
        ),
      );
      this.rows.push(row);
      frag.appendChild(row);
    });
    this.container.appendChild(frag);
    this.container.scrollTop = scrollToEnd ? this.container.scrollHeight : keep;
    this.info.textContent = `${segments.length} · ${fmtTime(totalDuration(segments))}`;
  }

  setPlaying(index: number | null): void {
    this.rows.forEach((row, i) => row.classList.toggle('playing', i === index));
  }
}
