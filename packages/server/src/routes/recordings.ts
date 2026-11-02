/**
 * Recordings over HTTP: make one, send the deck and every phrase up as raw bytes (each checked
 * against the hash the app announces), keep the project state, and fetch it all back to continue
 * on any browser. Every route names a recording (and a phrase) by id; the server never acts on a
 * path the client sent.
 */
import { createReadStream } from 'node:fs';
import { type Readable } from 'node:stream';

import {
  CreateRecordingSchema,
  PhraseMetaSchema,
  SHA256_HEADER,
  SHA256_HEX,
  UpdateRecordingSchema,
} from '@one-take/shared';
import { type FastifyInstance, type FastifyRequest } from 'fastify';

import { type AppDependencies } from '../app.js';
import { revealInFileManager } from '../util/desktop.js';
import { ApiError } from '../util/errors.js';

interface IdParams {
  Params: { id: string };
}

interface DeckParams {
  Params: { id: string; index: string };
}

interface PhraseParams {
  Params: { id: string; phrase: string };
}

function body(request: { body: unknown }): Readable {
  const stream = request.body as Readable | undefined;
  if (!stream || typeof stream.on !== 'function') {
    throw ApiError.badRequest('Send the bytes as application/octet-stream');
  }
  return stream;
}

/** The hash the app expects the upload to have, when it sent one. */
function expectedHash(request: FastifyRequest): string | null {
  const value = request.headers[SHA256_HEADER];
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === '') return null;
  const hash = raw.trim().toLowerCase();
  if (!SHA256_HEX.test(hash)) throw ApiError.badRequest(`${SHA256_HEADER} must be a hex SHA-256`);
  return hash;
}

function index(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw ApiError.badRequest('The deck file index must be a whole number');
  return n;
}

export function registerRecordingRoutes(app: FastifyInstance, deps: AppDependencies): void {
  const { recordings } = deps;

  app.get('/api/recordings', () => recordings.list());

  app.post('/api/recordings', async (request, reply) => {
    const parsed = CreateRecordingSchema.safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest('Invalid recording', parsed.error.issues);
    const record = await recordings.create(parsed.data);
    return reply.code(201).send(record);
  });

  app.get<IdParams>('/api/recordings/:id', (request) => recordings.get(request.params.id));

  app.patch<IdParams>('/api/recordings/:id', (request) => {
    const parsed = UpdateRecordingSchema.safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest('Invalid recording state', parsed.error.issues);
    return recordings.update(request.params.id, parsed.data);
  });

  app.delete<IdParams>('/api/recordings/:id', async (request) => {
    await recordings.remove(request.params.id);
    return { ok: true };
  });

  app.post<IdParams>('/api/recordings/:id/reveal', async (request) => {
    const record = await recordings.get(request.params.id);
    revealInFileManager(record.path);
    return { ok: true };
  });

  app.put<DeckParams>('/api/recordings/:id/deck/:index', (request) =>
    recordings.writeDeckFile(
      request.params.id,
      index(request.params.index),
      body(request),
      expectedHash(request),
    ),
  );

  app.get<DeckParams>('/api/recordings/:id/deck/:index', async (request, reply) => {
    const file = await recordings.deckFile(request.params.id, index(request.params.index));
    return reply
      .header('content-type', file.type || 'application/octet-stream')
      .header('content-length', String(file.bytes))
      .header('cache-control', 'no-store')
      .send(createReadStream(file.path));
  });

  app.put<PhraseParams>('/api/recordings/:id/phrases/:phrase', (request) => {
    const meta = PhraseMetaSchema.safeParse(request.query);
    if (!meta.success) throw ApiError.badRequest('Invalid phrase details', meta.error.issues);
    return recordings.writePhrase(
      request.params.id,
      request.params.phrase,
      meta.data,
      body(request),
      expectedHash(request),
    );
  });

  app.get<PhraseParams>('/api/recordings/:id/phrases/:phrase', async (request, reply) => {
    const { path: file, phrase } = await recordings.phraseFile(request.params.id, request.params.phrase);
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', String(phrase.bytes))
      .header(SHA256_HEADER, phrase.sha256)
      .header('cache-control', 'no-store')
      .send(createReadStream(file));
  });

  app.delete<PhraseParams>('/api/recordings/:id/phrases/:phrase', (request) =>
    recordings.deletePhrase(request.params.id, request.params.phrase),
  );
}
