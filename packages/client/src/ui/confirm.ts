import { h } from './dom.js';

export interface ConfirmOptions {
  title: string;
  /** What is about to happen and what it costs, in one or two sentences. */
  message: string;
  /** The button that goes ahead. It is red: every question asked here throws something away. */
  confirm: string;
  /** The button that backs out. It starts with the focus, so Enter and Space are the safe answer. */
  cancel: string;
}

/**
 * A yes / no question before something is thrown away. Resolves true when the red button is pressed
 * and false for the other button, Escape, or a click outside the box.
 */
export class Confirm {
  readonly el: HTMLElement;
  private readonly title: HTMLElement;
  private readonly message: HTMLElement;
  private readonly btnConfirm: HTMLButtonElement;
  private readonly btnCancel: HTMLButtonElement;
  private resolve: ((ok: boolean) => void) | null = null;
  private previouslyFocused: Element | null = null;

  constructor(parent: HTMLElement) {
    this.title = h('h3', { id: 'confirmTitle' });
    this.message = h('p', { id: 'confirmText' });
    this.btnConfirm = h('button', { class: 'danger', id: 'confirmYes' });
    this.btnCancel = h('button', { id: 'confirmNo' });
    this.btnConfirm.onclick = () => this.settle(true);
    this.btnCancel.onclick = () => this.settle(false);
    this.el = h(
      'div',
      { class: 'modal confirm', id: 'confirm' },
      h(
        'div',
        {
          class: 'box',
          attrs: {
            role: 'alertdialog',
            'aria-modal': 'true',
            'aria-labelledby': 'confirmTitle',
            'aria-describedby': 'confirmText',
          },
        },
        this.title,
        this.message,
        h('div', { class: 'actions' }, this.btnConfirm, this.btnCancel),
      ),
    );
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.settle(false);
    });
    // On the document, not the box: Escape backs out even when focus is not inside the dialog.
    document.addEventListener('keydown', (e) => {
      if (this.isOpen && e.key === 'Escape') {
        e.stopPropagation();
        this.settle(false);
      }
    });
    parent.appendChild(this.el);
  }

  get isOpen(): boolean {
    return this.el.classList.contains('on');
  }

  /** Opens the question; a question still open from before is answered "no" first. */
  ask(options: ConfirmOptions): Promise<boolean> {
    this.settle(false);
    this.title.textContent = options.title;
    this.message.textContent = options.message;
    this.btnConfirm.textContent = options.confirm;
    this.btnCancel.textContent = options.cancel;
    this.previouslyFocused = document.activeElement;
    this.el.classList.add('on');
    this.btnCancel.focus();
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  private settle(ok: boolean): void {
    if (!this.isOpen) return;
    this.el.classList.remove('on');
    if (this.previouslyFocused instanceof HTMLElement) this.previouslyFocused.focus();
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(ok);
  }
}
