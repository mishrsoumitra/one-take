/**
 * The voice enrollment: the speaker reads a short passage out loud for twenty seconds, and the
 * voice heard in it becomes the profile the voice check compares every phrase with
 * (`core/speaker.ts`). Opens by itself the first time the mic is started with the voice check on
 * and no profile yet, and from the "Learn my voice" button after that.
 */
import { ENROLL_MIN_VOICE_SEC, ENROLL_SEC, type VoiceProfile } from '../core/speaker.js';

import { h } from './dom.js';
import { icon } from './icon.js';

/** What the enrollment listened to: the stretches with a voice in them, at the mic's rate. */
export interface EnrollClip {
  samples: Float32Array;
  rate: number;
}

export interface EnrollDeps {
  /**
   * Listens for {@link ENROLL_SEC} seconds and resolves with the voice heard; `onTick` reports the
   * seconds of voice heard so far and the seconds elapsed. Resolves null when `signal` aborts first.
   */
  listen: (
    onTick: (voiceSec: number, elapsedSec: number) => void,
    signal: AbortSignal,
  ) => Promise<EnrollClip | null>;
  /** Turns the clip into a profile; null when there was too little voice in it for one. */
  enroll: (clip: EnrollClip) => Promise<VoiceProfile | null>;
}

/** What the speaker reads: a few plain lines, about twenty seconds at a lecture pace. */
const PASSAGE =
  "Okay, let's start with something that you already know. Write your answer below, then check every step one by one. " +
  'In the examination hall there are no books, no cues and no help whatsoever, so you have to remember it on your own. ' +
  'Maybe it was last night, last month, or the last class you attended. All of you have faced this at some point in time. ' +
  'Keep reading in your normal voice until the bar is full.';

type Phase = 'idle' | 'listening' | 'working' | 'short' | 'failed';

export class Enroll {
  readonly el: HTMLElement;
  private readonly title: HTMLElement;
  private readonly intro: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly status: HTMLElement;
  private readonly btnStart: HTMLButtonElement;
  private readonly btnSkip: HTMLButtonElement;
  private resolve: ((profile: VoiceProfile | null) => void) | null = null;
  private abort: AbortController | null = null;
  private phase: Phase = 'idle';
  private previouslyFocused: Element | null = null;

  constructor(
    parent: HTMLElement,
    private readonly deps: EnrollDeps,
  ) {
    this.title = h('h3', { id: 'enrollTitle' }, 'Teach One Take your voice');
    this.intro = h('p', { class: 'intro' });
    this.fill = h('span', { class: 'fill' });
    this.bar = h(
      'div',
      {
        class: 'bar',
        attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(ENROLL_SEC) },
      },
      this.fill,
    );
    this.status = h('p', { class: 'status', id: 'enrollStatus' });
    this.btnStart = h(
      'button',
      { class: 'primary', id: 'enrollStart' },
      icon('mic'),
      h('span', { class: 'label' }, 'Start listening'),
    );
    this.btnSkip = h('button', { id: 'enrollSkip' }, 'Skip for now');
    this.btnStart.onclick = () => void this.run();
    this.btnSkip.onclick = () => this.close(null);
    this.el = h(
      'div',
      { class: 'modal enroll', id: 'enroll' },
      h(
        'div',
        {
          class: 'box',
          attrs: {
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'enrollTitle',
            'aria-describedby': 'enrollStatus',
          },
        },
        this.title,
        this.intro,
        h('blockquote', { class: 'passage' }, PASSAGE),
        this.bar,
        this.status,
        h('div', { class: 'actions' }, this.btnStart, this.btnSkip),
      ),
    );
    document.addEventListener('keydown', (e) => {
      if (this.isOpen && e.key === 'Escape') {
        e.stopPropagation();
        this.close(null);
      }
    });
    parent.appendChild(this.el);
  }

  get isOpen(): boolean {
    return this.el.classList.contains('on');
  }

  /**
   * Opens the enrollment. Resolves with the new profile when one is made, or null when the speaker
   * skips (an old profile, if there was one, stays).
   */
  open(options: { hasProfile: boolean }): Promise<VoiceProfile | null> {
    this.close(null);
    this.intro.textContent = options.hasProfile
      ? 'Read the lines below out loud for twenty seconds, in the voice you lecture in, and the new recording replaces the profile you made before.'
      : 'Read the lines below out loud for twenty seconds, in the voice you lecture in. One Take keeps a short description of how your voice sounds, in this browser only, and uses it to mark the phrases that are not yours. Nothing is uploaded. Not now? Then the voice check stays off until you click Learn my voice under the level meter.';
    this.btnSkip.textContent = options.hasProfile ? 'Keep the old one' : 'Not now';
    this.setPhase('idle');
    this.previouslyFocused = document.activeElement;
    this.el.classList.add('on');
    this.btnStart.focus();
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  private setPhase(phase: Phase, note?: string): void {
    this.phase = phase;
    this.btnStart.disabled = phase === 'listening' || phase === 'working';
    const label = this.btnStart.querySelector('.label');
    if (label) label.textContent = phase === 'short' || phase === 'failed' ? 'Try again' : 'Start listening';
    this.fill.style.width = '0%';
    this.bar.setAttribute('aria-valuenow', '0');
    switch (phase) {
      case 'idle':
        this.status.textContent = `Press Start listening, then read. It stops on its own after ${ENROLL_SEC} seconds.`;
        break;
      case 'listening':
        this.status.textContent = 'Listening… read the lines above.';
        break;
      case 'working':
        this.status.textContent = 'Working out what your voice sounds like…';
        break;
      case 'short':
        this.status.textContent = note ?? '';
        break;
      case 'failed':
        this.status.textContent = note ?? 'Something went wrong.';
        break;
    }
  }

  private async run(): Promise<void> {
    if (this.phase === 'listening' || this.phase === 'working') return;
    this.setPhase('listening');
    const abort = new AbortController();
    this.abort = abort;
    let voiceSec = 0;
    try {
      const clip = await this.deps.listen((voice, elapsed) => {
        voiceSec = voice;
        const pct = Math.min(100, (elapsed / ENROLL_SEC) * 100);
        this.fill.style.width = `${pct}%`;
        this.bar.setAttribute('aria-valuenow', elapsed.toFixed(0));
        this.status.textContent = `Listening… ${Math.round(voice)} s of your voice heard, ${Math.max(0, Math.ceil(ENROLL_SEC - elapsed))} s to go.`;
      }, abort.signal);
      if (!clip || this.cancelled(abort)) return;
      if (voiceSec < ENROLL_MIN_VOICE_SEC) {
        this.setPhase(
          'short',
          `Only ${Math.round(voiceSec)} s of your voice came through; ${ENROLL_MIN_VOICE_SEC} s is the least that works. Check the microphone and the level meter, then try again.`,
        );
        return;
      }
      this.setPhase('working');
      const profile = await this.deps.enroll(clip);
      if (this.cancelled(abort)) return;
      if (!profile) {
        this.setPhase(
          'short',
          'The voice model could not make a profile out of that. Try again, a little louder.',
        );
        return;
      }
      this.close(profile);
    } catch (error) {
      if (!this.cancelled(abort)) this.setPhase('failed', `Could not listen: ${(error as Error).message}`);
    } finally {
      if (this.abort === abort) this.abort = null;
    }
  }

  /** The dialog was closed (skipped, or Escape) while this run was under way. */
  private cancelled(abort: AbortController): boolean {
    return abort.signal.aborted || this.abort !== abort;
  }

  private close(profile: VoiceProfile | null): void {
    if (!this.isOpen) return;
    this.abort?.abort();
    this.abort = null;
    this.el.classList.remove('on');
    if (this.previouslyFocused instanceof HTMLElement) this.previouslyFocused.focus();
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(profile);
  }
}
