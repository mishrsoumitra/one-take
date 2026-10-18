/**
 * Icons and the Newton School mark, both from grauity (@newtonschool/grauity), Newton School's
 * design system. The icons come from grauity's icon font (dist/css/grauity-icons.scss, imported in
 * main.ts); the mark is the outline of that font's `nst` glyph.
 */
import { h } from './dom.js';

/** The grauity icon names this app uses; the full list is the font's `$grauity-icons-map`. */
export type IconName =
  | 'arrow-up'
  | 'bin'
  | 'camera'
  | 'check'
  | 'chevron-left'
  | 'chevron-right'
  | 'close'
  | 'download'
  | 'folder'
  | 'folder-open'
  | 'hearing'
  | 'hold'
  | 'image'
  | 'mic'
  | 'micmute'
  | 'dot-circle'
  | 'moon'
  | 'pause'
  | 'pen'
  | 'play'
  | 'plus'
  | 'question-circle'
  | 'refresh'
  | 'remove'
  | 'reply'
  | 'skip-next'
  | 'skip-previous'
  | 'split-screen'
  | 'square-filled'
  | 'sun'
  | 'upload'
  | 'video'
  | 'waveform';

/** An icon glyph; decorative, so hidden from assistive technology. */
export function icon(name: IconName, size: 16 | 20 | 24 = 20): HTMLElement {
  return h('i', { class: `grauity-icon-${name} ico ico-${size}`, attrs: { 'aria-hidden': 'true' } });
}

/** Swaps the glyph of the icon inside a button (for example the mic button while the mic is on). */
export function setButtonIcon(button: HTMLElement, name: IconName): void {
  const el = button.querySelector('.ico');
  if (el) el.className = el.className.replace(/grauity-icon-[a-z0-9-]+/, `grauity-icon-${name}`);
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** The Newton School mark, traced from grauity's `nst` icon glyph (font units, y down). */
const NST_MARK_PATH =
  'M50-125L50-275L150-275L150-256L69-256L69-209L113-209Q137-209 156-195L156-195L218-256L175-256L175-275L250-275L250-200L231-200L231-243L170-181Q184-162 184-137L184-137L184-51Q205-61 218-81Q231-101 231-125L231-125L231-175L250-175L250-125Q250-91 229.50-64.50Q209-38 178-29L178-29Q164-25 150-25L150-25Q123-25 100-38.50Q77-52 63.50-75Q50-98 50-125L50-125ZM166-45L166-45L166-138Q166-160 150.50-175.50Q135-191 113-191L113-191L69-191L69-125Q69-103 80-84.50Q91-66 109.50-55Q128-44 150-44L150-44Q158-44 166-45Z';
const NST_MARK_VIEWBOX = '50 -275 200 250';

/** The mark as an inline SVG that takes the current text colour. */
export function nstMark(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', NST_MARK_VIEWBOX);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', NST_MARK_PATH);
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  return svg;
}

/** The browser-tab icon: the mark in white on a tile of grauity's brand blue (--brand-500). */
export function installFavicon(): void {
  const svg =
    `<svg xmlns="${SVG_NS}" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" rx="16" fill="#0673F9"/>` +
    `<svg x="16" y="12" width="32" height="40" viewBox="${NST_MARK_VIEWBOX}"><path d="${NST_MARK_PATH}" fill="#fff"/></svg>` +
    `</svg>`;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = h('link', { attrs: { rel: 'icon' } });
    document.head.appendChild(link);
  }
  link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
