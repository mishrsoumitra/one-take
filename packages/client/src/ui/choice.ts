import { h, replaceChildren } from './dom.js';

export interface ChoiceOption {
  id: string;
  label: string;
  /** One line under the label saying what the choice does. */
  detail?: string;
  kind?: 'primary' | 'danger';
}

export interface ChoiceOptions {
  title: string;
  message: string;
  /** In order; the first one gets the focus. */
  options: ChoiceOption[];
  /** The button that backs out of the question; Escape and a click outside do the same. */
  cancel: string;
}

/**
 * A question with more than one way forward (continue a recording, or start again). Resolves with
 * the chosen option's id, or null for the cancel button, Escape, or a click outside the box.
 */
export class Choice {
  readonly el: HTMLElement;
  private readonly title: HTMLElement;
  private readonly message: HTMLElement;
  private readonly list: HTMLElement;
  private readonly btnCancel: HTMLButtonElement;
  private resolve: ((id: string | null) => void) | null = null;
  private previouslyFocused: Element | null = null;

  constructor(parent: HTMLElement) {
    this.title = h('h3', { id: 'choiceTitle' });
    this.message = h('p', { id: 'choiceText' });
    this.list = h('div', { class: 'choices', id: 'choiceList' });
    this.btnCancel = h('button', { class: 'ghost', id: 'choiceCancel' });
    this.btnCancel.onclick = () => this.settle(null);
    this.el = h(
      'div',
      { class: 'modal choice', id: 'choice' },
      h(
        'div',
        {
          class: 'box',
          attrs: {
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'choiceTitle',
            'aria-describedby': 'choiceText',
          },
        },
        this.title,
        this.message,
        this.list,
        h('div', { class: 'actions' }, h('div', { class: 'spacer' }), this.btnCancel),
      ),
    );
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.settle(null);
    });
    document.addEventListener('keydown', (e) => {
      if (this.isOpen && e.key === 'Escape') {
        e.stopPropagation();
        this.settle(null);
      }
    });
    parent.appendChild(this.el);
  }

  get isOpen(): boolean {
    return this.el.classList.contains('on');
  }

  /** Opens the question; one still open from before is cancelled first. */
  ask(options: ChoiceOptions): Promise<string | null> {
    this.settle(null);
    this.title.textContent = options.title;
    this.message.textContent = options.message;
    this.btnCancel.textContent = options.cancel;
    const buttons = options.options.map((o) =>
      h(
        'button',
        {
          class: `choice-btn${o.kind ? ` ${o.kind}` : ''}`,
          id: `choice-${o.id}`,
          on: { click: () => this.settle(o.id) },
        },
        h('span', { class: 'label' }, o.label),
        o.detail ? h('small', null, o.detail) : null,
      ),
    );
    replaceChildren(this.list, ...buttons);
    this.previouslyFocused = document.activeElement;
    this.el.classList.add('on');
    (buttons[0] ?? this.btnCancel).focus();
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  private settle(id: string | null): void {
    if (!this.isOpen) return;
    this.el.classList.remove('on');
    if (this.previouslyFocused instanceof HTMLElement) this.previouslyFocused.focus();
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(id);
  }
}
