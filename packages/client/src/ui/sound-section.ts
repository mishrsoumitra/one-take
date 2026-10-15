/**
 * The Sound section of the export dialog: the studio's three switches with what each costs, a line
 * on what the studio can do here, and the flagged phrases list. Built on its own so the dialog
 * only places it and hands it the state on every refresh.
 */
import { formatEta, type Enhance, type StudioInfo } from '@one-take/shared';

import { type Segment, type Timeline } from '../core/timeline.js';
import { planStudio, studioEstimate, type StudioPlan } from '../export/studio.js';

import { h } from './dom.js';
import { FlaggedList } from './flagged-list.js';
import { type SnippetPlayer } from './snippet.js';

export interface SoundSectionDeps {
  snippet: SnippetPlayer;
  /** A switch or a tick changed. */
  onChange: (mutate: (studio: Enhance['studio']) => void) => void;
}

export interface SoundState {
  settings: Enhance['studio'];
  info: StudioInfo | null;
  /** The server answers at all. */
  server: boolean;
  segments: readonly Segment[];
  timeline: Timeline;
  /** A voice profile is enrolled, so a voice can be picked without a face. */
  profile: boolean;
}

function check(input: HTMLInputElement, text: string, note: HTMLElement): HTMLElement {
  return h('label', { class: 'check' }, input, h('span', null, text, note));
}

export class SoundSection {
  readonly el: HTMLElement;
  readonly flagged: FlaggedList;
  /** The plan of the last refresh: which clips get what. */
  plan: StudioPlan = { clips: [], denoiseSec: 0, voiceSec: 0 };
  private readonly denoise: HTMLInputElement;
  private readonly voice: HTMLInputElement;
  private readonly overlap: HTMLInputElement;
  private readonly denoiseNote: HTMLElement;
  private readonly voiceNote: HTMLElement;
  private readonly overlapNote: HTMLElement;
  private readonly note: HTMLElement;

  constructor(deps: SoundSectionDeps) {
    this.denoise = h('input', { type: 'checkbox', id: 'studioDenoise' });
    this.denoise.onchange = () =>
      deps.onChange((s) => {
        s.denoise = this.denoise.checked;
      });
    this.voice = h('input', { type: 'checkbox', id: 'studioVoice' });
    this.voice.onchange = () =>
      deps.onChange((s) => {
        s.voice = this.voice.checked;
      });
    this.overlap = h('input', { type: 'checkbox', id: 'studioOverlap' });
    this.overlap.onchange = () =>
      deps.onChange((s) => {
        s.findOverlap = this.overlap.checked;
      });
    this.denoiseNote = h('span', { class: 'hint', id: 'studioDenoiseNote' });
    this.voiceNote = h('span', { class: 'hint', id: 'studioVoiceNote' });
    this.overlapNote = h('span', { class: 'hint', id: 'studioOverlapNote' });
    this.note = h('div', { class: 'hint', id: 'studioNote' });
    this.flagged = new FlaggedList({ snippet: deps.snippet, onChange: () => deps.onChange(() => undefined) });
    this.el = h(
      'div',
      { class: 'stack', id: 'soundSection' },
      h(
        'div',
        { class: 'stack checks' },
        check(this.denoise, 'deep clean the sound from the raw microphone ', this.denoiseNote),
        check(this.voice, 'keep only your voice where another voice was heard ', this.voiceNote),
        check(this.overlap, 'check every phrase for a second voice ', this.overlapNote),
      ),
      this.note,
      h('div', { class: 'sub' }, h('b', { class: 'subtitle' }, 'Flagged phrases'), this.flagged.el),
    );
  }

  /** Whether the studio would do anything for this export. */
  get active(): boolean {
    return this.plan.clips.length > 0;
  }

  refresh(state: SoundState): void {
    const { settings, info } = state;
    const canDenoise = info?.denoise ?? false;
    const canVoice = info?.voice ?? false;
    this.denoise.checked = settings.denoise;
    this.voice.checked = settings.voice;
    this.overlap.checked = settings.findOverlap;
    this.denoise.disabled = !canDenoise;
    this.voice.disabled = !canVoice;
    this.overlap.disabled = !canVoice;
    this.plan = planStudio(state.segments, { settings, info, dropped: this.flagged.dropped });
    const estimate = studioEstimate(this.plan, info);
    const flaggedCount = FlaggedList.flaggedOf(state.segments, state.timeline).filter(
      (s) => !this.flagged.dropped.has(s.id),
    ).length;
    const films = state.segments.filter((s) => s.faces && s.faces.frames > 0).length;
    this.denoiseNote.textContent = !canDenoise
      ? ''
      : settings.denoise && estimate.denoiseSec !== null
        ? `(MossFormer2 over the whole recording, about ${formatEta(estimate.denoiseSec)} on the ${deviceWord(info)})`
        : settings.denoise
          ? '(every phrase is cleaned already)'
          : '(MossFormer2 over the whole recording; a wait you can skip)';
    this.voiceNote.textContent = !canVoice
      ? ''
      : flaggedCount === 0 && !state.segments.some((s) => s.choice === 'voice')
        ? '(no phrase needs it right now)'
        : settings.voice && estimate.voiceSec !== null
          ? `(${flaggedCount} phrase${flaggedCount === 1 ? '' : 's'}, by the camera where it saw you${films === 0 && !state.profile ? ', else by level' : films === 0 ? ', else by your voice profile' : ''}, about ${formatEta(estimate.voiceSec)})`
          : settings.voice
            ? '(done already)'
            : `(${flaggedCount} phrase${flaggedCount === 1 ? '' : 's'})`;
    this.overlapNote.textContent = !canVoice
      ? ''
      : settings.findOverlap
        ? `(slow: the separation model over every phrase, about ${formatEta(Math.round(4 + state.timeline.total * 0.35))}; a phrase with two voices is then flagged)`
        : '(slow; off unless you want every phrase gone over)';
    this.note.textContent = !state.server
      ? 'The studio needs the local server (npm start) with the studio set up (npm run studio).'
      : !info
        ? 'The studio is switched off on this server.'
        : info.note;
    this.flagged.render(state.segments, state.timeline, { keepingVoice: settings.voice && canVoice });
  }

  stop(): void {
    this.flagged.stop();
  }
}

function deviceWord(info: StudioInfo | null): string {
  return info?.device === 'mps' || info?.device === 'cuda' ? 'GPU' : 'CPU';
}
