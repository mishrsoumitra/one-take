/**
 * The export library: every video the server finished, remembered across restarts in one JSON file
 * (`<data dir>/exports.json`), so the app can list the videos it made, play them, show them in the
 * file manager and delete them. Only exports that went through the server are known; a file saved
 * through the browser's own save dialog never passes here.
 *
 * Paths are never taken from the client: a request names a record by id, and the record says what to
 * delete. A folder (HLS, DASH) is removed only while it holds nothing but a One Take export.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { type ExportRecord } from '@one-take/shared';

import { ApiError, fsErrorCode } from '../util/errors.js';

import { directorySize, foreignFileIn, removeQuietly } from './filesystem.js';

/** What is written to disk: the record as it was when the export finished. */
export type StoredExport = Omit<ExportRecord, 'exists'>;

interface LibraryFile {
  version: 1;
  exports: StoredExport[];
}

/** Records kept; the oldest go when there are more (the files themselves are left alone). */
const MAX_RECORDS = 1000;

export interface ExportLibraryOptions {
  log?: (message: string) => void;
}

export class ExportLibrary {
  private entries: StoredExport[] | null = null;
  /** Serialises loads and writes, so two finishing jobs never race on the file. */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly log: (message: string) => void;

  constructor(
    readonly filePath: string,
    options: ExportLibraryOptions = {},
  ) {
    this.log = options.log ?? (() => undefined);
  }

  /** Every remembered export, newest first, with whether it still exists and its size now. */
  async list(): Promise<ExportRecord[]> {
    const entries = await this.load();
    const records = await Promise.all(entries.map((e) => describe(e)));
    return records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async get(id: string): Promise<ExportRecord> {
    const entry = (await this.load()).find((e) => e.id === id);
    if (!entry) {
      throw new ApiError(404, 'export_not_found', 'This export is not in the list any more.');
    }
    return describe(entry);
  }

  /** Remembers a finished export. Errors are logged, never thrown: the export itself is fine. */
  async add(entry: StoredExport): Promise<void> {
    try {
      await this.mutate((entries) => {
        const rest = entries.filter((e) => e.id !== entry.id);
        rest.push(entry);
        rest.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
        return rest.slice(Math.max(0, rest.length - MAX_RECORDS));
      });
    } catch (error) {
      this.log(`could not record the export in ${this.filePath}: ${(error as Error).message}`);
    }
  }

  /**
   * Forgets an export and, unless told otherwise, deletes what it wrote. A file that is already gone
   * is simply forgotten. Returns the record as it was and whether anything was deleted from disk.
   */
  async remove(
    id: string,
    options: { deleteFiles: boolean },
  ): Promise<{ record: ExportRecord; deleted: boolean }> {
    const record = await this.get(id);
    let deleted = false;
    if (options.deleteFiles) {
      if (record.exists) deleted = await deleteOutput(record);
      for (const sidecar of record.sidecars) await fs.rm(sidecar, { force: true }).catch(() => undefined);
    }
    await this.mutate((entries) => entries.filter((e) => e.id !== id));
    this.log(`export ${id} ${deleted ? 'deleted' : 'forgotten'}: ${record.path}`);
    return { record, deleted };
  }

  private load(): Promise<StoredExport[]> {
    const run = this.chain.then(async () => {
      this.entries ??= await readFile(this.filePath, this.log);
      return this.entries;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private mutate(change: (entries: StoredExport[]) => StoredExport[]): Promise<void> {
    const run = this.chain.then(async () => {
      this.entries ??= await readFile(this.filePath, this.log);
      this.entries = change(this.entries);
      await writeFile(this.filePath, { version: 1, exports: this.entries });
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}

async function readFile(filePath: string, log: (m: string) => void): Promise<StoredExport[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') return [];
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LibraryFile>;
    if (!Array.isArray(parsed.exports)) throw new Error('no exports array');
    return parsed.exports.filter(isStoredExport);
  } catch (error) {
    // A damaged index must not take the server down; it is set aside and a new one starts.
    const aside = `${filePath}.damaged-${Date.now()}`;
    log(`${filePath} could not be read (${(error as Error).message}); moved to ${aside}`);
    await fs.rename(filePath, aside).catch(() => undefined);
    return [];
  }
}

/** Write to a temporary file and rename, so a crash mid-write never leaves half an index. */
async function writeFile(filePath: string, data: LibraryFile): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, filePath);
}

function isStoredExport(value: unknown): value is StoredExport {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.path === 'string' &&
    typeof v.createdAt === 'string' &&
    (v.kind === 'file' || v.kind === 'directory')
  );
}

/** The record with what the disk says now: whether it is still there and how big it is. */
async function describe(entry: StoredExport): Promise<ExportRecord> {
  // records written before sidecars existed have none
  const base = { ...entry, sidecars: Array.isArray(entry.sidecars) ? entry.sidecars : [] };
  try {
    const st = await fs.stat(entry.path);
    if (entry.kind === 'directory' ? !st.isDirectory() : !st.isFile()) {
      return { ...base, exists: false };
    }
    const bytes = st.isDirectory() ? await directorySize(entry.path) : st.size;
    return { ...base, bytes, exists: true };
  } catch {
    return { ...base, exists: false };
  }
}

async function deleteOutput(record: ExportRecord): Promise<boolean> {
  if (record.kind === 'file') {
    await fs.rm(record.path, { force: true });
    return true;
  }
  const foreign = await foreignFileIn(record.path);
  if (foreign !== null) {
    throw new ApiError(
      409,
      'folder_not_empty',
      `${record.path} now contains files that are not a One Take export (${foreign}); it was left alone. Delete it yourself if you mean to.`,
    );
  }
  await removeQuietly(record.path);
  return true;
}
