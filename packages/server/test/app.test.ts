import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp, hostIsLoopback, originIsLoopback } from '../src/app.js';
import { PptxConverter, presentationSupport, type ConverterService } from '../src/services/convert.js';
import { JobManager } from '../src/services/jobs.js';
import { ExportLibrary } from '../src/services/library.js';
import { LoadMonitor } from '../src/services/load.js';
import { TranscriptionManager } from '../src/services/transcribe.js';

let tmp: string;
let staticDir: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'one-take-app-'));
  staticDir = path.join(tmp, 'static');
  await fs.mkdir(path.join(staticDir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>One Take</title>');
  await fs.writeFile(path.join(staticDir, 'assets', 'app.js'), 'console.log(1)');
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function makeApp(allowRemote = false, converter: ConverterService = new PptxConverter({ inline: true })) {
  const library = new ExportLibrary(path.join(tmp, 'data', 'exports.json'));
  return buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      staticDir,
      defaultDirectory: tmp,
      dataDir: path.join(tmp, 'data'),
      ffmpegPath: null,
      ffprobePath: null,
      fontDirectories: [],
      logLevel: 'silent',
      allowRemote,
      selfTest: false,
      benchmark: false,
      rendererMemoryMb: null,
      whisperPath: null,
      whisperModel: null,
    },
    jobs: new JobManager({ ffmpeg: null, library }),
    converter,
    load: new LoadMonitor(),
    library,
    transcription: new TranscriptionManager({ info: null, dataDir: path.join(tmp, 'data') }),
    capabilities: () => ({
      name: 'one-take-server',
      version: 't',
      platform: 'test',
      homeDirectory: tmp,
      defaultDirectory: tmp,
      ffmpeg: null,
      ffprobePath: null,
      shortcuts: [],
      presentations: converter.support(),
      system: null,
      transcription: null,
    }),
  });
}

/** Pretends to convert: answers with a tiny PDF and records what it was given. */
function fakeConverter(): ConverterService & { inputs: { name: string; body: string }[] } {
  const inputs: { name: string; body: string }[] = [];
  return {
    inputs,
    support: () => presentationSupport,
    convert(file, name) {
      inputs.push({ name, body: file.toString('utf8') });
      return Promise.resolve({ pdf: Buffer.from('%PDF-1.4 fake'), pages: 3, warnings: ['a note'] });
    },
  };
}

describe('loopback checks', () => {
  it('recognises loopback hosts', () => {
    expect(hostIsLoopback('localhost:4317')).toBe(true);
    expect(hostIsLoopback('127.0.0.1')).toBe(true);
    expect(hostIsLoopback('[::1]:4317')).toBe(true);
    expect(hostIsLoopback('app.localhost')).toBe(true);
    expect(hostIsLoopback('evil.example.com')).toBe(false);
    expect(hostIsLoopback(undefined)).toBe(false);
    expect(originIsLoopback(undefined)).toBe(true);
    expect(originIsLoopback('http://localhost:5173')).toBe(true);
    expect(originIsLoopback('https://evil.example.com')).toBe(false);
  });
});

describe('convert', () => {
  it('turns a presentation into a PDF through the converter', async () => {
    const converter = fakeConverter();
    const app = makeApp(false, converter);
    const res = await app.inject({
      method: 'POST',
      url: `/api/convert?name=${encodeURIComponent('My Lecture.PPTX')}`,
      headers: { host: 'localhost', 'content-type': 'application/octet-stream' },
      payload: Buffer.from('not really a deck'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['x-one-take-pages']).toBe('3');
    expect(JSON.parse(decodeURIComponent(String(res.headers['x-one-take-warnings'])))).toEqual(['a note']);
    expect(res.body).toBe('%PDF-1.4 fake');
    expect(converter.inputs).toEqual([{ name: 'My Lecture.PPTX', body: 'not really a deck' }]);
    const caps = await app.inject({
      method: 'GET',
      url: '/api/capabilities',
      headers: { host: 'localhost' },
    });
    expect(caps.json()).toMatchObject({ presentations: { extensions: ['pptx', 'ppsx', 'pptm'] } });
    await app.close();
  });

  it('refuses files that are not presentations', async () => {
    const app = makeApp(false, fakeConverter());
    const res = await app.inject({
      method: 'POST',
      url: '/api/convert?name=slides.pdf',
      headers: { host: 'localhost', 'content-type': 'application/octet-stream' },
      payload: Buffer.from('x'),
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ error: { code: 'unsupported_file' } });
    await app.close();
  });

  it('reports a file that is not really a deck', async () => {
    const app = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/convert?name=deck.pptx',
      headers: { host: 'localhost', 'content-type': 'application/octet-stream' },
      payload: Buffer.from('this is not a zip file'),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'unreadable_presentation' } });
    await app.close();
  });

  it('wants the file as a raw body', async () => {
    const app = makeApp(false, fakeConverter());
    const res = await app.inject({
      method: 'POST',
      url: '/api/convert?name=deck.pptx',
      headers: { host: 'localhost' },
      payload: { nope: true },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('app', () => {
  it('answers health and capabilities', async () => {
    const app = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'localhost:4317' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    const caps = await app.inject({
      method: 'GET',
      url: '/api/capabilities',
      headers: { host: 'localhost:4317' },
    });
    expect(caps.json()).toMatchObject({ name: 'one-take-server', ffmpeg: null });
    const load = await app.inject({
      method: 'GET',
      url: '/api/system/load',
      headers: { host: 'localhost:4317' },
    });
    expect(load.statusCode).toBe(200);
    const body = load.json<{
      cpu: { cores: number };
      memory: { totalBytes: number };
      server: { pid: number };
    }>();
    expect(body.cpu.cores).toBeGreaterThan(0);
    expect(body.memory.totalBytes).toBeGreaterThan(0);
    expect(body.server.pid).toBe(process.pid);
    await app.close();
  });

  it('rejects foreign hosts and origins', async () => {
    const app = makeApp();
    const bad = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'evil.example.com' },
    });
    expect(bad.statusCode).toBe(403);
    const badOrigin = await app.inject({
      method: 'POST',
      url: '/api/fs/mkdir',
      headers: { host: 'localhost', origin: 'https://evil.example.com' },
      payload: { path: tmp },
    });
    expect(badOrigin.statusCode).toBe(403);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/fs/mkdir',
      headers: { host: 'localhost', origin: 'http://localhost:4317' },
      payload: { path: path.join(tmp, 'new') },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ exists: true, writable: true });
    await app.close();
  });

  it('lists folders', async () => {
    const app = makeApp();
    await fs.mkdir(path.join(tmp, 'b-folder'));
    await fs.mkdir(path.join(tmp, 'a-folder'));
    await fs.writeFile(path.join(tmp, 'file.txt'), 'x');
    const res = await app.inject({
      method: 'GET',
      url: `/api/fs/list?path=${encodeURIComponent(tmp)}`,
      headers: { host: 'localhost' },
    });
    const names = res
      .json<{ entries: { name: string; kind: string }[] }>()
      .entries.map((e) => `${e.kind}:${e.name}`);
    expect(names).toContain('directory:a-folder');
    expect(names).not.toContain('file:file.txt');
    const withFiles = await app.inject({
      method: 'GET',
      url: `/api/fs/list?path=${encodeURIComponent(tmp)}&files=1`,
      headers: { host: 'localhost' },
    });
    expect(withFiles.json<{ entries: { name: string }[] }>().entries.map((e) => e.name)).toContain(
      'file.txt',
    );
    const missing = await app.inject({
      method: 'GET',
      url: `/api/fs/list?path=${encodeURIComponent(path.join(tmp, 'nope'))}`,
      headers: { host: 'localhost' },
    });
    expect(missing.json()).toMatchObject({ exists: false });
    await app.close();
  });

  it('validates export requests and reports unknown jobs', async () => {
    const app = makeApp();
    const bad = await app.inject({
      method: 'POST',
      url: '/api/exports',
      headers: { host: 'localhost' },
      payload: { fileName: '' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: { code: 'bad_request' } });
    const unknown = await app.inject({
      method: 'GET',
      url: '/api/exports/nope',
      headers: { host: 'localhost' },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: { code: 'job_not_found' } });
    await app.close();
  });

  it('runs a direct export through the HTTP API', async () => {
    const app = makeApp();
    const create = await app.inject({
      method: 'POST',
      url: '/api/exports',
      headers: { host: 'localhost' },
      payload: {
        fileName: 'api test',
        directory: tmp,
        overwrite: false,
        upload: {
          container: 'mp4',
          videoCodec: 'avc',
          audioCodec: 'aac',
          width: 640,
          height: 360,
          fps: 5,
          durationSec: 1,
          estimatedBytes: 10,
        },
        processing: null,
        sidecars: [
          { extension: 'srt', content: '1\n00:00:00,000 --> 00:00:01,000\nhello\n' },
          { extension: 'txt', content: '[0:00] hello world' },
        ],
      },
    });
    expect(create.statusCode).toBe(201);
    const { id } = create.json<{ id: string }>();
    const part1 = await app.inject({
      method: 'PUT',
      url: `/api/exports/${id}/data?offset=0`,
      headers: { host: 'localhost', 'content-type': 'application/octet-stream' },
      payload: Buffer.from('hello '),
    });
    expect(part1.json()).toEqual({ received: 6 });
    const part2 = await app.inject({
      method: 'PUT',
      url: `/api/exports/${id}/data?offset=6`,
      headers: { host: 'localhost', 'content-type': 'application/octet-stream' },
      payload: Buffer.from('world'),
    });
    expect(part2.json()).toEqual({ received: 11 });
    const finish = await app.inject({
      method: 'POST',
      url: `/api/exports/${id}/finish`,
      headers: { host: 'localhost' },
      payload: { totalBytes: 11 },
    });
    expect(finish.statusCode).toBe(200);
    for (let i = 0; i < 50; i++) {
      const job = (
        await app.inject({ method: 'GET', url: `/api/exports/${id}`, headers: { host: 'localhost' } })
      ).json<{ state: string }>();
      if (job.state === 'done') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await fs.readFile(path.join(tmp, 'api test.mp4'), 'utf8')).toBe('hello world');
    // the subtitles and the transcript sit next to it, under its name
    expect(await fs.readFile(path.join(tmp, 'api test.srt'), 'utf8')).toContain('hello');
    expect(await fs.readFile(path.join(tmp, 'api test.txt'), 'utf8')).toBe('[0:00] hello world');
    const done = (
      await app.inject({ method: 'GET', url: `/api/exports/${id}`, headers: { host: 'localhost' } })
    ).json<{ sidecars: string[] }>();
    expect(done.sidecars.map((p) => path.basename(p))).toEqual(['api test.srt', 'api test.txt']);
    const list = await app.inject({ method: 'GET', url: '/api/exports', headers: { host: 'localhost' } });
    expect(list.json<{ id: string }[]>().map((j) => j.id)).toContain(id);

    // the finished export is in the library, with its file, and can be streamed, revealed and deleted
    const library = await app.inject({ method: 'GET', url: '/api/library', headers: { host: 'localhost' } });
    expect(library.statusCode).toBe(200);
    const record =
      library.json<
        { id: string; fileName: string; exists: boolean; bytes: number; sidecars: string[] }[]
      >()[0];
    expect(record).toMatchObject({ id, fileName: 'api test.mp4', exists: true, bytes: 11 });
    expect(record?.sidecars.length).toBe(2);
    const whole = await app.inject({
      method: 'GET',
      url: `/api/library/${id}/file`,
      headers: { host: 'localhost' },
    });
    expect(whole.statusCode).toBe(200);
    expect(whole.headers['content-type']).toContain('video/mp4');
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.body).toBe('hello world');
    const part = await app.inject({
      method: 'GET',
      url: `/api/library/${id}/file`,
      headers: { host: 'localhost', range: 'bytes=6-' },
    });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 6-10/11');
    expect(part.body).toBe('world');
    const tail = await app.inject({
      method: 'GET',
      url: `/api/library/${id}/file`,
      headers: { host: 'localhost', range: 'bytes=-5' },
    });
    expect(tail.statusCode).toBe(206);
    expect(tail.body).toBe('world');
    const beyond = await app.inject({
      method: 'GET',
      url: `/api/library/${id}/file`,
      headers: { host: 'localhost', range: 'bytes=50-60' },
    });
    expect(beyond.statusCode).toBe(416);
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/library/${id}`,
      headers: { host: 'localhost', origin: 'http://localhost:4317' },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ deleted: true, record: { id } });
    await expect(fs.access(path.join(tmp, 'api test.mp4'))).rejects.toThrow();
    await expect(fs.access(path.join(tmp, 'api test.srt'))).rejects.toThrow();
    await expect(fs.access(path.join(tmp, 'api test.txt'))).rejects.toThrow();
    const empty = await app.inject({ method: 'GET', url: '/api/library', headers: { host: 'localhost' } });
    expect(empty.json()).toEqual([]);
    const gone = await app.inject({
      method: 'GET',
      url: `/api/library/${id}`,
      headers: { host: 'localhost' },
    });
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toMatchObject({ error: { code: 'export_not_found' } });
    await app.close();
  });

  it('parses byte ranges the way players send them', async () => {
    const { parseRange } = await import('../src/routes/library.js');
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBeNull();
    expect(parseRange('bytes=5-2', 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBeNull();
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-', 0)).toBeNull();
  });

  it('serves the built client with an SPA fallback', async () => {
    const app = makeApp();
    const index = await app.inject({ method: 'GET', url: '/', headers: { host: 'localhost' } });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('One Take');
    const asset = await app.inject({ method: 'GET', url: '/assets/app.js', headers: { host: 'localhost' } });
    expect(asset.statusCode).toBe(200);
    const deep = await app.inject({ method: 'GET', url: '/some/route', headers: { host: 'localhost' } });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('One Take');
    const api404 = await app.inject({ method: 'GET', url: '/api/nothing', headers: { host: 'localhost' } });
    expect(api404.statusCode).toBe(404);
    await app.close();
  });
});
