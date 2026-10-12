/**
 * Builds test fixtures: a 4-page 16:9 PDF, a 3-slide PowerPoint deck and a WAV of speech with
 * thinking pauses; for the stress run, a 12-page PDF and a sixty-second voice loop.
 *
 * The speech is real: the app's detector is a neural voice model that hears a tone as a tone, so the
 * voice comes from macOS text-to-speech (`say`), rendered once per process and cut to length.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pptxgenjs from 'pptxgenjs';

// pptxgenjs is typed as an ES default export but Node may load its CommonJS build; accept either shape.
type PptxGenJSClass = (typeof pptxgenjs)['default'];
const PptxGenJS =
  (pptxgenjs as unknown as { default?: PptxGenJSClass }).default ?? (pptxgenjs as unknown as PptxGenJSClass);

const SAMPLE_RATE = 48000;

/** A small deck with a title, bullets and a shape on every slide, like a real lecture deck in miniature. */
export async function makePptx(titles: string[]): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  titles.forEach((title, i) => {
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };
    slide.addText(title, { x: 0.5, y: 0.8, w: 9, h: 1, fontSize: 40, bold: true, color: '174374' });
    slide.addText(
      [
        { text: `Slide ${i + 1} of ${titles.length}`, options: { bullet: true, breakLine: true } },
        {
          text: 'A second point that is long enough to wrap onto the next line of the box',
          options: { bullet: true },
        },
      ],
      { x: 0.5, y: 2, w: 6, h: 2.5, fontSize: 20, color: '1A1D21' },
    );
    slide.addShape(pptx.ShapeType.ellipse, { x: 7.5, y: 2.5, w: 1.5, h: 1.5, fill: { color: '2B78BD' } });
  });
  return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
}

function pdfEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function makePdf(titles: string[]): Buffer {
  const objects: Buffer[] = [];
  const add = (b: Buffer | string) => {
    objects.push(Buffer.isBuffer(b) ? b : Buffer.from(b));
    return objects.length;
  };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const pagesId = add(''); // filled below
  const pageIds: number[] = [];
  titles.forEach((title, i) => {
    const content = `BT /F1 48 Tf 60 420 Td (${pdfEscape(title)}) Tj ET BT /F1 24 Tf 60 360 Td (Slide ${i + 1} of ${titles.length}) Tj ET`;
    const c = add(
      Buffer.concat([
        Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
        Buffer.from(content),
        Buffer.from('\nendstream'),
      ]),
    );
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 960 540] /Contents ${c} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
      ),
    );
  });
  objects[pagesId - 1] = Buffer.from(
    `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
  );
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  const offsets: number[] = [];
  let length = parts[0]?.length ?? 0;
  objects.forEach((obj, i) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), obj, Buffer.from('\nendobj\n')]);
    parts.push(chunk);
    length += chunk.length;
  });
  const xref = length;
  let trailer = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) trailer += `${String(o).padStart(10, '0')} 00000 n \n`;
  trailer += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  parts.push(Buffer.from(trailer));
  return Buffer.concat(parts);
}

/** What the voice reads; long enough that cuts of a few seconds rarely repeat. */
const LECTURE_TEXT =
  'Welcome to the lecture. Today we ask why the sky is blue. Sunlight looks white, but it is a mix of ' +
  'every colour, and the air scatters the short blue waves far more than the long red ones. That is ' +
  'Rayleigh scattering: the strength of it grows with the fourth power of the frequency, so blue light ' +
  'is thrown around the sky about five times more than red light. You might ask why the sky is not ' +
  'violet, since violet waves are shorter still. Part of the answer is the sun, which sends less violet ' +
  'than blue, and part is our eyes, which are far more sensitive to blue. At sunset the light travels a ' +
  'much longer path through the air, so most of the blue is scattered away before it reaches you, and ' +
  'what is left is orange and red. Haze and dust add their own scattering, which is why a dusty evening ' +
  'glows. On Mars the dust in the air does the opposite: the day sky is butterscotch, and the sunsets ' +
  'are blue. That is the whole story, and the rest of this lecture fills in the details, one slide at a time.';

let voiceBank: Float64Array | null | undefined;

/**
 * A lecturer's voice, from macOS text-to-speech, with the pauses between sentences shortened so a cut
 * of any length is voice almost all the way through. Null where `say` is not available: the harmonic
 * stand-in is used then, with a warning, and the detector (which listens for a human voice) will hear
 * little of it.
 */
function voice(): Float64Array | null {
  if (voiceBank !== undefined) return voiceBank;
  const file = path.join(os.tmpdir(), `one-take-voice-${process.pid}.wav`);
  const format = `--data-format=LEI16@${SAMPLE_RATE}`;
  try {
    try {
      execFileSync('say', ['-v', 'Samantha', '-o', file, format, LECTURE_TEXT], { stdio: 'ignore' });
    } catch {
      execFileSync('say', ['-o', file, format, LECTURE_TEXT], { stdio: 'ignore' });
    }
    voiceBank = tighten(readWavSamples(fs.readFileSync(file)));
  } catch (error) {
    console.warn(
      `no text-to-speech voice (${(error as Error).message}); the fixture uses a harmonic tone, which the voice model will not hear as speech`,
    );
    voiceBank = null;
  } finally {
    fs.rmSync(file, { force: true });
  }
  return voiceBank;
}

/** The samples of a 16-bit mono RIFF file as floats. */
function readWavSamples(buf: Buffer): Float64Array {
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'data') {
      const out = new Float64Array(Math.floor(size / 2));
      for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(at + 8 + i * 2) / 32768;
      return out;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('no data chunk in the voice file');
}

/** Shortens every quiet stretch longer than `maxPauseSec` to that length. */
function tighten(samples: Float64Array, maxPauseSec = 0.25): Float64Array {
  const win = Math.round(0.01 * SAMPLE_RATE);
  const keep: number[] = [];
  let quiet = 0;
  for (let at = 0; at < samples.length; at += win) {
    let sum = 0;
    for (let i = at; i < Math.min(samples.length, at + win); i++) sum += (samples[i] ?? 0) ** 2;
    const loud = Math.sqrt(sum / win) > 0.004;
    quiet = loud ? 0 : quiet + win;
    if (quiet <= maxPauseSec * SAMPLE_RATE)
      for (let i = at; i < Math.min(samples.length, at + win); i++) keep.push(samples[i] ?? 0);
  }
  return Float64Array.from(keep);
}

/** The first index at or after `from` where the voice is loud, so a cut starts on a word, not a breath. */
function nextLoud(bank: Float64Array, from: number): number {
  const win = Math.round(0.02 * SAMPLE_RATE);
  for (let k = 0; k < bank.length; k += win) {
    const at = (from + k) % bank.length;
    let sum = 0;
    for (let i = 0; i < win; i++) sum += (bank[(at + i) % bank.length] ?? 0) ** 2;
    if (Math.sqrt(sum / win) > 0.03) return at;
  }
  return from;
}

let cursor = 0;

/** `seconds` of the voice, the next stretch each time, with short fades so the cuts do not click. */
function speech(seconds: number): Float64Array {
  const bank = voice();
  if (!bank) return tone(seconds);
  const n = Math.round(seconds * SAMPLE_RATE);
  const out = new Float64Array(n);
  cursor = nextLoud(bank, cursor);
  for (let i = 0; i < n; i++) out[i] = bank[(cursor + i) % bank.length] ?? 0;
  cursor = (cursor + n) % bank.length;
  const fade = Math.round(0.01 * SAMPLE_RATE);
  for (let i = 0; i < Math.min(fade, n >> 1); i++) {
    const g = i / fade;
    out[i] = (out[i] ?? 0) * g;
    out[n - 1 - i] = (out[n - 1 - i] ?? 0) * g;
  }
  return out;
}

/** Voice-like signal: harmonic tone with vibrato, chopped into syllables (150 ms on, 60 ms off). */
function tone(seconds: number): Float64Array {
  const n = Math.round(seconds * SAMPLE_RATE);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const phase = t % 0.21;
    if (phase < 0.15) {
      const edge = Math.min(1, phase / 0.02, (0.15 - phase) / 0.02);
      const f0 = 140 + 15 * Math.sin(2 * Math.PI * 5 * t);
      let v = 0;
      for (let h = 1; h < 7; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / h;
      out[i] = (0.25 * edge * v) / 2;
    }
  }
  return out;
}

function silence(seconds: number, noise = 0.0004): Float64Array {
  const n = Math.round(seconds * SAMPLE_RATE);
  const out = new Float64Array(n);
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = ((seed / 0x7fffffff) * 2 - 1) * noise;
  }
  return out;
}

function click(seconds: number): Float64Array {
  const n = Math.round(seconds * SAMPLE_RATE);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.4 * Math.sin((2 * Math.PI * 900 * i) / SAMPLE_RATE);
  return out;
}

/** Keyboard-like typing: a 4 ms burst every 300 ms, loud enough to cross any speech line. */
function typing(seconds: number): Float64Array {
  const n = Math.round(seconds * SAMPLE_RATE);
  const out = new Float64Array(n);
  let seed = 777;
  for (let i = 0; i < n; i++) {
    const phase = (i / SAMPLE_RATE) % 0.3;
    if (phase < 0.004) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      out[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.6 * Math.exp(-phase * 800);
    }
  }
  return out;
}

export type PlanKind = 'silence' | 'speech' | 'click' | 'typing';

/**
 * Fifteen seconds: three phrases with thinking pauses, then two seconds of typing right after the
 * last phrase (a level-only detector would keep the phrase open through it), a click and silence.
 */
export const SPEECH_PLAN: [kind: PlanKind, seconds: number][] = [
  ['silence', 1.0],
  ['speech', 2.0],
  ['silence', 1.5],
  ['speech', 1.2],
  ['silence', 3.0],
  ['speech', 2.5],
  ['typing', 2.0],
  ['click', 0.1],
  ['silence', 1.7],
];

function piece(kind: PlanKind, sec: number): Float64Array {
  switch (kind) {
    case 'speech':
      return speech(sec);
    case 'click':
      return click(sec);
    case 'typing':
      return typing(sec);
    case 'silence':
      return silence(sec);
  }
}

export function makeWav(): Buffer {
  return wavFromPieces(SPEECH_PLAN.map(([kind, sec]) => piece(kind, sec)));
}

/**
 * A lecturer's voice for the stress run: `seconds` of bursts between half a second and five seconds
 * long, at varying loudness, with thinking pauses between them and the odd click. Seeded, so every
 * run hears the same. Written piece by piece into one buffer, so an hour of voice is affordable.
 *
 * The file is made long enough to be played once rather than looped: on this Chrome, stopping a
 * microphone fed by a looping capture file can deadlock the page inside `MediaStreamTrack.stop()`.
 */
export function makeStressWav(seconds = 60): Buffer {
  let seed = 987654321;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const totalSamples = Math.round(seconds * SAMPLE_RATE);
  const data = Buffer.alloc(totalSamples * 2);
  let written = 0;
  const put = (piece: Float64Array) => {
    for (const sample of piece) {
      if (written >= totalSamples) return;
      const v = Math.max(-1, Math.min(1, sample));
      data.writeInt16LE(Math.round(v * 32767), written * 2);
      written++;
    }
  };
  while (written < totalSamples) {
    put(silence(0.3 + random() * 2.2));
    if (random() < 0.08) {
      put(click(0.05 + random() * 0.1));
      put(silence(1.5));
      continue;
    }
    const gain = 0.4 + random() * 0.6;
    const burst = speech(0.5 + random() * 4.5);
    for (let i = 0; i < burst.length; i++) burst[i] = (burst[i] ?? 0) * gain;
    put(burst);
  }
  return Buffer.concat([wavHeader(data.length), data]);
}

function wavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function wavFromPieces(pieces: Float64Array[]): Buffer {
  const total = pieces.reduce((a, p) => a + p.length, 0);
  const data = Buffer.alloc(total * 2);
  let o = 0;
  for (const p of pieces) {
    for (const sample of p) {
      const v = Math.max(-1, Math.min(1, sample));
      data.writeInt16LE(Math.round(v * 32767), o);
      o += 2;
    }
  }
  return Buffer.concat([wavHeader(data.length), data]);
}

/** A twelve-page deck and `seconds` of voice for the stress run. */
export function writeStressFixtures(
  dir: string,
  seconds = 60,
): { pdf: string; wav: string; pages: number; seconds: number } {
  fs.mkdirSync(dir, { recursive: true });
  const titles = [
    'Welcome',
    'Why the sky is blue',
    'Rayleigh scattering',
    'Wavelength and intensity',
    'Why not violet?',
    'Sunsets are red',
    'Haze and dust',
    'Other planets',
    'Mars at dusk',
    'Summary',
    'Further reading',
    'Questions',
  ];
  const pdf = path.join(dir, 'lecture.pdf');
  const wav = path.join(dir, 'talk.wav');
  fs.writeFileSync(pdf, makePdf(titles));
  fs.writeFileSync(wav, makeStressWav(seconds));
  return { pdf, wav, pages: titles.length, seconds };
}

export async function writeFixtures(dir: string): Promise<{ pdf: string; pptx: string; wav: string }> {
  fs.mkdirSync(dir, { recursive: true });
  const pdf = path.join(dir, 'slides.pdf');
  const pptx = path.join(dir, 'deck.pptx');
  const wav = path.join(dir, 'speech.wav');
  fs.writeFileSync(
    pdf,
    makePdf(['Why the sky is blue', 'Rayleigh scattering', 'Sunsets are red', 'Questions']),
  );
  fs.writeFileSync(pptx, await makePptx(['Why the sky is blue', 'Rayleigh scattering', 'Questions']));
  fs.writeFileSync(wav, makeWav());
  return { pdf, pptx, wav };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const dir = process.argv[2] ?? path.resolve('packages/e2e/fixtures');
  const out = await writeFixtures(dir);
  console.log(`fixtures written: ${out.pdf}, ${out.pptx}, ${out.wav}`);
}
