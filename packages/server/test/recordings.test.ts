import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { RECORDING_ID, type CreateRecording, type PhraseMeta } from '@one-take/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeRecordingId, RecordingStore } from '../src/services/recordings.js';

let tmp: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'one-take-recordings-'));
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const DECK = Buffer.from('%PDF-1.4 a small deck');

function deck(overrides: Partial<CreateRecording['deck']> = {}): CreateRecording {
  return {
    deck: {
      name: 'lecture.pdf',
      kind: 'pdf',
      slides: 4,
      hash: sha('the picked file'),
      files: [{ name: 'lecture.pdf', type: 'application/pdf', bytes: DECK.length, sha256: sha(DECK) }],
      origin: null,
      ...overrides,
    },
  };
}

function meta(overrides: Partial<PhraseMeta> = {}): PhraseMeta {
  return { slide: 0, seconds: 1.5, sitting: 1, kind: 'voice', camera: false, createdAt: 1000, ...overrides };
}

function stream(data: Buffer | string): Readable {
  return Readable.from([Buffer.isBuffer(data) ? data : Buffer.from(data)]);
}

/** A fixed clock that moves a second per call, so updatedAt orders the list. */
function clock(start = Date.UTC(2026, 10, 2, 15, 30, 12)): () => Date {
  let t = start;
  return () => new Date((t += 1000));
}

describe('makeRecordingId', () => {
  it('is a safe folder name that starts with the time', () => {
    const id = makeRecordingId(new Date(Date.UTC(2026, 10, 2, 15, 30, 12)), sha('deck'));
    expect(id.startsWith('20261102-153012-')).toBe(true);
    expect(id).toMatch(RECORDING_ID);
    expect(id).not.toBe(makeRecordingId(new Date(Date.UTC(2026, 10, 2, 15, 30, 12)), sha('deck')));
  });
});

describe('RecordingStore', () => {
  it('starts empty, creates a recording with its folders, and lists it', async () => {
    const dir = path.join(tmp, 'a');
    const store = new RecordingStore(dir, { now: clock() });
    expect(await store.list()).toEqual([]);
    const rec = await store.create(deck());
    expect(rec.id).toMatch(RECORDING_ID);
    expect(rec).toMatchObject({
      deckReady: false,
      phrases: [],
      order: [],
      current: 0,
      sitting: 1,
      sittings: [{ n: 1, fromSlide: 0 }],
      bytes: 0,
      path: path.join(dir, rec.id),
    });
    const names = await fs.readdir(rec.path);
    expect(names.sort()).toEqual(['deck', 'phrases', 'recording.json']);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: rec.id,
      name: 'lecture.pdf',
      slides: 4,
      phrases: 0,
      seconds: 0,
      lastSlide: -1,
      sittings: 1,
      camera: false,
      ink: false,
      deckReady: false,
    });
  });

  it('takes the deck and the phrases, checks their hashes, and reads them back', async () => {
    const store = new RecordingStore(path.join(tmp, 'b'), { now: clock() });
    const rec = await store.create(deck());
    // the deck file: its hash and size must be the announced ones
    await expect(store.writeDeckFile(rec.id, 0, stream('something else'), null)).rejects.toMatchObject({
      code: 'hash_mismatch',
    });
    await expect(store.writeDeckFile(rec.id, 1, stream(DECK), null)).rejects.toMatchObject({ status: 400 });
    const receipt = await store.writeDeckFile(rec.id, 0, stream(DECK), sha(DECK));
    expect(receipt).toEqual({ id: '0', sha256: sha(DECK), bytes: DECK.length });
    const file = await store.deckFile(rec.id, 0);
    expect(file).toMatchObject({ name: 'lecture.pdf', type: 'application/pdf', bytes: DECK.length });
    expect(await fs.readFile(file.path)).toEqual(DECK);
    expect((await store.get(rec.id)).deckReady).toBe(true);
    // phrases: hashed as they land, the announced hash has to match
    const one = Buffer.from('phrase one, as bytes');
    const two = Buffer.from('phrase two, with a picture');
    await expect(
      store.writePhrase(rec.id, 'p1', meta(), stream(one), sha('not these bytes')),
    ).rejects.toMatchObject({ code: 'hash_mismatch' });
    expect((await fs.readdir(path.join(rec.path, 'phrases'))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    const p1 = await store.writePhrase(rec.id, 'p1', meta(), stream(one), sha(one));
    expect(p1).toEqual({ id: 'p1', sha256: sha(one), bytes: one.length, ...meta() });
    const p2 = await store.writePhrase(
      rec.id,
      'p2',
      meta({ slide: 2, seconds: 3, sitting: 2, camera: true, createdAt: 2000 }),
      stream(two),
      null,
    );
    expect(p2.sha256).toBe(sha(two));
    const got = await store.get(rec.id);
    expect(got.phrases.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(got.order).toEqual(['p1', 'p2']);
    expect(got.bytes).toBe(DECK.length + one.length + two.length);
    const back = await store.phraseFile(rec.id, 'p2');
    expect(await fs.readFile(back.path)).toEqual(two);
    expect(back.phrase.camera).toBe(true);
    const summary = (await store.list())[0];
    expect(summary).toMatchObject({ phrases: 2, seconds: 4.5, lastSlide: 2, camera: true, ink: false });
    // a phrase uploaded again replaces the first
    const again = Buffer.from('phrase one, said again');
    await store.writePhrase(rec.id, 'p1', meta({ seconds: 2 }), stream(again), sha(again));
    expect((await store.get(rec.id)).phrases[0]).toMatchObject({ sha256: sha(again), seconds: 2 });
    expect((await store.get(rec.id)).order).toEqual(['p1', 'p2']);
    await expect(store.phraseFile(rec.id, 'nope')).rejects.toMatchObject({ code: 'phrase_not_found' });
    await expect(store.deckFile(rec.id, 1)).rejects.toMatchObject({ code: 'deck_file_missing' });
  });

  it('keeps the project state and survives a restart', async () => {
    const dir = path.join(tmp, 'c');
    const store = new RecordingStore(dir, { now: clock() });
    const rec = await store.create(deck());
    await store.writePhrase(rec.id, 'a', meta(), stream('a'), null);
    await store.writePhrase(rec.id, 'b', meta({ slide: 1 }), stream('b'), null);
    const updated = await store.update(rec.id, {
      order: ['b', 'a', 'c'],
      current: 3,
      sitting: 2,
      sittings: [
        { n: 1, startedAt: 'x', fromSlide: 0 },
        { n: 2, startedAt: 'y', fromSlide: 3 },
      ],
      settings: { threshold: -40 },
      exportRequest: { fileName: 'talk' },
      counter: 7,
    });
    expect(updated).toMatchObject({ current: 3, sitting: 2, counter: 7, settings: { threshold: -40 } });
    // the order may name a phrase whose file is still on its way; the phrases come in the order given
    expect(updated.order).toEqual(['b', 'a', 'c']);
    expect(updated.phrases.map((p) => p.id)).toEqual(['b', 'a']);
    // a second store over the same folder reads it all back
    const again = new RecordingStore(dir);
    const back = await again.get(rec.id);
    expect(back).toMatchObject({
      current: 3,
      sitting: 2,
      counter: 7,
      exportRequest: { fileName: 'talk' },
      order: ['b', 'a', 'c'],
    });
    expect(back.sittings).toHaveLength(2);
    expect((await again.list())[0]).toMatchObject({ sittings: 2, current: 3 });
    // a phrase arriving after the order was set joins at the end
    await again.writePhrase(rec.id, 'd', meta(), stream('d'), null);
    expect((await again.get(rec.id)).order).toEqual(['b', 'a', 'c', 'd']);
  });

  it('deletes a phrase, then the whole recording', async () => {
    const store = new RecordingStore(path.join(tmp, 'd'), { now: clock() });
    const rec = await store.create(deck());
    await store.writePhrase(rec.id, 'a', meta(), stream('a'), null);
    await store.writePhrase(rec.id, 'b', meta(), stream('b'), null);
    const after = await store.deletePhrase(rec.id, 'a');
    expect(after.phrases.map((p) => p.id)).toEqual(['b']);
    expect(after.order).toEqual(['b']);
    await expect(fs.access(path.join(rec.path, 'phrases', 'a.phrase'))).rejects.toThrow();
    // deleting a phrase that is not there is no error
    expect((await store.deletePhrase(rec.id, 'zzz')).phrases).toHaveLength(1);
    await store.remove(rec.id);
    await expect(fs.access(rec.path)).rejects.toThrow();
    await expect(store.get(rec.id)).rejects.toMatchObject({ code: 'recording_not_found' });
    await expect(store.remove(rec.id)).rejects.toMatchObject({ code: 'recording_not_found' });
    expect(await store.list()).toEqual([]);
  });

  it('starts afresh on the same deck by copying its files, and refuses a different deck', async () => {
    const store = new RecordingStore(path.join(tmp, 'e'), { now: clock() });
    const first = await store.create(deck());
    await store.writeDeckFile(first.id, 0, stream(DECK), null);
    await store.writePhrase(first.id, 'a', meta(), stream('a'), null);
    const second = await store.create({ ...deck(), deckFrom: first.id });
    expect(second.id).not.toBe(first.id);
    expect(second.deckReady).toBe(true);
    expect(second.phrases).toEqual([]);
    expect(await fs.readFile((await store.deckFile(second.id, 0)).path)).toEqual(DECK);
    // the first recording is untouched
    expect((await store.get(first.id)).phrases).toHaveLength(1);
    const other = deck({ files: [{ name: 'x.pdf', type: 'application/pdf', bytes: 3, sha256: sha('xyz') }] });
    await expect(store.create({ ...other, deckFrom: first.id })).rejects.toMatchObject({
      code: 'deck_differs',
    });
    expect((await store.list()).map((r) => r.id).sort()).toEqual([first.id, second.id].sort());
    // newest first
    expect((await store.list())[0]?.id).toBe(second.id);
  });

  it('serialises writes to one manifest', async () => {
    const store = new RecordingStore(path.join(tmp, 'f'), { now: clock() });
    const rec = await store.create(deck());
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.writePhrase(rec.id, `p${i}`, meta({ createdAt: i }), stream(`phrase ${i}`), null),
      ),
    );
    const got = await store.get(rec.id);
    expect(got.phrases).toHaveLength(20);
    const names = (await fs.readdir(path.join(rec.path, 'phrases'))).filter((n) => n.endsWith('.phrase'));
    expect(names).toHaveLength(20);
    // the manifest on disk agrees with the store
    const raw = JSON.parse(await fs.readFile(path.join(rec.path, 'recording.json'), 'utf8')) as {
      phrases: Record<string, unknown>;
    };
    expect(Object.keys(raw.phrases)).toHaveLength(20);
  });

  it('notices a folder deleted by hand', async () => {
    const store = new RecordingStore(path.join(tmp, 'i'), { now: clock() });
    const rec = await store.create(deck());
    await store.writePhrase(rec.id, 'a', meta(), stream('a'), null);
    expect((await store.get(rec.id)).phrases).toHaveLength(1);
    await fs.rm(rec.path, { recursive: true, force: true });
    await expect(store.get(rec.id)).rejects.toMatchObject({ code: 'recording_not_found' });
    expect(await store.list()).toEqual([]);
  });

  it('refuses ids that could leave the folder', async () => {
    const store = new RecordingStore(path.join(tmp, 'g'));
    await expect(store.get('../x')).rejects.toMatchObject({ status: 400 });
    await expect(store.get('a/b')).rejects.toMatchObject({ status: 400 });
    const rec = await store.create(deck());
    await expect(store.writePhrase(rec.id, '../../etc', meta(), stream('x'), null)).rejects.toMatchObject({
      status: 400,
    });
    await expect(store.phraseFile(rec.id, '.hidden')).rejects.toMatchObject({ status: 400 });
  });

  it('skips a folder whose manifest is damaged, and one that is not a recording', async () => {
    const dir = path.join(tmp, 'h');
    const notes: string[] = [];
    const store = new RecordingStore(dir, { log: (m) => notes.push(m) });
    const rec = await store.create(deck());
    await fs.mkdir(path.join(dir, '20260101-000000-bad'), { recursive: true });
    await fs.writeFile(path.join(dir, '20260101-000000-bad', 'recording.json'), '{ not json');
    await fs.mkdir(path.join(dir, '20260101-000000-empty'), { recursive: true });
    await fs.mkdir(path.join(dir, 'not an id!'), { recursive: true });
    const fresh = new RecordingStore(dir, { log: (m) => notes.push(m) });
    expect((await fresh.list()).map((r) => r.id)).toEqual([rec.id]);
    expect(notes.some((n) => n.includes('20260101-000000-bad'))).toBe(true);
    expect(notes.some((n) => n.includes('20260101-000000-empty'))).toBe(false);
  });
});
