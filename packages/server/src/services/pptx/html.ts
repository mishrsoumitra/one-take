/**
 * pptxtojson hands text over as a small HTML dialect: `<p style>` paragraphs holding `<span style>` runs,
 * `<br>` for forced breaks and `<ul>`/`<ol>`/`<li>` around list paragraphs. This turns that into
 * paragraphs of styled runs that the layout code can measure and wrap. No DOM, no external parser.
 */

export interface RunStyle {
  fontFamily: string | null;
  /** Points. */
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** CSS colour as written (hex or rgb/rgba), null for "inherit the shape's default". */
  color: string | null;
  /** Points. */
  letterSpacing: number;
  highlight: string | null;
  shift: 'super' | 'sub' | null;
}

export interface TextRun {
  /** "\n" alone marks a forced line break. */
  text: string;
  style: RunStyle;
}

export type ParagraphAlign = 'left' | 'center' | 'right' | 'justify';

export interface Paragraph {
  runs: TextRun[];
  align: ParagraphAlign;
  /** Multiple of the single line height, e.g. 1.15. */
  lineHeight: number;
  /** Points, applied above / below the paragraph. */
  spaceBefore: number;
  spaceAfter: number;
  /** Points. */
  marginLeft: number;
  textIndent: number;
  bullet: { kind: 'bullet' | 'number'; index: number; level: number } | null;
}

export const DEFAULT_FONT_SIZE = 18;

export const DEFAULT_RUN_STYLE: RunStyle = {
  fontFamily: null,
  fontSize: DEFAULT_FONT_SIZE,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  color: null,
  letterSpacing: 0,
  highlight: null,
  shift: null,
};

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  times: '×',
  rarr: '→',
  larr: '←',
};

/** Decodes the entities PowerPoint text tends to contain; `&nbsp;` becomes a plain, breakable space. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** `a: b; c: d` -> { a: 'b', c: 'd' } with lower-case keys. */
export function parseStyle(style: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!style) return out;
  for (const part of style.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const key = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/** "18pt" -> 18, "24px" -> 18, "1.5em" (relative to `base`) -> base * 1.5; null when unusable. */
export function parseLength(value: string | undefined, base = DEFAULT_FONT_SIZE): number | null {
  if (!value) return null;
  const m = /^(-?\d*\.?\d+)\s*(pt|px|em|rem|%)?$/i.exec(value.trim());
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  switch ((m[2] ?? 'pt').toLowerCase()) {
    case 'px':
      return n * 0.75;
    case 'em':
    case 'rem':
      return n * base;
    case '%':
      return (n / 100) * base;
    default:
      return n;
  }
}

function applySpanStyle(base: RunStyle, css: Record<string, string>): RunStyle {
  const style = { ...base };
  const family = css['font-family'];
  if (family)
    style.fontFamily =
      family
        .split(',')[0]
        ?.trim()
        .replace(/^['"]|['"]$/g, '') ?? null;
  const size = parseLength(css['font-size'], base.fontSize);
  if (size !== null && size > 0) style.fontSize = size;
  const weight = css['font-weight'];
  if (weight) style.bold = weight === 'bold' || weight === 'bolder' || Number(weight) >= 600;
  const fontStyle = css['font-style'];
  if (fontStyle) style.italic = fontStyle === 'italic' || fontStyle === 'oblique';
  const decoration = css['text-decoration'] ?? css['text-decoration-line'];
  if (decoration) {
    style.underline = decoration.includes('underline');
    style.strike = decoration.includes('line-through');
  }
  if (css.color) style.color = css.color;
  const spacing = parseLength(css['letter-spacing'], base.fontSize);
  if (spacing !== null) style.letterSpacing = spacing;
  const highlight = css['background-color'] ?? css.background;
  if (highlight) style.highlight = highlight === 'transparent' ? null : highlight;
  const vertical = css['vertical-align'];
  if (vertical === 'super' || vertical === 'sub') style.shift = vertical;
  return style;
}

function newParagraph(css: Record<string, string>, base: RunStyle): Paragraph {
  const align = css['text-align'];
  const lineHeightRaw = css['line-height'];
  let lineHeight = 1;
  if (lineHeightRaw) {
    const unitless = Number(lineHeightRaw);
    if (Number.isFinite(unitless) && unitless > 0) lineHeight = unitless;
    else {
      const pt = parseLength(lineHeightRaw, base.fontSize);
      if (pt !== null && pt > 0) lineHeight = pt / (base.fontSize * 1.2);
    }
  }
  return {
    runs: [],
    align:
      align === 'center' || align === 'right' || align === 'justify' || align === 'left' ? align : 'left',
    lineHeight,
    spaceBefore: Math.max(0, parseLength(css['margin-top'], base.fontSize) ?? 0),
    spaceAfter: Math.max(0, parseLength(css['margin-bottom'], base.fontSize) ?? 0),
    marginLeft: Math.max(0, parseLength(css['margin-left'], base.fontSize) ?? 0),
    textIndent: parseLength(css['text-indent'], base.fontSize) ?? 0,
    bullet: null,
  };
}

const TAG = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);
  return m ? (m[1] ?? m[2] ?? '') : null;
}

/**
 * Turns pptxtojson's text HTML into paragraphs. Text outside any `<p>` still becomes a paragraph, so
 * nothing is lost when the markup is unusual. Empty paragraphs keep one empty run so they take up a line.
 */
export function parseTextHtml(html: string, base: RunStyle = DEFAULT_RUN_STYLE): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const styleStack: RunStyle[] = [base];
  const lists: { kind: 'bullet' | 'number'; count: number }[] = [];
  let current: Paragraph | null = null;
  let lastStyle = base;
  let pendingListItem = false;

  const style = () => styleStack[styleStack.length - 1] ?? base;
  const ensureParagraph = () => {
    if (!current) {
      current = newParagraph({}, style());
      paragraphs.push(current);
    }
    return current;
  };
  const closeParagraph = () => {
    if (current?.runs.length === 0) current.runs.push({ text: '', style: lastStyle });
    current = null;
  };
  const addText = (raw: string) => {
    const text = decodeEntities(raw.replace(/[\r\n\t]+/g, ' '));
    if (!text) return;
    const p = ensureParagraph();
    const s = style();
    lastStyle = s;
    const last = p.runs[p.runs.length - 1];
    if (last?.style === s && last.text !== '\n') last.text += text;
    else p.runs.push({ text, style: s });
  };

  let index = 0;
  for (const m of html.matchAll(TAG)) {
    if (m.index > index) addText(html.slice(index, m.index));
    index = m.index + m[0].length;
    const closing = m[0].startsWith('</');
    const tag = (m[1] ?? '').toLowerCase();
    const attrs = m[2] ?? '';
    switch (tag) {
      case 'p':
      case 'div':
        if (closing) {
          closeParagraph();
        } else {
          closeParagraph();
          current = newParagraph(parseStyle(attr(attrs, 'style')), style());
          const list = lists[lists.length - 1];
          if (list && pendingListItem) {
            current.bullet = { kind: list.kind, index: list.count, level: lists.length };
            pendingListItem = false;
          }
          paragraphs.push(current);
        }
        break;
      case 'span':
      case 'a':
      case 'b':
      case 'strong':
      case 'i':
      case 'em':
      case 'u':
      case 's':
      case 'sup':
      case 'sub':
      case 'font':
        if (closing) {
          if (styleStack.length > 1) styleStack.pop();
        } else {
          const css = parseStyle(attr(attrs, 'style'));
          if (tag === 'b' || tag === 'strong') css['font-weight'] ??= 'bold';
          if (tag === 'i' || tag === 'em') css['font-style'] ??= 'italic';
          if (tag === 'u') css['text-decoration'] ??= 'underline';
          if (tag === 's') css['text-decoration'] ??= 'line-through';
          if (tag === 'sup') css['vertical-align'] ??= 'super';
          if (tag === 'sub') css['vertical-align'] ??= 'sub';
          styleStack.push(applySpanStyle(style(), css));
        }
        break;
      case 'br':
        if (!closing) {
          const p = ensureParagraph();
          lastStyle = style();
          p.runs.push({ text: '\n', style: lastStyle });
        }
        break;
      case 'ul':
      case 'ol':
        if (closing) {
          lists.pop();
          pendingListItem = false;
        } else {
          lists.push({ kind: tag === 'ol' ? 'number' : 'bullet', count: 0 });
        }
        closeParagraph();
        break;
      case 'li':
        if (closing) {
          closeParagraph();
          pendingListItem = false;
        } else {
          closeParagraph();
          const list = lists[lists.length - 1];
          if (list) {
            list.count += 1;
            pendingListItem = true;
          }
        }
        break;
      default:
        break;
    }
  }
  if (index < html.length) addText(html.slice(index));
  closeParagraph();
  return paragraphs;
}

/** Plain text of the paragraphs, for logs and tests. */
export function paragraphsToText(paragraphs: readonly Paragraph[]): string {
  return paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n');
}
