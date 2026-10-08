/**
 * Draws a parsed deck (pptxtojson's JSON) into a PDF with pdfkit, one page per slide at the slide's own
 * size in points. Everything is plain JavaScript: no PowerPoint, LibreOffice or browser is involved.
 *
 * Fidelity goals, in order: text in the right place with the right font, size and colour; shapes and
 * images where the deck put them; tables and simple charts readable. Effects PowerPoint can do and PDF
 * drawing cannot (3-D, soft shadows, SmartArt animation, embedded video) are approximated or skipped,
 * and each skipped feature is reported once in the warnings.
 */
import PDFDocument from 'pdfkit';

import { type FontIndex } from './fonts.js';
import { parseColor, presetPath, scalePath, straightLine, type Rgba } from './geometry.js';
import { DEFAULT_RUN_STYLE, parseTextHtml, type RunStyle } from './html.js';
import { fitText, type Measurer, type TextBlock } from './layout.js';

import type {
  Chart,
  Element,
  Fill,
  Image,
  Shape,
  Slide,
  Table,
  Text,
  Video,
  Audio,
  Math as MathElement,
} from 'pptxtojson';

export interface Deck {
  slides: Slide[];
  size: { width: number; height: number };
  themeColors?: string[];
}

export interface RenderOptions {
  fonts: FontIndex;
  title?: string;
}

export interface RenderResult {
  pdf: Buffer;
  pages: number;
  warnings: string[];
}

interface Origin {
  x: number;
  y: number;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** pdfkit keeps the loaded font's metrics on a private field; the typings do not expose it. */
interface FontMetrics {
  ascender: number;
  descender: number;
}

const DEFAULT_TEXT_COLOR = '#000000';

function num(n: number | undefined | null, fallback = 0): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

function rectPath(box: Box): string {
  const right = box.left + box.width;
  const bottom = box.top + box.height;
  return `M ${box.left} ${box.top} L ${right} ${box.top} L ${right} ${bottom} L ${box.left} ${bottom} Z`;
}

function imageKind(
  buf: Buffer,
): 'png' | 'jpeg' | 'gif' | 'svg' | 'webp' | 'bmp' | 'tiff' | 'emf' | 'unknown' {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 3 && buf.toString('latin1', 0, 3) === 'GIF') return 'gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP')
    return 'webp';
  if (buf.length >= 2 && buf.toString('latin1', 0, 2) === 'BM') return 'bmp';
  if (
    buf.length >= 4 &&
    (buf.toString('latin1', 0, 4) === 'II*\0' || buf.toString('latin1', 0, 4) === 'MM\0*')
  )
    return 'tiff';
  if (buf.length >= 4 && buf.readUInt32LE(0) === 1 && buf.length > 44) return 'emf';
  const head = buf.toString('latin1', 0, Math.min(buf.length, 512)).trimStart();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'svg';
  return 'unknown';
}

function dataUrlToBuffer(dataUrl: string): Buffer | null {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  try {
    return Buffer.from(dataUrl.slice(comma + 1), 'base64');
  } catch {
    return null;
  }
}

function verticalAlign(value: string | undefined): 'top' | 'middle' | 'bottom' {
  switch ((value ?? '').toLowerCase()) {
    case 'mid':
    case 'middle':
    case 'center':
    case 'ctr':
      return 'middle';
    case 'down':
    case 'bottom':
    case 'b':
      return 'bottom';
    default:
      return 'top';
  }
}

export class SlideRenderer {
  private readonly doc: PDFKit.PDFDocument;
  private readonly warnings = new Set<string>();
  private readonly badFonts = new Set<string>();
  private readonly measurer: Measurer;

  constructor(
    private readonly deck: Deck,
    private readonly options: RenderOptions,
  ) {
    this.doc = new PDFDocument({
      autoFirstPage: false,
      compress: true,
      info: {
        Title: options.title ?? 'Slides',
        Producer: 'One Take',
        Creator: 'One Take (pptxtojson + pdfkit)',
      },
    });
    this.measurer = {
      width: (text, style) => {
        this.useFont(style);
        return this.doc.widthOfString(text, { characterSpacing: style.letterSpacing });
      },
      descent: (style) => {
        this.useFont(style);
        return (Math.abs(this.metrics().descender) / 1000) * style.fontSize;
      },
    };
  }

  /** Draws every slide and resolves with the finished PDF. */
  render(): Promise<RenderResult> {
    const { doc } = this;
    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });
    const { width, height } = this.deck.size;
    for (const slide of this.deck.slides) {
      doc.addPage({ size: [width, height], margin: 0 });
      this.drawSlide(slide, width, height);
    }
    doc.end();
    return done.then((pdf) => ({ pdf, pages: this.deck.slides.length, warnings: [...this.warnings] }));
  }

  /* ---------------------------------------------------------------- */
  /* Fonts                                                             */
  /* ---------------------------------------------------------------- */

  private metrics(): FontMetrics {
    const font = (this.doc as unknown as { _font?: Partial<FontMetrics> })._font;
    return { ascender: num(font?.ascender, 800), descender: num(font?.descender, -200) };
  }

  private useFont(style: RunStyle): void {
    const resolved = this.options.fonts.resolve(style.fontFamily, style.bold, style.italic);
    const { doc } = this;
    if (resolved.file && !this.badFonts.has(resolved.file)) {
      try {
        if (resolved.postscriptName) doc.font(resolved.file, resolved.postscriptName);
        else doc.font(resolved.file);
        doc.fontSize(style.fontSize);
        return;
      } catch {
        this.badFonts.add(resolved.file);
        this.warn(`Could not read the font file ${resolved.file}; using Helvetica instead`);
      }
    }
    if (resolved.file) {
      const fallback = this.options.fonts.resolve('Helvetica', style.bold, style.italic);
      doc.font(fallback.file && !this.badFonts.has(fallback.file) ? fallback.file : fallback.key);
    } else {
      doc.font(resolved.key);
    }
    doc.fontSize(style.fontSize);
  }

  private warn(message: string): void {
    this.warnings.add(message);
  }

  /* ---------------------------------------------------------------- */
  /* Slides and elements                                               */
  /* ---------------------------------------------------------------- */

  private drawSlide(slide: Slide, width: number, height: number): void {
    const { doc } = this;
    doc.save();
    const page: Box = { left: 0, top: 0, width, height };
    const fill = slide.fill as Fill | null | undefined;
    doc.path(rectPath(page)).fillColor('#ffffff').fill();
    if (fill) this.fillPath(rectPath(page), fill, page, true);
    doc.restore();
    this.drawElements(slide.layoutElements, { x: 0, y: 0 });
    this.drawElements(slide.elements, { x: 0, y: 0 });
  }

  private drawElements(elements: readonly Element[] | undefined, origin: Origin): void {
    if (!elements) return;
    for (const element of elements) {
      try {
        this.drawElement(element, origin);
      } catch (error) {
        this.warn(`Could not draw a ${element.type} element: ${(error as Error).message}`);
      }
    }
  }

  private boxOf(element: { left: number; top: number; width: number; height: number }, origin: Origin): Box {
    return {
      left: origin.x + num(element.left),
      top: origin.y + num(element.top),
      width: Math.max(0, num(element.width)),
      height: Math.max(0, num(element.height)),
    };
  }

  /** Applies rotation and flips about the box centre; call inside save/restore. */
  private transform(
    box: Box,
    rotate: number | undefined,
    flipH: boolean | undefined,
    flipV: boolean | undefined,
  ): void {
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    if (rotate) this.doc.rotate(rotate, { origin: [cx, cy] });
    if (flipH || flipV) this.doc.scale(flipH ? -1 : 1, flipV ? -1 : 1, { origin: [cx, cy] });
  }

  private drawElement(element: Element, origin: Origin): void {
    switch (element.type) {
      case 'shape':
        this.drawShape(element, origin);
        break;
      case 'text':
        this.drawTextElement(element, origin);
        break;
      case 'image':
        this.drawImage(element, origin);
        break;
      case 'table':
        this.drawTable(element, origin);
        break;
      case 'chart':
        this.drawChart(element, origin);
        break;
      case 'group':
      case 'diagram': {
        const box = this.boxOf(element, origin);
        this.doc.save();
        if (element.type === 'group') this.transform(box, element.rotate, element.isFlipH, element.isFlipV);
        this.drawElements(element.elements, { x: box.left, y: box.top });
        this.doc.restore();
        break;
      }
      case 'math':
        this.drawMath(element, origin);
        break;
      case 'video':
      case 'audio':
        this.drawMediaPlaceholder(element, origin);
        break;
      default:
        this.warn(`Unknown element type ${(element as { type: string }).type} was skipped`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Fills and strokes                                                 */
  /* ---------------------------------------------------------------- */

  private gradientFor(fill: Extract<Fill, { type: 'gradient' }>, box: Box) {
    const { doc } = this;
    const stops = fill.value.colors
      .map((c) => ({
        pos: Math.min(1, Math.max(0, Number.parseFloat(c.pos) / 100)),
        color: parseColor(c.color),
      }))
      .filter((s): s is { pos: number; color: Rgba } => s.color !== null && Number.isFinite(s.pos))
      .sort((a, b) => a.pos - b.pos);
    if (stops.length === 0) return null;
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    if (fill.value.path === 'circle' || fill.value.path === 'rect' || fill.value.path === 'shape') {
      const r = Math.max(box.width, box.height) / 2;
      const g = doc.radialGradient(cx, cy, 0, cx, cy, r);
      for (const s of stops) g.stop(s.pos, s.color.hex, s.color.alpha);
      return g;
    }
    // PowerPoint's angle runs clockwise from "left to right"
    const angle = ((num(fill.value.rot) % 360) * Math.PI) / 180;
    const dx = (Math.cos(angle) * box.width) / 2;
    const dy = (Math.sin(angle) * box.height) / 2;
    const g = doc.linearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
    for (const s of stops) g.stop(s.pos, s.color.hex, s.color.alpha);
    return g;
  }

  /** Fills an already-scaled path. */
  private fillPath(path: string, fill: Fill | null | undefined, box: Box, isBackground = false): void {
    if (!fill) return;
    const { doc } = this;
    switch (fill.type) {
      case 'color': {
        const color = parseColor(fill.value);
        if (!color) return;
        doc.save();
        doc.path(path).fillColor(color.hex).fillOpacity(color.alpha).fill();
        doc.restore();
        return;
      }
      case 'gradient': {
        const gradient = this.gradientFor(fill, box);
        if (!gradient) return;
        doc.save();
        doc.path(path).fill(gradient);
        doc.restore();
        return;
      }
      case 'image': {
        const buf = fill.value.base64 ? dataUrlToBuffer(fill.value.base64) : null;
        if (!buf) {
          this.warn(`${isBackground ? 'A slide background' : 'A shape fill'} picture was not available`);
          return;
        }
        doc.save();
        doc.path(path).clip();
        const opacity = num(fill.value.opacity, 1);
        if (opacity < 1 && opacity >= 0) doc.fillOpacity(opacity);
        this.placeImage(buf, box, isBackground ? 'background' : 'fill');
        doc.restore();
        return;
      }
      case 'pattern': {
        const fg = parseColor(fill.value.foregroundColor);
        const bg = parseColor(fill.value.backgroundColor);
        doc.save();
        if (bg) doc.path(path).fillColor(bg.hex).fillOpacity(bg.alpha).fill();
        if (fg)
          doc
            .path(path)
            .fillColor(fg.hex)
            .fillOpacity(0.35 * fg.alpha)
            .fill();
        doc.restore();
        return;
      }
      default:
        return;
    }
  }

  private strokePath(
    path: string,
    width: number | undefined,
    color: string | undefined,
    type: string | undefined,
  ): void {
    const w = num(width);
    const c = parseColor(color);
    if (w <= 0 || !c) return;
    const { doc } = this;
    doc.save();
    doc.lineWidth(w).strokeColor(c.hex).strokeOpacity(c.alpha).lineJoin('round').lineCap('round');
    if (type === 'dashed') doc.dash(w * 4, { space: w * 3 });
    else if (type === 'dotted') doc.dash(Math.max(0.1, w), { space: w * 2 });
    doc.path(path).stroke();
    doc.restore();
  }

  private drawArrowHead(
    tip: { x: number; y: number },
    from: { x: number; y: number },
    width: number,
    color: string,
  ) {
    const size = Math.max(4, width * 4);
    const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
    const left = {
      x: tip.x - size * Math.cos(angle - Math.PI / 7),
      y: tip.y - size * Math.sin(angle - Math.PI / 7),
    };
    const right = {
      x: tip.x - size * Math.cos(angle + Math.PI / 7),
      y: tip.y - size * Math.sin(angle + Math.PI / 7),
    };
    this.doc
      .save()
      .moveTo(tip.x, tip.y)
      .lineTo(left.x, left.y)
      .lineTo(right.x, right.y)
      .closePath()
      .fillColor(color)
      .fill()
      .restore();
  }

  /* ---------------------------------------------------------------- */
  /* Shapes and text                                                   */
  /* ---------------------------------------------------------------- */

  private shapePath(shape: Shape, box: Box): string {
    const vb = shape.pathViewBox;
    if (shape.path && vb && vb.width > 0 && vb.height > 0) {
      const sx = box.width / vb.width;
      const sy = box.height / vb.height;
      return scalePath(shape.path, sx, sy, box.left - vb.x * sx, box.top - vb.y * sy);
    }
    const preset = presetPath(shape.shapType, box.width, box.height);
    return preset ? scalePath(preset, 1, 1, box.left, box.top) : rectPath(box);
  }

  private drawShape(shape: Shape, origin: Origin): void {
    const { doc } = this;
    const box = this.boxOf(shape, origin);
    doc.save();
    this.transform(box, shape.rotate, shape.isFlipH, shape.isFlipV);
    const path = this.shapePath(shape, box);
    const fill = shape.strokeOnly ? null : shape.fill;
    if (shape.shadow && fill && (num(shape.shadow.h) !== 0 || num(shape.shadow.v) !== 0)) {
      const shadow = parseColor(shape.shadow.color);
      if (shadow) {
        doc.save();
        doc.translate(num(shape.shadow.h), num(shape.shadow.v));
        doc.path(path).fillColor(shadow.hex).fillOpacity(Math.min(0.5, shadow.alpha)).fill();
        doc.restore();
      }
    }
    this.fillPath(path, fill, box);
    this.strokePath(path, shape.borderWidth, shape.borderColor, shape.borderType);
    const line = straightLine(path);
    const stroke = parseColor(shape.borderColor);
    if (line && stroke && num(shape.borderWidth) > 0) {
      if (shape.headEnd && shape.headEnd.type !== 'none')
        this.drawArrowHead(line.start, line.end, shape.borderWidth, stroke.hex);
      if (shape.tailEnd && shape.tailEnd.type !== 'none')
        this.drawArrowHead(line.end, line.start, shape.borderWidth, stroke.hex);
    }
    if (shape.content && !shape.strokeOnly) this.drawTextInBox(shape.content, box, shape);
    doc.restore();
  }

  private drawTextElement(text: Text, origin: Origin): void {
    const { doc } = this;
    const box = this.boxOf(text, origin);
    doc.save();
    this.transform(box, text.rotate, text.isFlipH, text.isFlipV);
    const rect = rectPath(box);
    this.fillPath(rect, text.fill, box);
    this.strokePath(rect, text.borderWidth, text.borderColor, text.borderType);
    this.drawTextInBox(text.content, box, text);
    doc.restore();
  }

  private drawTextInBox(
    html: string,
    box: Box,
    settings: {
      vAlign?: string;
      wrap?: boolean;
      autoFit?: { type: string; fontScale?: number };
      textInset?: { l: number; t: number; r: number; b: number };
    },
    base: RunStyle = DEFAULT_RUN_STYLE,
  ): void {
    const paragraphs = parseTextHtml(html, base);
    if (paragraphs.every((p) => p.runs.every((r) => r.text.trim() === ''))) return;
    const inset = settings.textInset ?? { l: 7.2, t: 3.6, r: 7.2, b: 3.6 };
    const inner: Box = {
      left: box.left + num(inset.l),
      top: box.top + num(inset.t),
      width: Math.max(1, box.width - num(inset.l) - num(inset.r)),
      height: Math.max(1, box.height - num(inset.t) - num(inset.b)),
    };
    const fontScale = settings.autoFit?.fontScale
      ? Math.min(1, Math.max(0.1, settings.autoFit.fontScale / 100))
      : 1;
    const block = fitText(paragraphs, inner.width, inner.height, this.measurer, {
      wrap: settings.wrap !== false,
      fontScale,
      shrinkToFit: settings.autoFit?.type === 'text',
    });
    const align = verticalAlign(settings.vAlign);
    const offsetY =
      align === 'middle'
        ? (inner.height - block.height) / 2
        : align === 'bottom'
          ? inner.height - block.height
          : 0;
    this.drawBlock(block, inner.left, inner.top + Math.max(0, offsetY));
  }

  private drawBlock(block: TextBlock, left: number, top: number): void {
    const { doc } = this;
    for (const line of block.lines) {
      const baseline = top + line.baseline;
      if (line.bullet) {
        this.useFont(line.bullet.style);
        const color = parseColor(line.bullet.style.color) ?? { hex: DEFAULT_TEXT_COLOR, alpha: 1 };
        doc.fillColor(color.hex).fillOpacity(color.alpha);
        doc.text(line.bullet.text, left + Math.max(0, line.bullet.x), baseline, {
          baseline: 'alphabetic',
          lineBreak: false,
        });
      }
      for (const run of line.runs) {
        if (!run.text) continue;
        this.useFont(run.style);
        const color = parseColor(run.style.color) ?? { hex: DEFAULT_TEXT_COLOR, alpha: 1 };
        const { ascender, descender } = this.metrics();
        const size = run.style.fontSize;
        let y = baseline;
        if (run.style.shift === 'super') {
          doc.fontSize(size * 0.65);
          y -= size * 0.35;
        } else if (run.style.shift === 'sub') {
          doc.fontSize(size * 0.65);
          y += size * 0.15;
        }
        const highlight = parseColor(run.style.highlight);
        if (highlight) {
          doc.save();
          doc
            .rect(
              left + run.x,
              y - (ascender / 1000) * size,
              run.width,
              ((ascender - descender) / 1000) * size,
            )
            .fillColor(highlight.hex)
            .fillOpacity(highlight.alpha)
            .fill();
          doc.restore();
        }
        doc.fillColor(color.hex).fillOpacity(color.alpha).strokeColor(color.hex);
        doc.text(run.text, left + run.x, y, {
          baseline: 'alphabetic',
          lineBreak: false,
          characterSpacing: run.style.letterSpacing,
          underline: run.style.underline,
          strike: run.style.strike,
        });
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Images                                                            */
  /* ---------------------------------------------------------------- */

  /** Draws a decoded picture stretched over the box; unsupported formats are reported, not fatal. */
  private placeImage(buf: Buffer, box: Box, what: string, crop?: Image['rect']): boolean {
    const kind = imageKind(buf);
    if (kind !== 'png' && kind !== 'jpeg') {
      this.warn(
        `${kind === 'unknown' ? 'An' : `A ${kind.toUpperCase()}`} picture (${what}) was skipped: only PNG and JPEG pictures can be embedded`,
      );
      return false;
    }
    const l = Math.min(0.95, Math.max(0, num(crop?.l) / 100));
    const r = Math.min(0.95, Math.max(0, num(crop?.r) / 100));
    const t = Math.min(0.95, Math.max(0, num(crop?.t) / 100));
    const b = Math.min(0.95, Math.max(0, num(crop?.b) / 100));
    const fullWidth = box.width / Math.max(0.05, 1 - l - r);
    const fullHeight = box.height / Math.max(0.05, 1 - t - b);
    try {
      this.doc.image(buf, box.left - l * fullWidth, box.top - t * fullHeight, {
        width: fullWidth,
        height: fullHeight,
      });
      return true;
    } catch (error) {
      this.warn(
        `A ${kind.toUpperCase()} picture (${what}) could not be embedded: ${(error as Error).message}`,
      );
      return false;
    }
  }

  private drawImage(image: Image, origin: Origin): void {
    const { doc } = this;
    const box = this.boxOf(image, origin);
    const buf = image.base64 ? dataUrlToBuffer(image.base64) : null;
    if (!buf) {
      this.warn(`The picture ${image.ref || image.id} was not available in the file`);
      return;
    }
    doc.save();
    this.transform(box, image.rotate, image.isFlipH, image.isFlipV);
    const preset = presetPath(image.geom, box.width, box.height);
    const clip = preset ? scalePath(preset, 1, 1, box.left, box.top) : rectPath(box);
    doc.path(clip).clip();
    this.placeImage(buf, box, image.ref || 'picture', image.rect);
    doc.restore();
    if (num(image.borderWidth) > 0)
      this.strokePath(clip, image.borderWidth, image.borderColor, image.borderType);
  }

  /* ---------------------------------------------------------------- */
  /* Tables                                                            */
  /* ---------------------------------------------------------------- */

  private drawTable(table: Table, origin: Origin): void {
    const box = this.boxOf(table, origin);
    const rows = table.data;
    if (rows.length === 0) return;
    const cols = Math.max(...rows.map((r) => r.length));
    const colWidths =
      table.colWidths.length === cols
        ? table.colWidths.map((w) => num(w))
        : Array<number>(cols).fill(box.width / cols);
    const rowHeights =
      table.rowHeights.length === rows.length
        ? table.rowHeights.map((h) => num(h))
        : Array<number>(rows.length).fill(box.height / rows.length);
    const xs = [box.left];
    for (const w of colWidths) xs.push((xs[xs.length - 1] ?? 0) + w);
    const ys = [box.top];
    for (const h of rowHeights) ys.push((ys[ys.length - 1] ?? 0) + h);
    rows.forEach((row, ri) => {
      row.forEach((cell, ci) => {
        if (cell.vMerge || cell.hMerge) return;
        const colSpan = Math.max(1, num(cell.colSpan, 1));
        const rowSpan = Math.max(1, num(cell.rowSpan, 1));
        const left = xs[ci] ?? box.left;
        const top = ys[ri] ?? box.top;
        const right = xs[Math.min(xs.length - 1, ci + colSpan)] ?? left;
        const bottom = ys[Math.min(ys.length - 1, ri + rowSpan)] ?? top;
        const cellBox: Box = { left, top, width: right - left, height: bottom - top };
        const rect = `M ${left} ${top} L ${right} ${top} L ${right} ${bottom} L ${left} ${bottom} Z`;
        const fill = parseColor(cell.fillColor);
        if (fill) this.doc.save().path(rect).fillColor(fill.hex).fillOpacity(fill.alpha).fill().restore();
        const borders = { ...table.borders, ...cell.borders };
        const edge = (
          b: { borderColor: string; borderWidth: number; borderType: string } | undefined,
          path: string,
        ) => {
          if (b) this.strokePath(path, b.borderWidth, b.borderColor, b.borderType);
        };
        edge(borders.top, `M ${left} ${top} L ${right} ${top}`);
        edge(borders.bottom, `M ${left} ${bottom} L ${right} ${bottom}`);
        edge(borders.left, `M ${left} ${top} L ${left} ${bottom}`);
        edge(borders.right, `M ${right} ${top} L ${right} ${bottom}`);
        if (cell.text) {
          const base: RunStyle = {
            ...DEFAULT_RUN_STYLE,
            color: cell.fontColor ?? null,
            bold: cell.fontBold === true,
          };
          this.drawTextInBox(
            cell.text,
            cellBox,
            { vAlign: cell.vAlign, wrap: true, textInset: { l: 5.4, t: 3.6, r: 5.4, b: 3.6 } },
            base,
          );
        }
      });
    });
  }

  /* ---------------------------------------------------------------- */
  /* Charts                                                            */
  /* ---------------------------------------------------------------- */

  private label(
    text: string,
    x: number,
    y: number,
    width: number,
    align: 'left' | 'center' | 'right',
    size = 9,
  ): void {
    const { doc } = this;
    const style: RunStyle = { ...DEFAULT_RUN_STYLE, fontSize: size, color: '#404040' };
    this.useFont(style);
    doc.fillColor('#404040').fillOpacity(1);
    doc.text(text, x, y, { width, align, lineBreak: false, baseline: 'top' });
  }

  private drawChart(chart: Chart, origin: Origin): void {
    const box = this.boxOf(chart, origin);
    const { doc } = this;
    const colors =
      chart.colors.length > 0
        ? chart.colors
        : ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'];
    doc.save();
    doc.rect(box.left, box.top, box.width, box.height).clip();
    const type = chart.chartType;
    const isBar = type === 'barChart' || type === 'bar3DChart';
    const isLine =
      type === 'lineChart' || type === 'line3DChart' || type === 'areaChart' || type === 'area3DChart';
    const isPie = type === 'pieChart' || type === 'pie3DChart' || type === 'doughnutChart';
    if (
      chart.chartType !== 'scatterChart' &&
      chart.chartType !== 'bubbleChart' &&
      (isBar || isLine || isPie)
    ) {
      const series = chart.data;
      if (isPie) this.drawPie(series, box, colors, type === 'doughnutChart');
      else this.drawBarsOrLines(series, box, colors, isBar, chart.barDir === 'bar');
      this.drawLegend(
        series.map((s) => s.key),
        box,
        colors,
      );
    } else {
      this.warn(`A ${type} chart was drawn as a placeholder`);
      doc.rect(box.left, box.top, box.width, box.height).fillColor('#f2f2f2').fill();
      this.label(
        `${type.replace('Chart', '')} chart`,
        box.left,
        box.top + box.height / 2 - 6,
        box.width,
        'center',
        11,
      );
    }
    doc.restore();
  }

  private drawLegend(names: string[], box: Box, colors: string[]): void {
    const { doc } = this;
    let x = box.left + 6;
    const y = box.top + box.height - 12;
    names.forEach((name, i) => {
      const color = parseColor(colors[i % colors.length]) ?? { hex: '#888888', alpha: 1 };
      doc
        .rect(x, y + 1, 7, 7)
        .fillColor(color.hex)
        .fill();
      const style: RunStyle = { ...DEFAULT_RUN_STYLE, fontSize: 8 };
      const w = this.measurer.width(name, style);
      this.label(name, x + 10, y, w + 2, 'left', 8);
      x += w + 20;
    });
  }

  private drawBarsOrLines(
    series: { key: string; values: { x: string; y: number }[] }[],
    box: Box,
    colors: string[],
    bars: boolean,
    horizontal: boolean,
  ): void {
    const { doc } = this;
    const categories = series[0]?.values.map((v) => v.x) ?? [];
    if (categories.length === 0 || series.length === 0) return;
    const plot: Box = {
      left: box.left + 36,
      top: box.top + 8,
      width: box.width - 44,
      height: box.height - 40,
    };
    const all = series.flatMap((s) => s.values.map((v) => num(v.y)));
    const max = Math.max(0, ...all);
    const min = Math.min(0, ...all);
    const range = max - min || 1;
    doc.save().lineWidth(0.5).strokeColor('#bfbfbf');
    doc
      .moveTo(plot.left, plot.top)
      .lineTo(plot.left, plot.top + plot.height)
      .lineTo(plot.left + plot.width, plot.top + plot.height)
      .stroke();
    doc.restore();
    this.label(String(Math.round(max)), box.left, plot.top - 4, 32, 'right', 7);
    this.label(String(Math.round(min)), box.left, plot.top + plot.height - 8, 32, 'right', 7);
    const n = categories.length;
    const slot = (horizontal ? plot.height : plot.width) / n;
    categories.forEach((label, i) => {
      if (horizontal) this.label(label, box.left, plot.top + i * slot + slot / 2 - 4, 32, 'right', 7);
      else this.label(label, plot.left + i * slot, plot.top + plot.height + 3, slot, 'center', 7);
    });
    const zeroAt = (value: number) => (value - min) / range;
    series.forEach((s, si) => {
      const color = parseColor(colors[si % colors.length]) ?? { hex: '#4472C4', alpha: 1 };
      if (bars) {
        const barW = (slot * 0.7) / series.length;
        s.values.forEach((v, i) => {
          const frac = zeroAt(num(v.y));
          const zero = zeroAt(0);
          if (horizontal) {
            const y = plot.top + i * slot + slot * 0.15 + si * barW;
            const x0 = plot.left + Math.min(frac, zero) * plot.width;
            const w = Math.abs(frac - zero) * plot.width;
            doc.rect(x0, y, w, barW).fillColor(color.hex).fill();
          } else {
            const x = plot.left + i * slot + slot * 0.15 + si * barW;
            const yTop = plot.top + (1 - Math.max(frac, zero)) * plot.height;
            const h = Math.abs(frac - zero) * plot.height;
            doc.rect(x, yTop, barW, h).fillColor(color.hex).fill();
          }
        });
      } else {
        const points = s.values.map((v, i) => ({
          x: plot.left + i * slot + slot / 2,
          y: plot.top + (1 - zeroAt(num(v.y))) * plot.height,
        }));
        doc.save().lineWidth(1.5).strokeColor(color.hex);
        points.forEach((p, i) => (i === 0 ? doc.moveTo(p.x, p.y) : doc.lineTo(p.x, p.y)));
        doc.stroke().restore();
        for (const p of points) doc.circle(p.x, p.y, 2).fillColor(color.hex).fill();
      }
    });
  }

  private drawPie(
    series: { key: string; values: { x: string; y: number }[] }[],
    box: Box,
    colors: string[],
    doughnut: boolean,
  ): void {
    const { doc } = this;
    const values = series[0]?.values ?? [];
    const total = values.reduce((a, v) => a + Math.max(0, num(v.y)), 0);
    if (total <= 0) return;
    const r = Math.min(box.width, box.height - 20) / 2 - 4;
    const cx = box.left + box.width / 2;
    const cy = box.top + (box.height - 20) / 2;
    let angle = -Math.PI / 2;
    values.forEach((v, i) => {
      const frac = Math.max(0, num(v.y)) / total;
      const end = angle + frac * Math.PI * 2;
      const color = parseColor(colors[i % colors.length]) ?? { hex: '#4472C4', alpha: 1 };
      doc.save();
      doc.moveTo(cx, cy);
      doc.lineTo(cx + r * Math.cos(angle), cy + r * Math.sin(angle));
      const large = frac > 0.5 ? 1 : 0;
      doc
        .path(
          `M ${cx + r * Math.cos(angle)} ${cy + r * Math.sin(angle)} A ${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(end)} ${cy + r * Math.sin(end)} L ${cx} ${cy} Z`,
        )
        .fillColor(color.hex)
        .fill();
      doc.restore();
      angle = end;
    });
    if (doughnut)
      doc
        .circle(cx, cy, r * 0.5)
        .fillColor('#ffffff')
        .fill();
  }

  /* ---------------------------------------------------------------- */
  /* Everything else                                                   */
  /* ---------------------------------------------------------------- */

  private drawMath(math: MathElement, origin: Origin): void {
    const box = this.boxOf(math, origin);
    const buf = math.picBase64 ? dataUrlToBuffer(math.picBase64) : null;
    if (buf && this.placeImage(buf, box, 'equation')) return;
    const text = math.latex.length > 0 ? math.latex : (math.text ?? '');
    if (!text) return;
    this.warn('An equation was drawn as plain text');
    const style: RunStyle = { ...DEFAULT_RUN_STYLE, fontFamily: 'Cambria Math', fontSize: 14 };
    this.drawTextInBox(
      `<p><span>${text.replace(/</g, '&lt;')}</span></p>`,
      box,
      { vAlign: 'mid', wrap: true },
      style,
    );
  }

  private drawMediaPlaceholder(media: Video | Audio, origin: Origin): void {
    const box = this.boxOf(media, origin);
    const { doc } = this;
    this.warn(`A ${media.type} was drawn as a placeholder (${media.ref || media.id})`);
    doc.save();
    doc.rect(box.left, box.top, box.width, box.height).fillColor('#202020').fill();
    const r = Math.min(box.width, box.height) / 6;
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    doc.circle(cx, cy, r).fillColor('#ffffff').fillOpacity(0.85).fill();
    doc
      .moveTo(cx - r * 0.35, cy - r * 0.5)
      .lineTo(cx + r * 0.55, cy)
      .lineTo(cx - r * 0.35, cy + r * 0.5)
      .closePath()
      .fillColor('#202020')
      .fillOpacity(1)
      .fill();
    doc.restore();
  }
}

/** Convenience wrapper: renders a parsed deck into a PDF buffer. */
export function renderDeck(deck: Deck, options: RenderOptions): Promise<RenderResult> {
  return new SlideRenderer(deck, options).render();
}
