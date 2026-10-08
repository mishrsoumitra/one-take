/** Builds test fixtures: a 4-page 16:9 PDF and a WAV that imitates speech with thinking pauses. */
import fs from 'node:fs';
import path from 'node:path';

const SAMPLE_RATE = 48000;

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

/** Voice-like signal: harmonic tone with vibrato, chopped into syllables (150 ms on, 60 ms off). */
function speech(seconds: number): Float64Array {
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

export const SPEECH_PLAN: [kind: 'silence' | 'speech' | 'click', seconds: number][] = [
  ['silence', 1.0],
  ['speech', 2.0],
  ['silence', 1.5],
  ['speech', 1.2],
  ['silence', 3.0],
  ['speech', 2.5],
  ['silence', 1.8],
  ['click', 0.1],
  ['silence', 1.9],
];

export function makeWav(): Buffer {
  const pieces = SPEECH_PLAN.map(([kind, sec]) =>
    kind === 'speech' ? speech(sec) : kind === 'click' ? click(sec) : silence(sec),
  );
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
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
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
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function writeFixtures(dir: string): { pdf: string; wav: string } {
  fs.mkdirSync(dir, { recursive: true });
  const pdf = path.join(dir, 'slides.pdf');
  const wav = path.join(dir, 'speech.wav');
  fs.writeFileSync(
    pdf,
    makePdf(['Why the sky is blue', 'Rayleigh scattering', 'Sunsets are red', 'Questions']),
  );
  fs.writeFileSync(wav, makeWav());
  return { pdf, wav };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const dir = process.argv[2] ?? path.resolve('packages/e2e/fixtures');
  const out = writeFixtures(dir);
  console.log(`fixtures written: ${out.pdf}, ${out.wav}`);
}
