/**
 * Recordings on disk: every recording the app mirrors to this computer, one folder each under the
 * recordings folder (`<data dir>/recordings` unless told otherwise):
 *
 *     <id>/recording.json          the manifest: the deck, every phrase with its hash, the order,
 *                                  the slide, the sittings, the settings
 *     <id>/deck/0000-slides.pdf    the deck's files, as the app renders slides from them
 *     <id>/phrases/<phrase>.phrase one file per phrase or drawing, in the app's own format
 *
 * Every upload is hashed as it streams in and written to a temporary name first; the hash the app
 * expected (a header) has to match before the file is renamed into place, so a phrase that did not
 * arrive whole is never kept. The manifest is written whole and renamed into place too, and one
 * that cannot be read is skipped in the list rather than taking the server down. Writes to one
 * recording's manifest are serialised; files of different phrases land in parallel.
 *
 * Nothing here takes a path from the client: a request names a recording and a phrase by id, and
 * the ids are kept to a safe alphabet (see shared/recordings.ts).
 */
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  PhraseMetaSchema,
  RECORDING_ID,
  RecordingDeckSchema,
  RecordingIdSchema,
  RecordingSittingSchema,
  sanitizeFileName,
  Sha256Schema,
  type CreateRecording,
  type PhraseMeta,
  type RecordingPhrase,
  type RecordingRecord,
  type RecordingSummary,
  type UpdateRecording,
  type UploadReceipt,
} from '@one-take/shared';
import { z } from 'zod';

import { ApiError, fsErrorCode } from '../util/errors.js';

import { removeQuietly } from './filesystem.js';

export const MANIFEST_NAME = 'recording.json';
export const DECK_DIR = 'deck';
export const PHRASES_DIR = 'phrases';
export const PHRASE_EXTENSION = '.phrase';

const StoredPhraseSchema = PhraseMetaSchema.extend({
  id: RecordingIdSchema,
  sha256: Sha256Schema,
  bytes: z.int().min(0),
});

/** The manifest as it is on disk. */
const StoredRecordingSchema = z.object({
  version: z.literal(1),
  id: RecordingIdSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  deck: RecordingDeckSchema,
  /** Which of the deck's files have landed, by index. */
  deckStored: z.array(z.int().min(0)),
  phrases: z.record(z.string(), StoredPhraseSchema),
  order: z.array(z.string()),
  current: z.int().min(0),
  sitting: z.int().min(1),
  sittings: z.array(RecordingSittingSchema),
  settings: z.record(z.string(), z.number()),
  exportRequest: z.unknown(),
  counter: z.int().min(0),
});
type StoredRecording = z.infer<typeof StoredRecordingSchema>;

export interface RecordingStoreOptions {
  log?: (message: string) => void;
  /** The clock, for tests. */
  now?: () => Date;
}

function assertId(id: string, what: string): void {
  if (!RECORDING_ID.test(id)) throw ApiError.badRequest(`Not a valid ${what} id: ${JSON.stringify(id)}`);
}

/** `20261102-153012-1a2b3c4d5e6f`: when it was made, then a hash of the deck, the moment and a random part. */
export function makeRecordingId(now: Date, deckHash: string): string {
  const iso = now.toISOString();
  const stamp = iso.slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const tag = createHash('sha256').update(`${deckHash}\n${iso}\n${randomUUID()}`).digest('hex').slice(0, 12);
  return `${stamp}-${tag}`;
}

function deckFileName(index: number, name: string): string {
  return `${String(index).padStart(4, '0')}-${sanitizeFileName(name, 'file')}`;
}

export class RecordingStore {
  private readonly cache = new Map<string, StoredRecording>();
  /** One write at a time per recording, so two phrases landing together never race on the manifest. */
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly log: (message: string) => void;
  private readonly now: () => Date;

  constructor(
    readonly dir: string,
    options: RecordingStoreOptions = {},
  ) {
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
  }

  folder(id: string): string {
    assertId(id, 'recording');
    return path.join(this.dir, id);
  }

  /** Every recording that can be read, newest first. A folder without a readable manifest is skipped and logged. */
  async list(): Promise<RecordingSummary[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch (error) {
      if (fsErrorCode(error) === 'ENOENT') return [];
      throw error;
    }
    const out: RecordingSummary[] = [];
    for (const name of names) {
      if (!RECORDING_ID.test(name)) continue;
      try {
        out.push(summarize(await this.load(name), this.folder(name)));
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) continue; // a folder of ours without a manifest
        this.log(`recording ${name} skipped: ${(error as Error).message}`);
      }
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  async get(id: string): Promise<RecordingRecord> {
    return describe(await this.load(id), this.folder(id));
  }

  /** A new recording: the folder, the manifest, and the deck's files copied from another recording when asked. */
  async create(input: CreateRecording): Promise<RecordingRecord> {
    const now = this.now();
    const id = makeRecordingId(now, input.deck.hash);
    const folder = this.folder(id);
    const at = now.toISOString();
    const rec: StoredRecording = {
      version: 1,
      id,
      createdAt: at,
      updatedAt: at,
      deck: input.deck,
      deckStored: [],
      phrases: {},
      order: [],
      current: 0,
      sitting: 1,
      sittings: input.sittings ?? [{ n: 1, startedAt: at, fromSlide: 0 }],
      settings: input.settings ?? {},
      exportRequest: null,
      counter: 0,
    };
    await fs.mkdir(path.join(folder, DECK_DIR), { recursive: true });
    await fs.mkdir(path.join(folder, PHRASES_DIR), { recursive: true });
    if (input.deckFrom !== undefined) {
      const source = await this.load(input.deckFrom);
      const same =
        source.deck.files.length === input.deck.files.length &&
        source.deck.files.every((f, i) => {
          const g = input.deck.files[i];
          return g?.sha256 === f.sha256 && g.bytes === f.bytes;
        });
      if (!same) {
        await removeQuietly(folder);
        throw ApiError.conflict(
          'deck_differs',
          'The other recording holds a different deck; upload this one.',
        );
      }
      for (const index of source.deckStored) {
        const file = source.deck.files[index];
        if (!file) continue;
        await fs.copyFile(
          path.join(this.folder(source.id), DECK_DIR, deckFileName(index, file.name)),
          path.join(folder, DECK_DIR, deckFileName(index, file.name)),
        );
        rec.deckStored.push(index);
      }
    }
    await writeManifest(folder, rec);
    this.cache.set(id, rec);
    this.log(`recording ${id} created for ${input.deck.name} (${input.deck.slides} slides) in ${folder}`);
    return describe(rec, folder);
  }

  /** The project state: whatever fields the app sent replace what was there. */
  update(id: string, patch: UpdateRecording): Promise<RecordingRecord> {
    return this.mutate(id, (rec) => {
      if (patch.order !== undefined) rec.order = patch.order;
      if (patch.current !== undefined) rec.current = patch.current;
      if (patch.sitting !== undefined) rec.sitting = patch.sitting;
      if (patch.sittings !== undefined) rec.sittings = patch.sittings;
      if (patch.settings !== undefined) rec.settings = patch.settings;
      if (patch.exportRequest !== undefined) rec.exportRequest = patch.exportRequest;
      if (patch.counter !== undefined) rec.counter = patch.counter;
    });
  }

  /** One of the deck's files, as listed in the manifest; its size and hash must match what was announced. */
  async writeDeckFile(
    id: string,
    index: number,
    body: Readable,
    expected: string | null,
  ): Promise<UploadReceipt> {
    const rec = await this.load(id);
    const file = Number.isInteger(index) ? rec.deck.files[index] : undefined;
    if (!file) throw ApiError.badRequest(`The deck has no file ${index}`);
    if (expected !== null && expected !== file.sha256) {
      throw ApiError.conflict('hash_mismatch', `Deck file ${index} was announced with another hash.`);
    }
    const dest = path.join(this.folder(id), DECK_DIR, deckFileName(index, file.name));
    const landed = await receive(dest, body, file.sha256);
    if (landed.bytes !== file.bytes) {
      await removeQuietly(dest);
      throw ApiError.conflict(
        'size_mismatch',
        `Deck file ${index} is ${landed.bytes} bytes; ${file.bytes} were announced.`,
      );
    }
    await this.mutate(id, (r) => {
      if (!r.deckStored.includes(index)) r.deckStored.push(index);
    });
    return { id: String(index), ...landed };
  }

  /** Where a deck file is, with what it is; 404 until it has been uploaded. */
  async deckFile(
    id: string,
    index: number,
  ): Promise<{ path: string; name: string; type: string; bytes: number }> {
    const rec = await this.load(id);
    const file = Number.isInteger(index) ? rec.deck.files[index] : undefined;
    if (!file || !rec.deckStored.includes(index)) {
      throw new ApiError(404, 'deck_file_missing', `The deck's file ${index} is not here.`);
    }
    return {
      path: path.join(this.folder(id), DECK_DIR, deckFileName(index, file.name)),
      name: file.name,
      type: file.type,
      bytes: file.bytes,
    };
  }

  /** A phrase's file, hashed as it lands; a second upload of the same id replaces the first. */
  async writePhrase(
    id: string,
    phraseId: string,
    meta: PhraseMeta,
    body: Readable,
    expected: string | null,
  ): Promise<RecordingPhrase> {
    assertId(phraseId, 'phrase');
    await this.load(id);
    const dest = path.join(this.folder(id), PHRASES_DIR, `${phraseId}${PHRASE_EXTENSION}`);
    const landed = await receive(dest, body, expected);
    const phrase: RecordingPhrase = { id: phraseId, ...landed, ...meta };
    await this.mutate(id, (rec) => {
      rec.phrases[phraseId] = phrase;
      if (!rec.order.includes(phraseId)) rec.order.push(phraseId);
    });
    return phrase;
  }

  async phraseFile(id: string, phraseId: string): Promise<{ path: string; phrase: RecordingPhrase }> {
    assertId(phraseId, 'phrase');
    const rec = await this.load(id);
    const phrase = rec.phrases[phraseId];
    if (!phrase) throw new ApiError(404, 'phrase_not_found', 'This phrase is not in the recording.');
    return { path: path.join(this.folder(id), PHRASES_DIR, `${phraseId}${PHRASE_EXTENSION}`), phrase };
  }

  /** Forgets a phrase and deletes its file; a phrase that is not there is no error. */
  async deletePhrase(id: string, phraseId: string): Promise<RecordingRecord> {
    assertId(phraseId, 'phrase');
    const record = await this.mutate(id, (rec) => {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the phrases are a map keyed by id
      delete rec.phrases[phraseId];
      rec.order = rec.order.filter((x) => x !== phraseId);
    });
    await removeQuietly(path.join(this.folder(id), PHRASES_DIR, `${phraseId}${PHRASE_EXTENSION}`));
    return record;
  }

  /** Deletes the recording's folder with everything in it. */
  async remove(id: string): Promise<void> {
    const folder = this.folder(id);
    await this.load(id);
    await this.mutate(id, () => undefined); // after any write still on its way
    await fs.rm(folder, { recursive: true, force: true });
    this.cache.delete(id);
    this.chains.delete(id);
    this.log(`recording ${id} deleted: ${folder}`);
  }

  private async load(id: string): Promise<StoredRecording> {
    const folder = this.folder(id);
    const cached = this.cache.get(id);
    if (cached) {
      // the folder may have been deleted by hand since it was read
      try {
        await fs.access(path.join(folder, MANIFEST_NAME));
        return cached;
      } catch {
        this.cache.delete(id);
        this.chains.delete(id);
      }
    }
    let raw: string;
    try {
      raw = await fs.readFile(path.join(folder, MANIFEST_NAME), 'utf8');
    } catch (error) {
      if (fsErrorCode(error) === 'ENOENT') {
        throw new ApiError(404, 'recording_not_found', 'This recording is not on this computer any more.');
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`${MANIFEST_NAME} is not JSON (${(error as Error).message})`, { cause: error });
    }
    const checked = StoredRecordingSchema.safeParse(parsed);
    if (!checked.success) throw new Error(`${MANIFEST_NAME} is not a recording manifest`);
    if (checked.data.id !== id) throw new Error(`${MANIFEST_NAME} belongs to ${checked.data.id}`);
    this.cache.set(id, checked.data);
    return checked.data;
  }

  /** Changes the manifest under the recording's lock and writes it; returns the recording as it stands. */
  private mutate(id: string, change: (rec: StoredRecording) => void): Promise<RecordingRecord> {
    const folder = this.folder(id);
    const run = (this.chains.get(id) ?? Promise.resolve()).then(async () => {
      const rec = await this.load(id);
      change(rec);
      rec.updatedAt = this.now().toISOString();
      await writeManifest(folder, rec);
      return describe(rec, folder);
    });
    this.chains.set(
      id,
      run.catch(() => undefined),
    );
    return run;
  }
}

/** Streams `body` into `dest` through a hash; keeps it only when the hash is the one expected. */
async function receive(
  dest: string,
  body: Readable,
  expected: string | null,
): Promise<{ sha256: string; bytes: number }> {
  const tmp = `${dest}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const hash = createHash('sha256');
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await pipeline(body, counter, createWriteStream(tmp));
  } catch (error) {
    await removeQuietly(tmp);
    throw error;
  }
  const sha256 = hash.digest('hex');
  if (expected !== null && expected !== sha256) {
    await removeQuietly(tmp);
    throw ApiError.conflict(
      'hash_mismatch',
      `The upload arrived with hash ${sha256.slice(0, 12)}…, not ${expected.slice(0, 12)}…: it was not kept.`,
    );
  }
  await fs.rename(tmp, dest);
  return { sha256, bytes };
}

/** The manifest, written whole and renamed into place. */
async function writeManifest(folder: string, rec: StoredRecording): Promise<void> {
  const file = path.join(folder, MANIFEST_NAME);
  const tmp = `${file}.tmp`;
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(rec, null, 2));
  await fs.rename(tmp, file);
}

function deckBytes(rec: StoredRecording): number {
  let n = 0;
  for (const index of rec.deckStored) n += rec.deck.files[index]?.bytes ?? 0;
  return n;
}

/** The phrases in playback order: the manifest's order first, then any the order does not name, oldest first. */
function orderedPhrases(rec: StoredRecording): RecordingPhrase[] {
  const seen = new Set<string>();
  const out: RecordingPhrase[] = [];
  for (const id of rec.order) {
    const p = rec.phrases[id];
    if (p && !seen.has(id)) {
      seen.add(id);
      out.push(p);
    }
  }
  const rest = Object.values(rec.phrases)
    .filter((p) => !seen.has(p.id))
    .sort((a, b) => a.createdAt - b.createdAt);
  return out.concat(rest);
}

function describe(rec: StoredRecording, folder: string): RecordingRecord {
  const phrases = orderedPhrases(rec);
  return {
    id: rec.id,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    deck: rec.deck,
    deckReady: rec.deckStored.length >= rec.deck.files.length,
    phrases,
    order: rec.order,
    current: rec.current,
    sitting: rec.sitting,
    sittings: rec.sittings,
    settings: rec.settings,
    exportRequest: rec.exportRequest ?? null,
    counter: rec.counter,
    path: folder,
    bytes: deckBytes(rec) + phrases.reduce((n, p) => n + p.bytes, 0),
  };
}

export function summarize(rec: StoredRecording, folder: string): RecordingSummary {
  const phrases = Object.values(rec.phrases);
  return {
    id: rec.id,
    name: rec.deck.name,
    deckHash: rec.deck.hash,
    slides: rec.deck.slides,
    deckReady: rec.deckStored.length >= rec.deck.files.length,
    phrases: phrases.length,
    seconds: phrases.reduce((n, p) => n + p.seconds, 0),
    current: rec.current,
    lastSlide: phrases.reduce((m, p) => Math.max(m, p.slide), -1),
    sittings: rec.sittings.length,
    camera: phrases.some((p) => p.camera),
    ink: phrases.some((p) => p.kind === 'ink'),
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    bytes: deckBytes(rec) + phrases.reduce((n, p) => n + p.bytes, 0),
    path: folder,
  };
}
