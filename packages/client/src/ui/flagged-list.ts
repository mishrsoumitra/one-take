/**
 * The flagged phrases in the export dialog: every phrase the checks marked as another voice, or as
 * not surely the speaker's, with a ▶ to hear it and a tick to keep it. An unticked phrase is left
 * out of the export. A ticked one goes in, and with the studio's voice option on, only the speaker's
 * voice is kept in it. The list is the same shape as the filler list, so it reads the same way.
 */
import { formatDuration } from '@one-take/shared';

import { fmtSec } from '../core/format.js';
import { verdictLabel } from '../core/identity.js';
import { segmentDuration, type Segment, type Timeline } from '../core/timeline.js';
import { audioOf, flagged } from '../core/versions.js';

import { h, replaceChildren } from './dom.js';
import { icon } from './icon.js';
import { type SnippetPlayer } from './snippet.js';

export interface FlaggedDeps {
  snippet: SnippetPlayer;
  /** A tick changed: the plan is to be refreshed. */
  onChange: () => void;
}

export interface FlaggedState {
  /** The voice option is on and the studio can do it: kept phrases get only the speaker's voice. */
  keepingVoice: boolean;
}

export class FlaggedList {
  readonly el: HTMLElement;
  /** Ids of flagged phrases the user unticked: left out of the export. */
  readonly dropped = new Set<string>();
  private readonly status: HTMLElement;
  private readonly list: HTMLElement;
  private playingId: string | null = null;

  constructor(private readonly deps: FlaggedDeps) {
    this.status = h('div', { class: 'hint', id: 'flaggedStatus' });
    this.list = h('div', { class: 'fillers flagged', id: 'flaggedList', hidden: true });
    this.el = h('div', { class: 'stack', id: 'flaggedBox' }, this.status, this.list);
  }

  /** The flagged phrases among `segments`, in timeline order. */
  static flaggedOf(segments: readonly Segment[], tl: Timeline): Segment[] {
    const order = new Map(tl.items.map((it, i) => [it.seg.id, i]));
    return segments.filter(flagged).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  render(segments: readonly Segment[], tl: Timeline, state: FlaggedState): void {
    const found = FlaggedList.flaggedOf(segments, tl);
    for (const id of this.dropped) if (!found.some((s) => s.id === id)) this.dropped.delete(id);
    if (found.length === 0) {
      this.status.textContent = segments.some((s) => s.speaker)
        ? 'Every phrase was your voice.'
        : 'No phrase was judged (the voice and lip checks were off).';
      this.list.hidden = true;
      replaceChildren(this.list);
      return;
    }
    const dropped = found.filter((s) => this.dropped.has(s.id)).length;
    const kept = found.length - dropped;
    const what = state.keepingVoice
      ? 'Ticked ones go in with only your voice kept; untick a phrase to leave it out.'
      : 'Ticked ones go in as they are; untick a phrase to leave it out.';
    this.status.textContent = `${found.length} phrase${found.length === 1 ? ' was' : 's were'} another voice or not surely yours${dropped ? ` (${kept} kept, ${dropped} left out)` : ''}. Listen to each. ${what}`;
    this.list.hidden = false;
    replaceChildren(this.list, ...found.map((seg) => this.row(seg, tl, state)));
  }

  private row(seg: Segment, tl: Timeline, state: FlaggedState): HTMLElement {
    const item = tl.items.find((it) => it.seg.id === seg.id);
    const who = seg.speaker;
    const tick = h('input', { type: 'checkbox', checked: !this.dropped.has(seg.id) });
    tick.onchange = () => {
      if (tick.checked) this.dropped.delete(seg.id);
      else this.dropped.add(seg.id);
      this.deps.onChange();
    };
    const play = h(
      'button',
      {
        class: `ghost icon xs${this.playingId === seg.id ? ' on' : ''}`,
        title: 'Hear the phrase',
        attrs: { 'aria-label': 'Play' },
      },
      icon('play', 16),
    );
    play.onclick = () => {
      if (this.playingId === seg.id) {
        this.stop();
        return;
      }
      this.stop();
      this.playingId = seg.id;
      play.classList.add('on');
      const audio = audioOf(seg);
      void this.deps.snippet.play(audio, seg.sampleRate, 0, audio.length / seg.sampleRate, () => {
        if (this.playingId === seg.id) this.playingId = null;
        play.classList.remove('on');
      });
    };
    const fate = this.dropped.has(seg.id)
      ? 'left out'
      : seg.voice
        ? 'your voice kept'
        : state.keepingVoice
          ? 'only your voice'
          : 'as it is';
    return h(
      'label',
      { class: `filler flag ${who?.verdict ?? ''}`, dataset: { id: seg.id } },
      tick,
      h('span', { class: 'when' }, formatDuration(item?.start ?? 0)),
      h(
        'span',
        { class: 'what', title: who ? who.reasons.join('; ') : '' },
        `${fmtSec(segmentDuration(seg))}, ${who ? verdictLabel(who.verdict).toLowerCase() : ''}: ${fate}`,
      ),
      play,
    );
  }

  stop(): void {
    if (this.playingId === null) return;
    this.playingId = null;
    this.deps.snippet.stop();
  }
}
