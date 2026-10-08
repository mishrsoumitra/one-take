/** A tiny element builder so views never touch innerHTML with user data. */

export type Child = Node | string | number | null | undefined | false | Child[];

type EventHandlers = { [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void };

export interface Props {
  class?: string;
  id?: string;
  title?: string;
  hidden?: boolean;
  disabled?: boolean;
  draggable?: boolean;
  multiple?: boolean;
  checked?: boolean;
  type?: string;
  value?: string;
  placeholder?: string;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  for?: string;
  href?: string;
  download?: string;
  src?: string;
  alt?: string;
  accept?: string;
  name?: string;
  style?: string;
  dataset?: Record<string, string>;
  attrs?: Record<string, string>;
  on?: EventHandlers;
}

const BOOLEAN_PROPS = new Set(['hidden', 'disabled', 'draggable', 'multiple', 'checked']);

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      if (key === 'class') el.className = value as string;
      else if (key === 'on') {
        for (const [name, handler] of Object.entries(value as EventHandlers)) {
          el.addEventListener(name, handler as EventListener);
        }
      } else if (key === 'dataset') Object.assign(el.dataset, value as Record<string, string>);
      else if (key === 'attrs')
        for (const [a, v] of Object.entries(value as Record<string, string>)) el.setAttribute(a, v);
      else if (key === 'style') el.style.cssText = value as string;
      else if (BOOLEAN_PROPS.has(key)) (el as unknown as Record<string, unknown>)[key] = Boolean(value);
      else if (key === 'value') (el as HTMLInputElement).value = String(value);
      else el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function replaceChildren(el: Element, ...children: Child[]): void {
  clear(el);
  append(el, children);
}
