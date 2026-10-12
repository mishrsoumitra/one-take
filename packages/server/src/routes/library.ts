/**
 * The export library over HTTP: the videos the server finished, to list, play in the app, show in the
 * file manager, open in the default player, and delete. Every route names a record by id; the server
 * never acts on a path the client sent.
 */
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';

import { CONTAINER_INFO } from '@one-take/shared';
import { type FastifyInstance } from 'fastify';

import { type AppDependencies } from '../app.js';
import { openWithDefaultApp, revealInFileManager } from '../util/desktop.js';
import { ApiError } from '../util/errors.js';

interface IdParams {
  Params: { id: string };
}

/** `bytes=start-end` against a file of `size` bytes; null when there is no usable range. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!m || size === 0) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start: number;
  let end: number;
  if (a === '') {
    // the last N bytes
    const n = Number(b);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end };
}

export function registerLibraryRoutes(app: FastifyInstance, deps: AppDependencies): void {
  const { library } = deps;

  app.get('/api/library', () => library.list());

  app.get<IdParams>('/api/library/:id', (request) => library.get(request.params.id));

  /** Deletes the file (or the export's folder) and forgets it; `?files=0` only forgets it. */
  app.delete<IdParams & { Querystring: { files?: string } }>('/api/library/:id', (request) =>
    library.remove(request.params.id, { deleteFiles: request.query.files !== '0' }),
  );

  app.post<IdParams>('/api/library/:id/reveal', async (request) => {
    const record = await library.get(request.params.id);
    if (!record.exists) throw ApiError.conflict('file_missing', 'This file is no longer where it was saved.');
    revealInFileManager(record.path);
    return { ok: true };
  });

  app.post<IdParams>('/api/library/:id/open', async (request) => {
    const record = await library.get(request.params.id);
    if (!record.exists) throw ApiError.conflict('file_missing', 'This file is no longer where it was saved.');
    openWithDefaultApp(record.path);
    return { ok: true };
  });

  // The video itself, with byte ranges so the <video> element can seek.
  app.get<IdParams>('/api/library/:id/file', async (request, reply) => {
    const record = await library.get(request.params.id);
    if (record.kind !== 'file') {
      throw ApiError.conflict('not_a_file', 'This export is a folder of segments; open it in its player.');
    }
    let size: number;
    try {
      size = (await fs.stat(record.path)).size;
    } catch {
      throw ApiError.conflict('file_missing', 'This file is no longer where it was saved.');
    }
    const type = CONTAINER_INFO[record.container].mimeType;
    void reply.header('accept-ranges', 'bytes').header('cache-control', 'no-store').type(type);
    const rangeHeader = request.headers.range;
    if (rangeHeader === undefined) {
      void reply.header('content-length', String(size));
      return reply.send(createReadStream(record.path));
    }
    const range = parseRange(rangeHeader, size);
    if (range === null) {
      void reply.code(416).header('content-range', `bytes */${size}`);
      return reply.send();
    }
    void reply
      .code(206)
      .header('content-range', `bytes ${range.start}-${range.end}/${size}`)
      .header('content-length', String(range.end - range.start + 1));
    return reply.send(createReadStream(record.path, { start: range.start, end: range.end }));
  });
}
