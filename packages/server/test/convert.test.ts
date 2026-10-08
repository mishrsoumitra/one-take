import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import pptxgenjs from 'pptxgenjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readBody } from '../src/routes/convert.js';
import { convertPptxToPdf, PptxConverter } from '../src/services/convert.js';
import { FontIndex, normalizeFamily, readFontFaces } from '../src/services/pptx/fonts.js';
import { parseColor, presetPath, scalePath, shade, straightLine } from '../src/services/pptx/geometry.js';
import {
  decodeEntities,
  parseLength,
  parseStyle,
  parseTextHtml,
  paragraphsToText,
  type RunStyle,
} from '../src/services/pptx/html.js';
import { fitText, layoutText, type Measurer } from '../src/services/pptx/layout.js';

// pptxgenjs is typed as an ES default export but may load as CommonJS; accept either shape.
type PptxGenJSClass = (typeof pptxgenjs)['default'];
const PptxGenJS =
  (pptxgenjs as unknown as { default?: PptxGenJSClass }).default ?? (pptxgenjs as unknown as PptxGenJSClass);

describe('text html', () => {
  it('decodes entities and treats nbsp as a plain space', () => {
    expect(decodeEntities('a&nbsp;b &amp; &lt;c&gt; &#8217;s &#x2014;')).toBe('a b & <c> ’s —');
  });

  it('parses styles and lengths', () => {
    expect(parseStyle('color: #fff; font-size: 18pt;')).toEqual({ color: '#fff', 'font-size': '18pt' });
    expect(parseLength('18pt')).toBe(18);
    expect(parseLength('24px')).toBe(18);
    expect(parseLength('2em', 10)).toBe(20);
    expect(parseLength('nope')).toBeNull();
  });

  it('turns pptxtojson markup into paragraphs of runs', () => {
    const html =
      '<p style="text-align: center;line-height: 1.12;margin-top: 6pt;"><span style="color: #174374;font-size: 22pt;font-family: Mona Sans;font-weight: bold;">Think&nbsp;of&nbsp;</span><span style="font-size: 22pt;font-style: italic;text-decoration: underline;">something</span></p>' +
      '<ul><li><p><span style="font-size: 18pt;">First<br>point</span></p></li><li><p><span style="font-size: 18pt;">Second</span></p></li></ul>' +
      '<ol><li><p><span>One</span></p></li></ol><p><span>&nbsp;</span></p>';
    const paragraphs = parseTextHtml(html);
    expect(paragraphs).toHaveLength(5);
    const [first, second, third, fourth, fifth] = paragraphs;
    expect(first?.align).toBe('center');
    expect(first?.lineHeight).toBeCloseTo(1.12);
    expect(first?.spaceBefore).toBe(6);
    expect(first?.runs.map((r) => r.text)).toEqual(['Think of ', 'something']);
    expect(first?.runs[0]?.style).toMatchObject({
      bold: true,
      fontSize: 22,
      fontFamily: 'Mona Sans',
      color: '#174374',
    });
    expect(first?.runs[1]?.style).toMatchObject({ italic: true, underline: true, bold: false });
    expect(second?.bullet).toEqual({ kind: 'bullet', index: 1, level: 1 });
    expect(second?.runs.map((r) => r.text)).toEqual(['First', '\n', 'point']);
    expect(third?.bullet).toEqual({ kind: 'bullet', index: 2, level: 1 });
    expect(fourth?.bullet).toEqual({ kind: 'number', index: 1, level: 1 });
    expect(fifth?.runs).toHaveLength(1);
    expect(paragraphsToText(paragraphs)).toBe('Think of something\nFirst\npoint\nSecond\nOne\n ');
  });

  it('keeps text that is not wrapped in tags', () => {
    expect(paragraphsToText(parseTextHtml('plain words'))).toBe('plain words');
    expect(parseTextHtml('')).toEqual([]);
  });
});

describe('geometry', () => {
  it('parses colours with alpha', () => {
    expect(parseColor('#abc')).toEqual({ hex: '#aabbcc', alpha: 1 });
    expect(parseColor('#FFFFFF09')).toEqual({ hex: '#ffffff', alpha: 9 / 255 });
    expect(parseColor('rgba(255, 0, 0, 0.5)')).toEqual({ hex: '#ff0000', alpha: 0.5 });
    expect(parseColor('transparent')).toBeNull();
    expect(parseColor('')).toBeNull();
    expect(shade('#808080', 0.5)).toBe('#c0c0c0');
  });

  it('scales paths on the numbers, including arcs and relative commands', () => {
    expect(scalePath('M 0 0 L 10 5 Z', 2, 4, 100, 200)).toBe('M 100 200 L 120 220 Z');
    expect(scalePath('M0,0 10,10', 1, 1)).toBe('M 0 0 L 10 10');
    expect(scalePath('m 0 0 l 10 10', 2, 2, 5, 5)).toBe('m 0 0 l 20 20');
    expect(scalePath('M 0 30 A 30 30 0 1 0 60 30', 0.5, 2)).toBe('M 0 60 A 15 60 0 1 0 30 60');
    expect(scalePath('M 0 0 H 10 V 10', 2, 3, 1, 1)).toBe('M 1 1 H 21 V 31');
    expect(straightLine('M 0 0 L 10 10')).toEqual({ start: { x: 0, y: 0 }, end: { x: 10, y: 10 } });
    expect(straightLine('M 0 0 L 10 10 L 20 0')).toBeNull();
    expect(presetPath('ellipse', 10, 10)).toContain('A 5 5');
    expect(presetPath('rect', 10, 10)).toBeNull();
  });
});

/** Every character is 0.5 em wide, descent is a fifth of the size: easy numbers for the layout tests. */
const ruler: Measurer = {
  width: (text, style) => text.length * style.fontSize * 0.5 + style.letterSpacing * text.length,
  descent: (style) => style.fontSize * 0.2,
};

const plain = (text: string, fontSize = 10): { text: string; style: RunStyle } => ({
  text,
  style: {
    fontFamily: null,
    fontSize,
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    color: null,
    letterSpacing: 0,
    highlight: null,
    shift: null,
  },
});

describe('layout', () => {
  it('wraps words greedily and keeps line boxes at 1.2 times the font size', () => {
    const block = layoutText(
      [
        {
          runs: [plain('aaa bbb ccc')],
          align: 'left',
          lineHeight: 1,
          spaceBefore: 0,
          spaceAfter: 0,
          marginLeft: 0,
          textIndent: 0,
          bullet: null,
        },
      ],
      36, // fits "aaa bbb" (35 wide) but not the third word
      ruler,
      { wrap: true },
    );
    expect(block.lines.map((l) => l.runs.map((r) => r.text).join(''))).toEqual(['aaa bbb', 'ccc']);
    expect(block.lines[0]?.height).toBeCloseTo(12);
    expect(block.lines[0]?.baseline).toBeCloseTo(10);
    expect(block.height).toBeCloseTo(24);
  });

  it('centres, indents bullets and honours forced breaks', () => {
    const block = layoutText(
      [
        {
          runs: [plain('ab'), { ...plain('\n') }, plain('cd')],
          align: 'center',
          lineHeight: 1,
          spaceBefore: 0,
          spaceAfter: 0,
          marginLeft: 0,
          textIndent: 0,
          bullet: { kind: 'bullet', index: 1, level: 1 },
        },
      ],
      100,
      ruler,
      { wrap: true },
    );
    expect(block.lines).toHaveLength(2);
    expect(block.lines[0]?.bullet?.text).toBe('•');
    expect(block.lines[0]?.bullet?.x).toBe(0);
    // text area starts after the 27 pt hanging indent and "ab" (10 wide) is centred in the remaining 73
    expect(block.lines[0]?.runs[0]?.x).toBeCloseTo(27 + (73 - 10) / 2);
    expect(block.lines[1]?.bullet).toBeNull();
  });

  it('breaks words that are too long and shrinks text to fit when allowed', () => {
    const paragraphs = [
      {
        runs: [plain('abcdefghij', 20)],
        align: 'left' as const,
        lineHeight: 1,
        spaceBefore: 0,
        spaceAfter: 0,
        marginLeft: 0,
        textIndent: 0,
        bullet: null,
      },
    ];
    const wrapped = layoutText(paragraphs, 50, ruler, { wrap: true });
    expect(wrapped.lines.length).toBe(2);
    const fitted = fitText(paragraphs, 50, 30, ruler, { wrap: true, shrinkToFit: true });
    expect(fitted.scale).toBeLessThan(1);
    expect(fitted.height).toBeLessThanOrEqual(30.5);
    const unwrapped = layoutText(paragraphs, 50, ruler, { wrap: false });
    expect(unwrapped.lines.length).toBe(1);
  });
});

describe('fonts', () => {
  it('normalises family names and always resolves to something', () => {
    expect(normalizeFamily('Times New Roman')).toBe('timesnewroman');
    const index = new FontIndex([], []); // no folders at all
    expect(index.resolve('Calibri', true, false)).toEqual({
      key: 'Helvetica-Bold',
      file: null,
      postscriptName: null,
    });
    expect(index.resolve(null, false, true).key).toBe('Helvetica-Oblique');
    expect(index.resolve('Courier New', false, false).key).toBe('Courier');
    expect(readFontFaces('/definitely/not/a/font.ttf')).toEqual([]);
  });

  it('reads real font files when the machine has any', () => {
    const index = new FontIndex().load();
    if (index.familyCount === 0) return;
    const face = index.resolve(index.families()[0] ?? '', false, false);
    expect(face.file).not.toBeNull();
  });
});

describe('convert', () => {
  let tmp: string;
  let deck: Buffer;

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'one-take-convert-'));
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_16x9';
    const titles = ['Why the sky is blue', 'Rayleigh scattering', 'Questions'];
    titles.forEach((title, i) => {
      const slide = pptx.addSlide();
      slide.background = { color: i === 0 ? '1B212C' : 'FFFFFF' };
      slide.addText(title, {
        x: 0.5,
        y: 1,
        w: 9,
        h: 1,
        fontSize: 40,
        bold: true,
        color: i === 0 ? 'FFFFFF' : '174374',
      });
      slide.addText(
        [
          { text: 'First point', options: { bullet: true, breakLine: true } },
          {
            text: 'Second point with a longer sentence that has to wrap onto a second line',
            options: { bullet: true },
          },
        ],
        { x: 0.5, y: 2.2, w: 6, h: 2, fontSize: 18, color: i === 0 ? 'FFFFFF' : '1A1D21' },
      );
      slide.addShape(pptx.ShapeType.ellipse, { x: 7.5, y: 2.5, w: 1.5, h: 1.5, fill: { color: '2B78BD' } });
      if (i === 1) {
        slide.addTable(
          [
            [{ text: 'Colour' }, { text: 'Wavelength' }],
            [{ text: 'Blue' }, { text: '450 nm' }],
          ],
          { x: 0.5, y: 4, w: 5, colW: [2.5, 2.5], border: { type: 'solid', color: '999999', pt: 1 } },
        );
        slide.addChart(
          pptx.ChartType.bar,
          [{ name: 'Scatter', labels: ['Red', 'Green', 'Blue'], values: [1, 2, 5] }],
          {
            x: 6,
            y: 4,
            w: 3.5,
            h: 1.4,
          },
        );
      }
    });
    deck = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
  });

  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('renders a generated deck into a PDF with one page per slide', async () => {
    const result = await convertPptxToPdf(deck, { title: 'Test deck' });
    expect(result.pages).toBe(3);
    expect(result.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const text = result.pdf.toString('latin1');
    expect((text.match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(3);
    expect(text).toContain('/MediaBox [0 0 720 405]');
    expect(result.warnings).toEqual([]);
    await fs.writeFile(path.join(tmp, 'deck.pdf'), result.pdf);
  });

  it('runs through the converter service with its queue', async () => {
    const converter = new PptxConverter({ inline: true });
    const [a, b] = await Promise.all([converter.convert(deck, 'a.pptx'), converter.convert(deck, 'b.ppsx')]);
    expect(a.pages).toBe(3);
    expect(b.pages).toBe(3);
    await expect(converter.convert(deck, 'nope.key')).rejects.toMatchObject({ code: 'unsupported_file' });
    await expect(converter.convert(Buffer.from('garbage'), 'x.pptx')).rejects.toMatchObject({
      code: 'unreadable_presentation',
    });
    await converter.dispose();
  });

  it('limits the size of uploads', async () => {
    await expect(readBody(Readable.from([Buffer.alloc(6), Buffer.alloc(6)]), 10)).rejects.toMatchObject({
      status: 413,
    });
    const ok = await readBody(Readable.from([Buffer.from('ab'), Buffer.from('cd')]), 10);
    expect(ok.toString()).toBe('abcd');
  });
});
