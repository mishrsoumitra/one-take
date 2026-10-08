import { h } from './dom.js';

export function kbd(text: string): HTMLElement {
  return h('kbd', null, text);
}

/** One keyboard shortcut with its meaning; wraps as a unit inside a `.keys` list. */
export function shortcut(label: string, ...keys: string[]): HTMLElement {
  return h('span', { class: 'k' }, ...keys.map(kbd), ' ', label);
}
