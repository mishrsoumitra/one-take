/**
 * The editor's switch for a clip's sound: Original, Cleaned, Only my voice, each with a ▶ to hear
 * it, a line saying what each one is right now (the live filter or the deep clean; made or not yet),
 * and a way to have the studio make the one that is missing. The choice goes on the clip and is
 * what the preview plays and the export uses.
 */
import { type StudioInfo } from '@one-take/shared';

import { fmtSec } from '../core/format.js';
import { segmentDuration, type Segment } from '../core/timeline.js';
import {
  audioOf,
  chosenVoicing,
  describeVersion,
  hasVersion,
  VOICING_LABELS,
  VOICINGS,
  type Voicing,
} from '../core/versions.js';

import { clear, h, replaceChildren } from './dom.js';
import { icon } from './icon.js';
import { type SnippetPlayer } from './snippet.js';

export interface VoicingDeps {
  snippet: SnippetPlayer;
  /** What the studio can do here, or null without the server. */
  studio: () => StudioInfo | null;
  /** Has the studio make a version of the clip; resolves once it is on the clip, rejects with why not. */
  make: (seg: Segment, kind: 'deep' | 'voice', onProgress: (message: string) => void) => Promise<void>;
  /** The user chose which version the clip plays. */
  onChoice: (seg: Segment, voicing: Voicing) => void;
}

export class VoicingSwitch {
  readonly el: HTMLElement;
  private readonly buttons = new Map<Voicing, { pick: HTMLButtonElement; play: HTMLButtonElement }>();
  private readonly note: HTMLElement;
  private readonly actions: HTMLElement;
  private seg: Segment | null = null;
  private playing: Voicing | null = null;
  /** The version being made right now, and the latest word on it. */
  private making: { kind: 'deep' | 'voice'; message: string } | null = null;

  constructor(private readonly deps: VoicingDeps) {
    const row = h('div', {
      class: 'picks',
      attrs: { role: 'radiogroup', 'aria-label': 'Which sound the clip plays' },
    });
    for (const voicing of VOICINGS) {
      const pick = h(
        'button',
        {
          class: 'pick',
          id: `edVoicing-${voicing}`,
          attrs: { role: 'radio', 'aria-checked': 'false' },
          on: { click: () => this.choose(voicing) },
        },
        VOICING_LABELS[voicing],
      );
      const play = h(
        'button',
        {
          class: 'icon xs play',
          id: `edVoicingPlay-${voicing}`,
          title: `Hear the clip as ${VOICING_LABELS[voicing].toLowerCase()}`,
          attrs: { 'aria-label': `Play ${VOICING_LABELS[voicing]}` },
          on: { click: () => void this.play(voicing) },
        },
        icon('play', 16),
      );
      this.buttons.set(voicing, { pick, play });
      row.appendChild(h('span', { class: `choice ${voicing}` }, pick, play));
    }
    this.note = h('div', { class: 'hint', id: 'edVoicingNote' });
    this.actions = h('div', { class: 'actions inline make', id: 'edVoicingActions' });
    this.el = h('div', { class: 'voicing', id: 'edVoicing' }, row, this.note, this.actions);
  }

  /** Shows the switch for a clip (or hides it for none). */
  render(seg: Segment | null): void {
    if (seg !== this.seg) this.stop();
    this.seg = seg;
    this.el.hidden = seg === null;
    if (!seg) return;
    const chosen = chosenVoicing(seg);
    for (const [voicing, b] of this.buttons) {
      const on = voicing === chosen;
      b.pick.setAttribute('aria-checked', String(on));
      b.pick.classList.toggle('on', on);
      b.pick.title = `${VOICING_LABELS[voicing]}: ${describeVersion(seg, voicing)}`;
      const has = hasVersion(seg, voicing);
      b.play.disabled = !has && voicing === 'voice';
      b.play.classList.toggle('on', this.playing === voicing);
    }
    this.renderNote(seg);
  }

  private renderNote(seg: Segment): void {
    const parts = [
      `Original: ${describeVersion(seg, 'original')}`,
      `Cleaned: ${describeVersion(seg, 'cleaned')}`,
      `Only my voice: ${describeVersion(seg, 'voice')}`,
    ];
    if (this.making) parts.push(this.making.message);
    this.note.textContent = parts.join(' · ');
    clear(this.actions);
    if (this.making) return;
    const studio = this.deps.studio();
    const seconds = segmentDuration(seg);
    const wants: { kind: 'deep' | 'voice'; label: string; can: boolean }[] = [];
    if (!seg.deep) wants.push({ kind: 'deep', label: 'Deep clean this clip', can: studio?.denoise ?? false });
    if (!seg.voice)
      wants.push({ kind: 'voice', label: 'Keep only my voice in this clip', can: studio?.voice ?? false });
    for (const want of wants) {
      const button = h(
        'button',
        {
          class: 'ghost',
          id: `edMake-${want.kind}`,
          disabled: !want.can,
          title: want.can
            ? `The studio runs ${want.kind === 'deep' ? 'the deep clean' : 'the voice extraction'} on this clip (${fmtSec(seconds)}); the result can be heard here and goes into the export`
            : (studio?.note ?? 'Needs the local server with the studio set up (npm run studio)'),
          on: { click: () => void this.make(seg, want.kind) },
        },
        icon(want.kind === 'deep' ? 'hearing' : 'mic', 16),
        h('span', { class: 'label' }, want.label),
      );
      this.actions.appendChild(button);
    }
    if (wants.length > 0 && !wants.some((w) => w.can)) {
      this.actions.appendChild(
        h(
          'span',
          { class: 'hint' },
          studio ? studio.note : 'Deep clean and only-my-voice need the local server with the studio set up.',
        ),
      );
    }
  }

  private choose(voicing: Voicing): void {
    const seg = this.seg;
    if (!seg || chosenVoicing(seg) === voicing) return;
    this.deps.onChoice(seg, voicing);
  }

  private async play(voicing: Voicing): Promise<void> {
    const seg = this.seg;
    if (!seg) return;
    if (this.playing === voicing) {
      this.stop();
      return;
    }
    this.stop();
    this.playing = voicing;
    this.render(seg);
    const audio = audioOf(seg, voicing);
    await this.deps.snippet.play(audio, seg.sampleRate, 0, audio.length / seg.sampleRate, () => {
      if (this.playing === voicing) {
        this.playing = null;
        if (this.seg === seg) this.render(seg);
      }
    });
  }

  /** Stops whatever version is playing. */
  stop(): void {
    if (this.playing === null) return;
    this.playing = null;
    this.deps.snippet.stop();
    if (this.seg) this.render(this.seg);
  }

  private async make(seg: Segment, kind: 'deep' | 'voice'): Promise<void> {
    if (this.making) return;
    this.making = { kind, message: kind === 'deep' ? 'Deep cleaning…' : 'Keeping your voice…' };
    this.render(seg);
    try {
      await this.deps.make(seg, kind, (message) => {
        if (this.making?.kind === kind) {
          this.making.message = message;
          if (this.seg) this.renderNote(this.seg);
        }
      });
    } catch (error) {
      replaceChildren(this.note, `Could not do it: ${(error as Error).message}`);
    } finally {
      this.making = null;
    }
    // the clip object changes when a version lands and the editor shows the new one; either way the note is redrawn
    if (this.seg) this.render(this.seg);
  }
}
