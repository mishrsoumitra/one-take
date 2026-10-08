import { h } from './dom.js';

export class Toast {
  readonly el: HTMLElement;
  private readonly text = h('span');
  private readonly button = h('button', { hidden: true });
  private timer = 0;

  constructor(parent: HTMLElement) {
    this.el = h('div', { id: 'toast', class: 'toast', attrs: { role: 'status' } }, this.text, this.button);
    parent.appendChild(this.el);
  }

  show(message: string, action?: { label: string; run: () => void }): void {
    this.text.textContent = message;
    if (action) {
      this.button.hidden = false;
      this.button.textContent = action.label;
      this.button.onclick = () => {
        action.run();
        this.hide();
      };
    } else {
      this.button.hidden = true;
      this.button.onclick = null;
    }
    this.el.classList.add('on');
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.hide(), action ? 6000 : 2600);
  }

  hide(): void {
    this.el.classList.remove('on');
  }
}
