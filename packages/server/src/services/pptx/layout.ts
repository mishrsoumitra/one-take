/**
 * Breaks paragraphs into lines that fit a box, the way PowerPoint lays out a text frame: greedy word
 * wrapping, line boxes 1.2 times the largest font on the line scaled by the paragraph's line spacing,
 * bullets hanging to the left of the text, and "shrink text on overflow" when the deck asks for it.
 * Measuring is injected so this stays independent of pdfkit (and testable with a fake ruler).
 */
import { type Paragraph, type RunStyle } from './html.js';

export interface Measurer {
  /** Advance width of `text` in points. */
  width(text: string, style: RunStyle): number;
  /** Distance from the baseline down to the lowest descender, in points (positive). */
  descent(style: RunStyle): number;
}

export interface PlacedRun {
  text: string;
  style: RunStyle;
  /** Relative to the box's left edge. */
  x: number;
  width: number;
}

export interface Line {
  runs: PlacedRun[];
  /** Relative to the box's top edge (after the paragraph spacing above). */
  top: number;
  height: number;
  /** Baseline offset from the box's top edge. */
  baseline: number;
  bullet: { text: string; x: number; style: RunStyle } | null;
}

export interface TextBlock {
  lines: Line[];
  /** Total height used, in points. */
  height: number;
  /** Font scale applied to fit (1 when nothing was shrunk). */
  scale: number;
}

export interface LayoutOptions {
  wrap: boolean;
  /** 0..1 multiplier applied to every font size (PowerPoint's fontScale / 100). */
  fontScale?: number;
}

/** PowerPoint's single line spacing is about 1.2 times the font size. */
export const LINE_FACTOR = 1.2;
/** Hanging indent per list level, in points (PowerPoint's default is 0.375 in). */
export const BULLET_INDENT = 27;

function scaled(style: RunStyle, scale: number): RunStyle {
  return scale === 1
    ? style
    : { ...style, fontSize: style.fontSize * scale, letterSpacing: style.letterSpacing * scale };
}

interface Token {
  text: string;
  style: RunStyle;
  width: number;
  space: boolean;
  /** forced line break */
  br: boolean;
}

function tokenize(paragraph: Paragraph, measurer: Measurer, scale: number): Token[] {
  const tokens: Token[] = [];
  for (const run of paragraph.runs) {
    const style = scaled(run.style, scale);
    if (run.text === '\n') {
      tokens.push({ text: '', style, width: 0, space: false, br: true });
      continue;
    }
    for (const piece of run.text.split(/(\s+)/)) {
      if (!piece) continue;
      const space = /^\s+$/.test(piece);
      tokens.push({ text: piece, style, width: measurer.width(piece, style), space, br: false });
    }
  }
  return tokens;
}

/** Splits a word that is wider than the line into pieces that fit, measuring prefix by prefix. */
function breakWord(token: Token, available: number, measurer: Measurer): Token[] {
  const out: Token[] = [];
  let rest = token.text;
  while (rest.length > 1) {
    let n = rest.length;
    while (n > 1 && measurer.width(rest.slice(0, n), token.style) > available) n -= 1;
    const piece = rest.slice(0, n);
    out.push({ ...token, text: piece, width: measurer.width(piece, token.style) });
    rest = rest.slice(n);
  }
  if (rest) out.push({ ...token, text: rest, width: measurer.width(rest, token.style) });
  return out;
}

function lineMetrics(tokens: readonly Token[], fallback: RunStyle, measurer: Measurer, lineHeight: number) {
  let size = 0;
  let descent = 0;
  for (const t of tokens) {
    if (t.style.fontSize > size) {
      size = t.style.fontSize;
      descent = measurer.descent(t.style);
    }
  }
  if (size === 0) {
    size = fallback.fontSize;
    descent = measurer.descent(fallback);
  }
  const height = size * LINE_FACTOR * lineHeight;
  return { height, baseline: height - Math.min(descent, size * 0.4) };
}

function placeRuns(tokens: readonly Token[], startX: number): { runs: PlacedRun[]; width: number } {
  const runs: PlacedRun[] = [];
  let x = startX;
  for (const t of tokens) {
    const last = runs[runs.length - 1];
    if (last?.style === t.style) {
      last.text += t.text;
      last.width += t.width;
    } else {
      runs.push({ text: t.text, style: t.style, x, width: t.width });
    }
    x += t.width;
  }
  return { runs, width: x - startX };
}

function trimTrailingSpace(tokens: Token[]): void {
  while (tokens.length > 0 && tokens[tokens.length - 1]?.space) tokens.pop();
}

function bulletText(paragraph: Paragraph): string {
  if (!paragraph.bullet) return '';
  if (paragraph.bullet.kind === 'number') return `${paragraph.bullet.index}.`;
  return paragraph.bullet.level % 2 === 0 ? '–' : '•';
}

/** Lays the paragraphs out at a fixed scale. */
export function layoutText(
  paragraphs: readonly Paragraph[],
  boxWidth: number,
  measurer: Measurer,
  options: LayoutOptions,
): TextBlock {
  const scale = options.fontScale ?? 1;
  const lines: Line[] = [];
  let y = 0;
  paragraphs.forEach((paragraph, pi) => {
    const first = paragraph.runs[0]?.style ?? ({ fontSize: 18 * scale } as RunStyle);
    const fallback = scaled(first, scale);
    const level = paragraph.bullet?.level ?? 0;
    const indent = paragraph.marginLeft * scale + level * BULLET_INDENT * scale;
    const bullet = paragraph.bullet
      ? { text: bulletText(paragraph), x: indent - BULLET_INDENT * scale, style: fallback }
      : null;
    if (pi > 0) y += paragraph.spaceBefore * scale;
    const tokens = tokenize(paragraph, measurer, scale);
    const rows: Token[][] = [];
    let row: Token[] = [];
    let rowWidth = 0;
    const availableFor = (rowIndex: number) =>
      Math.max(1, boxWidth - indent - (rowIndex === 0 ? paragraph.textIndent * scale : 0));
    const flush = () => {
      trimTrailingSpace(row);
      rows.push(row);
      row = [];
      rowWidth = 0;
    };
    for (const token of tokens) {
      if (token.br) {
        flush();
        continue;
      }
      const available = availableFor(rows.length);
      if (options.wrap && !token.space && rowWidth + token.width > available && row.length > 0) {
        flush();
      }
      if (token.space && row.length === 0 && rows.length > 0) continue; // no leading spaces after a wrap
      if (options.wrap && !token.space && token.width > available) {
        for (const piece of breakWord(token, available, measurer)) {
          if (rowWidth + piece.width > available && row.length > 0) flush();
          row.push(piece);
          rowWidth += piece.width;
        }
        continue;
      }
      row.push(token);
      rowWidth += token.width;
    }
    flush();
    rows.forEach((rowTokens, ri) => {
      const { height, baseline } = lineMetrics(rowTokens, fallback, measurer, paragraph.lineHeight);
      const available = availableFor(ri);
      const width = rowTokens.reduce((a, t) => a + t.width, 0);
      let startX = indent + (ri === 0 ? paragraph.textIndent * scale : 0);
      if (paragraph.align === 'center') startX += (available - width) / 2;
      else if (paragraph.align === 'right') startX += available - width;
      const placed = placeRuns(rowTokens, startX);
      lines.push({
        runs: placed.runs,
        top: y,
        height,
        baseline: y + baseline,
        bullet: ri === 0 && bullet?.text ? bullet : null,
      });
      y += height;
    });
    y += paragraph.spaceAfter * scale;
  });
  return { lines, height: y, scale };
}

export interface FitOptions extends LayoutOptions {
  /** Shrink the text until it fits the height (PowerPoint's "shrink text on overflow"). */
  shrinkToFit: boolean;
}

/** Lays the text out, shrinking in steps of 10 % down to 40 % when allowed and the box is too small. */
export function fitText(
  paragraphs: readonly Paragraph[],
  boxWidth: number,
  boxHeight: number,
  measurer: Measurer,
  options: FitOptions,
): TextBlock {
  let scale = options.fontScale ?? 1;
  let block = layoutText(paragraphs, boxWidth, measurer, { ...options, fontScale: scale });
  if (!options.shrinkToFit) return block;
  while (block.height > boxHeight + 0.5 && scale > 0.4) {
    scale = Math.max(0.4, scale - 0.1);
    block = layoutText(paragraphs, boxWidth, measurer, { ...options, fontScale: scale });
  }
  return block;
}
