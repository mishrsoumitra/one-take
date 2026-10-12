import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ExportLibrary, type StoredExport } from '../src/services/library.js';

let tmp: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'one-take-library-'));
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function entry(id: string, filePath: string, overrides: Partial<StoredExport> = {}): StoredExport {
  return {
    id,
    createdAt: `2026-10-12T10:00:0${id.slice(-1)}.000Z`,
    path: filePath,
    directory: path.dirname(filePath),
    fileName: path.basename(filePath),
    kind: 'file',
    container: 'mp4',
    bytes: 3,
    durationSec: 12,
    width: 1280,
    height: 720,
    fps: 15,
    videoCodec: 'avc',
    audioCodec: 'aac',
    encoder: null,
    command: null,
    ...overrides,
  };
}

describe('ExportLibrary', () => {
  it('starts empty when there is no file, and remembers what it is given', async () => {
    const file = path.join(tmp, 'a', 'exports.json');
    const lib = new ExportLibrary(file);
    expect(await lib.list()).toEqual([]);
    const video = path.join(tmp, 'one.mp4');
    await fs.writeFile(video, 'abcdef');
    await lib.add(entry('job-1', video));
    await lib.add(entry('job-2', path.join(tmp, 'missing.mp4')));
    const list = await lib.list();
    expect(list.map((r) => r.id)).toEqual(['job-2', 'job-1']); // newest first
    expect(list[1]).toMatchObject({ id: 'job-1', exists: true, bytes: 6 }); // size as it is now
    expect(list[0]).toMatchObject({ id: 'job-2', exists: false, bytes: 3 }); // size as it was
    // a second instance reads the same file: the list survives a restart
    const again = new ExportLibrary(file);
    expect((await again.list()).map((r) => r.id)).toEqual(['job-2', 'job-1']);
    expect((await fs.readdir(path.join(tmp, 'a'))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('deletes the file and forgets it, or only forgets a file that is already gone', async () => {
    const lib = new ExportLibrary(path.join(tmp, 'b', 'exports.json'));
    const video = path.join(tmp, 'two.mp4');
    await fs.writeFile(video, 'xyz');
    await lib.add(entry('job-1', video));
    await lib.add(entry('job-2', path.join(tmp, 'gone.mp4')));
    const removed = await lib.remove('job-1', { deleteFiles: true });
    expect(removed).toMatchObject({ deleted: true, record: { id: 'job-1', exists: true } });
    await expect(fs.access(video)).rejects.toThrow();
    const forgotten = await lib.remove('job-2', { deleteFiles: true });
    expect(forgotten).toMatchObject({ deleted: false, record: { exists: false } });
    expect(await lib.list()).toEqual([]);
    await expect(lib.remove('job-1', { deleteFiles: true })).rejects.toMatchObject({
      code: 'export_not_found',
    });
  });

  it('keeps the file when asked only to forget it', async () => {
    const lib = new ExportLibrary(path.join(tmp, 'c', 'exports.json'));
    const video = path.join(tmp, 'keep.mp4');
    await fs.writeFile(video, 'keep me');
    await lib.add(entry('job-1', video));
    expect(await lib.remove('job-1', { deleteFiles: false })).toMatchObject({ deleted: false });
    expect(await fs.readFile(video, 'utf8')).toBe('keep me');
  });

  it('removes an export folder, but not one that has gained foreign files', async () => {
    const lib = new ExportLibrary(path.join(tmp, 'd', 'exports.json'));
    const ours = path.join(tmp, 'stream');
    await fs.mkdir(path.join(ours, '720p'), { recursive: true });
    await fs.writeFile(path.join(ours, 'index.m3u8'), '#EXTM3U');
    await fs.writeFile(path.join(ours, '720p', 'seg_00001.m4s'), 'seg');
    const theirs = path.join(tmp, 'stream-with-notes');
    await fs.mkdir(theirs, { recursive: true });
    await fs.writeFile(path.join(theirs, 'index.m3u8'), '#EXTM3U');
    await fs.writeFile(path.join(theirs, 'notes.txt'), 'not ours');
    await lib.add(entry('job-1', ours, { kind: 'directory', container: 'hls' }));
    await lib.add(entry('job-2', theirs, { kind: 'directory', container: 'hls' }));
    const list = await lib.list();
    expect(list.find((r) => r.id === 'job-1')).toMatchObject({ exists: true, bytes: 10 });
    expect(await lib.remove('job-1', { deleteFiles: true })).toMatchObject({ deleted: true });
    await expect(fs.access(ours)).rejects.toThrow();
    await expect(lib.remove('job-2', { deleteFiles: true })).rejects.toMatchObject({
      code: 'folder_not_empty',
    });
    expect(await fs.readFile(path.join(theirs, 'notes.txt'), 'utf8')).toBe('not ours');
    // the record stays, so the user can still see it and remove it from the list
    expect((await lib.list()).map((r) => r.id)).toEqual(['job-2']);
  });

  it('sets a damaged index aside instead of failing', async () => {
    const file = path.join(tmp, 'e', 'exports.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{ not json');
    const notes: string[] = [];
    const lib = new ExportLibrary(file, { log: (m) => notes.push(m) });
    expect(await lib.list()).toEqual([]);
    expect(notes[0]).toContain('could not be read');
    const names = await fs.readdir(path.dirname(file));
    expect(names.some((n) => n.startsWith('exports.json.damaged-'))).toBe(true);
    await lib.add(entry('job-1', path.join(tmp, 'nothing.mp4')));
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({ version: 1 });
  });

  it('ignores entries it does not understand', async () => {
    const file = path.join(tmp, 'f', 'exports.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({ version: 1, exports: [{ id: 'x' }, entry('job-9', path.join(tmp, 'nine.mp4'))] }),
    );
    expect((await new ExportLibrary(file).list()).map((r) => r.id)).toEqual(['job-9']);
  });
});
