import { h } from './dom.js';
import { icon, nstMark } from './icon.js';
import { kbd, shortcut } from './kbd.js';

export interface WelcomeDeps {
  /** The user pressed the primary button: close and open the file picker. */
  onChooseSlides: () => void;
  /** The "show tips while I work" box changed. */
  onTipsChange: (on: boolean) => void;
  /** Called every time the overlay closes, however it was closed. */
  onClose: () => void;
}

function step(n: number, title: string, ...body: (string | HTMLElement)[]): HTMLElement {
  return h(
    'li',
    null,
    h('span', { class: 'step' }, String(n)),
    h('div', null, h('b', null, title), h('span', null, ...body)),
  );
}

/** A word in the tour that names something on the screen. */
function em(text: string): HTMLElement {
  return h('i', { class: 'em' }, text);
}

/**
 * The welcome tour: what the app does and the three things to do, in order. Opens by itself on the
 * first visit and from the Help button afterwards.
 */
export class Welcome {
  readonly el: HTMLElement;
  private readonly tips: HTMLInputElement;
  private readonly btnChoose: HTMLButtonElement;
  private readonly onClose: () => void;
  private previouslyFocused: Element | null = null;

  constructor(parent: HTMLElement, deps: WelcomeDeps) {
    this.tips = h('input', { type: 'checkbox', id: 'welcomeTips', checked: true });
    this.tips.onchange = () => deps.onTipsChange(this.tips.checked);
    this.btnChoose = h(
      'button',
      { class: 'primary', id: 'welcomeChoose' },
      icon('folder-open'),
      'Choose slides',
    );
    this.btnChoose.onclick = () => {
      this.close();
      deps.onChooseSlides();
    };
    const btnClose = h('button', { id: 'welcomeClose' }, 'Got it');
    btnClose.onclick = () => this.close();
    const btnX = h(
      'button',
      { class: 'x', title: 'Close', attrs: { 'aria-label': 'Close' } },
      icon('close', 16),
    );
    btnX.onclick = () => this.close();

    this.el = h(
      'div',
      { class: 'modal welcome', id: 'welcome' },
      h(
        'div',
        { class: 'box', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'welcomeTitle' } },
        btnX,
        h(
          'div',
          { class: 'head' },
          h('span', { class: 'logo', attrs: { 'aria-hidden': 'true' } }, nstMark()),
          h(
            'div',
            null,
            h('div', { class: 'by' }, 'Newton School'),
            h('h3', { id: 'welcomeTitle' }, 'Record a lecture in one take'),
            h(
              'p',
              null,
              'Your slides plus your voice become a video. Only the moments you speak are kept, so you can stop and think as often as you like and never press pause.',
            ),
          ),
        ),
        h(
          'ol',
          { class: 'steps' },
          step(
            1,
            'Load your slides',
            'A PDF, a PowerPoint file or a set of PNG / JPG images. Drop the file anywhere on the page or click ',
            em('Load slides'),
            '.',
          ),
          step(
            2,
            'Start the mic and talk',
            'Click ',
            em('Start mic'),
            ' and allow the microphone. In ',
            em('Auto'),
            ' the app listens the whole time and skips your pauses. In ',
            em('Press to speak'),
            ' it records only while you hold ',
            kbd('Space'),
            ' or the button on the stage; let go while you think. Change slides with ',
            kbd('→'),
            ' ',
            kbd('←'),
            ' or a clicker and the video follows. Said something wrong? Press ',
            kbd('Backspace'),
            ' and say it again.',
          ),
          step(
            3,
            'Preview, edit and export',
            em('Preview'),
            ' plays it back with the slides changing at the right moments. ',
            em('Edit'),
            ' lets you re-record a phrase, cut a stretch of audio, delete a clip or record a new one on any slide. ',
            em('Export video'),
            ' saves an MP4 (or WebM, MKV, MOV, HLS, DASH) into a folder on this computer.',
          ),
        ),
        h(
          'div',
          { class: 'notes' },
          h(
            'p',
            null,
            h('b', null, 'Check your level. '),
            'In the meter at the bottom, your voice should cross the white line and room noise should stay below it. Drag ',
            em('Speech line'),
            ' if it does not. Next to the meter, ',
            em('Microphone'),
            ' picks the mic and ',
            em('Noise filter'),
            ' takes a fan or an air conditioner out from under your voice.',
          ),
          h(
            'p',
            null,
            h('b', null, 'Nothing is lost. '),
            'Your work is saved in this browser as you go, so you can close the tab and resume later. Nothing leaves your computer.',
          ),
        ),
        h(
          'div',
          { class: 'keys' },
          shortcut('change slide', '→', '←'),
          shortcut('hold to speak', 'Space'),
          shortcut('remove last phrase', 'Backspace'),
          shortcut('bring it back', '⌘Z'),
          shortcut('mute', 'M'),
          shortcut('mic on / off', 'R'),
          shortcut('stop preview', 'Esc'),
        ),
        h(
          'div',
          { class: 'actions' },
          this.btnChoose,
          btnClose,
          h('label', { class: 'tips', for: 'welcomeTips' }, this.tips, ' Show tips while I work'),
        ),
      ),
    );
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    // On the document, not the box: Escape should close the tour even when focus is not inside it.
    document.addEventListener('keydown', (e) => {
      if (this.isOpen && e.key === 'Escape') {
        e.stopPropagation();
        this.close();
      }
    });
    this.onClose = deps.onClose;
    parent.appendChild(this.el);
  }

  get isOpen(): boolean {
    return this.el.classList.contains('on');
  }

  open(options: { tips: boolean }): void {
    this.tips.checked = options.tips;
    this.previouslyFocused = document.activeElement;
    this.el.classList.add('on');
    this.btnChoose.focus();
  }

  close(): void {
    if (!this.isOpen) return;
    this.el.classList.remove('on');
    if (this.previouslyFocused instanceof HTMLElement) this.previouslyFocused.focus();
    this.onClose();
  }
}
