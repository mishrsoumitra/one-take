import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type DirectoryEntry, type DirectoryListing } from '@one-take/shared';

import { ApiError, fsErrorCode } from '../util/errors.js';

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function normalizeDirectory(input: string): string {
  const expanded = expandHome(input.trim());
  if (!path.isAbsolute(expanded)) {
    throw ApiError.badRequest('Please give an absolute folder path, such as /Users/you/Movies.');
  }
  return path.resolve(expanded);
}

export async function freeBytes(dir: string): Promise<number | null> {
  try {
    const stats = await fs.statfs(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

export async function isWritableDirectory(dir: string): Promise<boolean> {
  try {
    const st = await fs.stat(dir);
    if (!st.isDirectory()) return false;
    await fs.access(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function listDirectory(dir: string, includeFiles: boolean): Promise<DirectoryListing> {
  const resolved = normalizeDirectory(dir);
  const parent = path.dirname(resolved) === resolved ? null : path.dirname(resolved);
  let dirents;
  try {
    dirents = await fs.readdir(resolved, { withFileTypes: true });
  } catch (error) {
    const code = fsErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { path: resolved, parent, exists: false, writable: false, freeBytes: null, entries: [] };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return { path: resolved, parent, exists: true, writable: false, freeBytes: null, entries: [] };
    }
    throw error;
  }
  const entries: DirectoryEntry[] = [];
  for (const d of dirents) {
    if (d.name.startsWith('.')) continue;
    const full = path.join(resolved, d.name);
    if (d.isDirectory()) {
      entries.push({ name: d.name, path: full, kind: 'directory', bytes: null, modifiedAt: null });
    } else if (includeFiles && d.isFile()) {
      try {
        const st = await fs.stat(full);
        entries.push({
          name: d.name,
          path: full,
          kind: 'file',
          bytes: st.size,
          modifiedAt: st.mtime.toISOString(),
        });
      } catch {
        // The file vanished between readdir and stat; skip it.
      }
    }
  }
  entries.sort((a, b) =>
    a.kind === b.kind
      ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      : a.kind === 'directory'
        ? -1
        : 1,
  );
  return {
    path: resolved,
    parent,
    exists: true,
    writable: await isWritableDirectory(resolved),
    freeBytes: await freeBytes(resolved),
    entries,
  };
}

export async function makeDirectory(dir: string): Promise<string> {
  const resolved = normalizeDirectory(dir);
  await fs.mkdir(resolved, { recursive: true });
  return resolved;
}

/** Folders worth one click in the folder picker; only those that exist are returned. */
export async function shortcutDirectories(
  defaultDirectory: string,
): Promise<{ label: string; path: string }[]> {
  const home = os.homedir();
  const candidates = [
    { label: 'One Take', path: defaultDirectory },
    { label: 'Home', path: home },
    { label: 'Desktop', path: path.join(home, 'Desktop') },
    { label: 'Documents', path: path.join(home, 'Documents') },
    { label: 'Movies', path: path.join(home, 'Movies') },
    { label: 'Videos', path: path.join(home, 'Videos') },
    { label: 'Downloads', path: path.join(home, 'Downloads') },
  ];
  const out: { label: string; path: string }[] = [];
  for (const c of candidates) {
    try {
      if ((await fs.stat(c.path)).isDirectory() && !out.some((o) => o.path === c.path)) out.push(c);
    } catch {
      // not present on this machine
    }
  }
  return out;
}

/** `name.ext` or `name (2).ext`, `name (3).ext`... whichever does not exist yet. */
export async function uniquePath(dir: string, baseName: string, extension: string | null): Promise<string> {
  for (let n = 1; n < 10_000; n++) {
    const suffix = n === 1 ? '' : ` (${n})`;
    const candidate = path.join(
      dir,
      extension ? `${baseName}${suffix}.${extension}` : `${baseName}${suffix}`,
    );
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new ApiError(500, 'too_many_files', `Could not find a free file name for ${baseName} in ${dir}`);
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function removeQuietly(p: string): Promise<void> {
  try {
    await fs.rm(p, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

export async function directorySize(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += await directorySize(full);
    else if (e.isFile()) total += (await fs.stat(full)).size;
  }
  return total;
}
