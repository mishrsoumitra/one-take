import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type ModelFile } from '@one-take/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ModelStore, ModelUnavailableError } from '../src/services/models.js';

const BYTES = Buffer.from('a small model file, for the tests only');
const SHA = createHash('sha256').update(BYTES).digest('hex');
const MODEL: ModelFile = {
  name: 'tiny.onnx',
  url: 'https://models.example.test/tiny.onnx',
  sha256: SHA,
  bytes: BYTES.length,
  what: 'the tests',
};
const CATALOGUE = { tiny: MODEL };

let tmp: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'one-take-models-'));
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** A `fetch` that answers the model's URL with `body` (or fails), counting the calls. */
function fakeFetch(body: Buffer | null, status = 200): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchFn = ((input: string | URL | Request) => {
    calls++;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== MODEL.url) return Promise.resolve(new Response(null, { status: 404 }));
    if (body === null) return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve(new Response(new Uint8Array(body), { status }));
  }) as typeof fetch;
  return { fetch: fetchFn, calls: () => calls };
}

describe('ModelStore', () => {
  it('knows the catalogue by file name', () => {
    const store = new ModelStore({ catalogue: CATALOGUE, dirs: [], cacheDir: path.join(tmp, 'cache') });
    expect(store.model('tiny.onnx')).toBe(MODEL);
    expect(store.model('other.onnx')).toBeNull();
  });

  it('serves a verified copy from the first folder that has one, skipping a wrong file', async () => {
    const bad = path.join(tmp, 'bad');
    const good = path.join(tmp, 'good');
    await fs.mkdir(bad, { recursive: true });
    await fs.mkdir(good, { recursive: true });
    // same size, different bytes: only the hash tells
    await fs.writeFile(path.join(bad, MODEL.name), Buffer.from(BYTES.map((b) => b ^ 1)));
    await fs.writeFile(path.join(good, MODEL.name), BYTES);
    const { fetch, calls } = fakeFetch(BYTES);
    const store = new ModelStore({
      catalogue: CATALOGUE,
      dirs: [path.join(tmp, 'missing'), bad, good],
      cacheDir: path.join(tmp, 'cache1'),
      fetch,
    });
    expect(await store.locate(MODEL)).toBe(path.join(good, MODEL.name));
    expect(calls()).toBe(0);
    const where = await store.locations();
    expect(where).toEqual([{ model: MODEL, path: path.join(good, MODEL.name) }]);
  });

  it('fetches a model that is nowhere into the cache folder, once for everyone asking', async () => {
    const cacheDir = path.join(tmp, 'cache2');
    const { fetch, calls } = fakeFetch(BYTES);
    const store = new ModelStore({
      catalogue: CATALOGUE,
      dirs: [path.join(tmp, 'nowhere')],
      cacheDir,
      fetch,
    });
    const [a, b] = await Promise.all([store.locate(MODEL), store.locate(MODEL)]);
    expect(a).toBe(path.join(cacheDir, MODEL.name));
    expect(b).toBe(a);
    expect(calls()).toBe(1);
    expect(await fs.readFile(a)).toEqual(BYTES);
    // the copy is found next time without fetching again
    expect(await store.locate(MODEL)).toBe(a);
    expect(calls()).toBe(1);
    expect(await fs.readdir(cacheDir)).toEqual([MODEL.name]); // no .part left behind
  });

  it('refuses a download whose bytes are not the model and leaves nothing behind', async () => {
    const cacheDir = path.join(tmp, 'cache3');
    const { fetch } = fakeFetch(Buffer.concat([BYTES, Buffer.from('!')]));
    const store = new ModelStore({ catalogue: CATALOGUE, dirs: [], cacheDir, fetch });
    await expect(store.locate(MODEL)).rejects.toThrow(ModelUnavailableError);
    await expect(store.locate(MODEL)).rejects.toThrow(/npm run models/);
    expect(await fs.readdir(cacheDir)).toEqual([]);
  });

  it('says what went wrong when the publisher cannot be reached or answers an error', async () => {
    const offline = new ModelStore({
      catalogue: CATALOGUE,
      dirs: [],
      cacheDir: path.join(tmp, 'c4'),
      fetch: fakeFetch(null).fetch,
    });
    await expect(offline.locate(MODEL)).rejects.toThrow(/could not reach models.example.test/);
    const gone = new ModelStore({
      catalogue: CATALOGUE,
      dirs: [],
      cacheDir: path.join(tmp, 'c5'),
      fetch: fakeFetch(BYTES, 503).fetch,
    });
    await expect(gone.locate(MODEL)).rejects.toThrow(/answered 503/);
  });
});
