/**
 * Finds installed fonts so slides can be drawn with the typeface the deck asked for. Only the `name` and
 * `OS/2` tables of each file are read, so scanning a system font folder costs a few milliseconds per
 * file rather than loading every font. pdfkit embeds the chosen file (subset) when drawing.
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface FontFace {
  file: string;
  family: string;
  subfamily: string;
  postscriptName: string;
  /** 100..900 */
  weight: number;
  italic: boolean;
}

export interface ResolvedFont {
  /** Name to register the font under with pdfkit (unique per face). */
  key: string;
  /** File to embed, or null when `key` is one of pdfkit's built-in fonts. */
  file: string | null;
  /** For TrueType collections: which face inside the file. */
  postscriptName: string | null;
}

/** Families that commonly stand in for each other, normalised (lower-case, letters and digits only). */
const ALIASES: Record<string, string[]> = {
  calibri: ['carlito'],
  calibrilight: ['calibri', 'carlito'],
  cambria: ['caladea'],
  arial: ['liberationsans', 'arimo', 'helvetica', 'helveticaneue'],
  helvetica: ['arial', 'liberationsans', 'arimo'],
  helveticaneue: ['helvetica', 'arial'],
  timesnewroman: ['liberationserif', 'tinos', 'times'],
  times: ['timesnewroman', 'liberationserif'],
  couriernew: ['liberationmono', 'cousine', 'courier'],
  segoeui: ['selawik', 'opensans', 'sfpro', 'helveticaneue', 'arial'],
  georgia: ['gelasio', 'dejavuserif'],
  verdana: ['dejavusans', 'arial'],
  tahoma: ['dejavusans', 'arial'],
  trebuchetms: ['fira sans', 'arial'],
  franklingothic: ['libre franklin', 'arial'],
  centurygothic: ['urw gothic', 'avenir', 'arial'],
  gillsans: ['gill sans', 'cabin', 'arial'],
  consolas: ['menlo', 'dejavusansmono', 'courier'],
  symbol: ['arialunicodems'],
  wingdings: ['arialunicodems'],
};

/** Tried when the deck's font is not installed; families with bold and italic faces come first. */
const GENERIC_FALLBACKS = ['arial', 'liberationsans', 'dejavusans', 'helvetica', 'arialunicodems'];

export function normalizeFamily(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* ------------------------------------------------------------------ */
/* Reading font metadata                                               */
/* ------------------------------------------------------------------ */

const NAME_FAMILY = 1;
const NAME_SUBFAMILY = 2;
const NAME_POSTSCRIPT = 6;
const NAME_TYPO_FAMILY = 16;
const NAME_TYPO_SUBFAMILY = 17;

function readAt(fd: number, offset: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, offset);
  return n === length ? buf : buf.subarray(0, n);
}

function decodeName(bytes: Buffer, platformId: number, encodingId: number): string {
  if (platformId === 3 || (platformId === 0 && encodingId <= 4)) {
    let s = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes.readUInt16BE(i));
    return s;
  }
  return bytes.toString('latin1');
}

function parseFace(fd: number, fontOffset: number, file: string): FontFace | null {
  const header = readAt(fd, fontOffset, 12);
  if (header.length < 12) return null;
  const tag = header.readUInt32BE(0);
  // 0x00010000 TrueType, 'OTTO' CFF OpenType, 'true' old Mac TrueType
  if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return null;
  const numTables = header.readUInt16BE(4);
  const directory = readAt(fd, fontOffset + 12, numTables * 16);
  let nameTable: { offset: number; length: number } | null = null;
  let os2Table: { offset: number; length: number } | null = null;
  for (let i = 0; i + 16 <= directory.length; i += 16) {
    const name = directory.toString('latin1', i, i + 4);
    const offset = directory.readUInt32BE(i + 8);
    const length = directory.readUInt32BE(i + 12);
    if (name === 'name') nameTable = { offset, length };
    else if (name === 'OS/2') os2Table = { offset, length };
  }
  if (!nameTable) return null;
  const names = readAt(fd, nameTable.offset, Math.min(nameTable.length, 1 << 20));
  if (names.length < 6) return null;
  const count = names.readUInt16BE(2);
  const stringOffset = names.readUInt16BE(4);
  const found = new Map<number, { score: number; value: string }>();
  for (let i = 0; i < count; i++) {
    const rec = 6 + i * 12;
    if (rec + 12 > names.length) break;
    const platformId = names.readUInt16BE(rec);
    const encodingId = names.readUInt16BE(rec + 2);
    const languageId = names.readUInt16BE(rec + 4);
    const nameId = names.readUInt16BE(rec + 6);
    const length = names.readUInt16BE(rec + 8);
    const offset = names.readUInt16BE(rec + 10);
    if (
      ![NAME_FAMILY, NAME_SUBFAMILY, NAME_POSTSCRIPT, NAME_TYPO_FAMILY, NAME_TYPO_SUBFAMILY].includes(nameId)
    )
      continue;
    const start = stringOffset + offset;
    if (start + length > names.length) continue;
    const value = decodeName(names.subarray(start, start + length), platformId, encodingId).trim();
    if (!value) continue;
    // prefer Windows English, then Mac Roman, then anything
    const score =
      platformId === 3 && (languageId === 0x409 || languageId === 0) ? 3 : platformId === 1 ? 2 : 1;
    const existing = found.get(nameId);
    if (!existing || score > existing.score) found.set(nameId, { score, value });
  }
  const family = found.get(NAME_TYPO_FAMILY)?.value ?? found.get(NAME_FAMILY)?.value;
  if (!family) return null;
  const subfamily = found.get(NAME_TYPO_SUBFAMILY)?.value ?? found.get(NAME_SUBFAMILY)?.value ?? 'Regular';
  let weight = /bold/i.test(subfamily) ? 700 : 400;
  let italic = /italic|oblique/i.test(subfamily);
  if (os2Table && os2Table.length >= 64) {
    const os2 = readAt(fd, os2Table.offset, 64);
    const usWeightClass = os2.readUInt16BE(4);
    if (usWeightClass >= 100 && usWeightClass <= 900) weight = usWeightClass;
    const fsSelection = os2.readUInt16BE(62);
    if (fsSelection & 1) italic = true;
  }
  return {
    file,
    family,
    subfamily,
    postscriptName: found.get(NAME_POSTSCRIPT)?.value ?? `${family}-${subfamily}`.replace(/\s+/g, ''),
    weight,
    italic,
  };
}

/** Every face in a .ttf/.otf/.ttc file, or [] when the file is not a font we can read. */
export function readFontFaces(file: string): FontFace[] {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return [];
  }
  try {
    const head = readAt(fd, 0, 12);
    if (head.length < 12) return [];
    if (head.toString('latin1', 0, 4) === 'ttcf') {
      const numFonts = head.readUInt32BE(8);
      const offsets = readAt(fd, 12, Math.min(numFonts, 64) * 4);
      const faces: FontFace[] = [];
      for (let i = 0; i + 4 <= offsets.length; i += 4) {
        const face = parseFace(fd, offsets.readUInt32BE(i), file);
        if (face) faces.push(face);
      }
      return faces;
    }
    const face = parseFace(fd, 0, file);
    return face ? [face] : [];
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

/* ------------------------------------------------------------------ */
/* The index                                                           */
/* ------------------------------------------------------------------ */

export function defaultFontDirectories(platform = process.platform, home = os.homedir()): string[] {
  if (platform === 'darwin') {
    return [
      path.join(home, 'Library', 'Fonts'),
      '/Library/Fonts',
      '/System/Library/Fonts',
      '/System/Library/Fonts/Supplemental',
      '/Applications/Microsoft PowerPoint.app/Contents/Resources/DFonts',
      '/Applications/Microsoft Word.app/Contents/Resources/DFonts',
      '/Applications/Microsoft Excel.app/Contents/Resources/DFonts',
    ];
  }
  if (platform === 'win32') {
    return [
      'C:\\Windows\\Fonts',
      path.join(
        process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'),
        'Microsoft',
        'Windows',
        'Fonts',
      ),
    ];
  }
  return [
    '/usr/share/fonts',
    '/usr/local/share/fonts',
    path.join(home, '.fonts'),
    path.join(home, '.local', 'share', 'fonts'),
  ];
}

const FONT_FILE = /\.(ttf|otf|ttc)$/i;
const BUILTIN: Record<string, { regular: string; bold: string; italic: string; boldItalic: string }> = {
  helvetica: {
    regular: 'Helvetica',
    bold: 'Helvetica-Bold',
    italic: 'Helvetica-Oblique',
    boldItalic: 'Helvetica-BoldOblique',
  },
  times: {
    regular: 'Times-Roman',
    bold: 'Times-Bold',
    italic: 'Times-Italic',
    boldItalic: 'Times-BoldItalic',
  },
  courier: {
    regular: 'Courier',
    bold: 'Courier-Bold',
    italic: 'Courier-Oblique',
    boldItalic: 'Courier-BoldOblique',
  },
};

function listFontFiles(dir: string, depth: number, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        if (depth > 0) listFontFiles(full, depth - 1, out);
      } else if (st.isFile() && FONT_FILE.test(entry) && st.size < 200 * 1024 * 1024) {
        out.push(full);
      }
    } catch {
      // unreadable entry
    }
  }
}

export class FontIndex {
  private faces = new Map<string, FontFace[]>();
  private loaded = false;
  readonly directories: string[];

  constructor(extraDirectories: string[] = [], defaults = defaultFontDirectories()) {
    this.directories = [...extraDirectories, ...defaults];
  }

  /** Scans the folders once; later calls are free. */
  load(): this {
    if (this.loaded) return this;
    this.loaded = true;
    const files: string[] = [];
    for (const dir of this.directories) listFontFiles(dir, 3, files);
    for (const file of files) {
      for (const face of readFontFaces(file)) {
        const key = normalizeFamily(face.family);
        const list = this.faces.get(key) ?? [];
        list.push(face);
        this.faces.set(key, list);
      }
    }
    return this;
  }

  /** Number of families found, for logs. */
  get familyCount(): number {
    return this.faces.size;
  }

  families(): string[] {
    return [...this.faces.keys()];
  }

  private pick(key: string, bold: boolean, italic: boolean): FontFace | null {
    const list = this.faces.get(key);
    if (!list || list.length === 0) return null;
    const target = bold ? 700 : 400;
    let best: FontFace | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const face of list) {
      const score = Math.abs(face.weight - target) + (face.italic === italic ? 0 : 1000);
      if (score < bestScore) {
        best = face;
        bestScore = score;
      }
    }
    return best;
  }

  /**
   * The best installed face for a family and style, trying common stand-ins before the generic
   * fallback; pdfkit's built-in Helvetica is the last resort and always works.
   */
  resolve(family: string | null, bold: boolean, italic: boolean): ResolvedFont {
    this.load();
    const wanted = family ? normalizeFamily(family) : '';
    const candidates = wanted ? [wanted, ...(ALIASES[wanted] ?? []).map(normalizeFamily)] : [];
    // The deck's own family wins even without the wanted weight; a stand-in must have the right style.
    let standIn: ResolvedFont | null = null;
    for (const [index, candidate] of [...candidates, ...GENERIC_FALLBACKS].entries()) {
      const face = this.pick(candidate, bold, italic);
      if (face) {
        const resolved: ResolvedFont = {
          key: `${face.family} ${face.subfamily}`.replace(/\s+/g, ' '),
          file: face.file,
          postscriptName:
            FONT_FILE.exec(face.file)?.[1]?.toLowerCase() === 'ttc' ? face.postscriptName : null,
        };
        const exactStyle = face.italic === italic && (bold ? face.weight >= 600 : face.weight < 600);
        if (index === 0 || exactStyle) return resolved;
        standIn ??= resolved;
        continue;
      }
      const builtin = BUILTIN[candidate];
      if (builtin) return standIn ?? builtinFont(builtin, bold, italic);
    }
    return standIn ?? builtinFont(BUILTIN.helvetica ?? HELVETICA, bold, italic);
  }
}

const HELVETICA = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique',
  boldItalic: 'Helvetica-BoldOblique',
};

function builtinFont(
  builtin: { regular: string; bold: string; italic: string; boldItalic: string },
  bold: boolean,
  italic: boolean,
): ResolvedFont {
  const key =
    bold && italic ? builtin.boldItalic : bold ? builtin.bold : italic ? builtin.italic : builtin.regular;
  return { key, file: null, postscriptName: null };
}
