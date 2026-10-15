/**
 * The studio over HTTP: make a job from a manifest, upload the audio (and the mouth crops) as raw
 * bytes, start it, follow it over server-sent events (or polling), fetch each clip's result as soon
 * as the job says it is there.
 */
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { type Readable } from 'node:stream';

import { CreateStudioJobSchema, type StudioEvent } from '@one-take/shared';
import { type FastifyInstance } from 'fastify';

import { type AppDependencies } from '../app.js';
import { ApiError } from '../util/errors.js';

interface IdParams {
  Params: { id: string };
}

interface ClipParams {
  Params: { id: string; clip: string; kind: string };
}

const FINAL = new Set(['done', 'failed', 'cancelled']);

function body(request: { body: unknown }): Readable {
  const stream = request.body as Readable | undefined;
  if (!stream || typeof stream.on !== 'function') {
    throw ApiError.badRequest('Send the bytes as application/octet-stream');
  }
  return stream;
}

export function registerStudioRoutes(app: FastifyInstance, deps: AppDependencies): void {
  const { studio } = deps;

  app.post('/api/studio', async (request, reply) => {
    const parsed = CreateStudioJobSchema.safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest('Invalid studio request', parsed.error.issues);
    const job = await studio.create(parsed.data);
    return reply.code(201).send(job);
  });

  app.get<IdParams>('/api/studio/:id', (request) => studio.get(request.params.id));

  app.put<IdParams>('/api/studio/:id/audio', (request) =>
    studio.writeAudio(request.params.id, body(request)),
  );

  app.put<IdParams>('/api/studio/:id/faces', (request) =>
    studio.writeFaces(request.params.id, body(request)),
  );

  app.post<IdParams>('/api/studio/:id/start', (request) => studio.start(request.params.id));

  app.delete<IdParams>('/api/studio/:id', (request) => studio.cancel(request.params.id));

  /** One clip's result: 16-bit mono PCM at the clip's own rate. */
  app.get<ClipParams>('/api/studio/:id/clips/:clip/:kind', async (request, reply) => {
    const kind = request.params.kind;
    if (kind !== 'deep' && kind !== 'voice') throw ApiError.badRequest('The result is "deep" or "voice"');
    const file = studio.resultPath(request.params.id, request.params.clip, kind);
    const { size } = await fs.stat(file);
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', String(size))
      .send(createReadStream(file));
  });

  app.get<IdParams>('/api/studio/:id/events', (request, reply) => {
    const job = studio.get(request.params.id);
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (event: StudioEvent) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    send({ type: 'job', job });
    const unsubscribe = studio.subscribe(job.id, (event) => {
      send(event);
      if (FINAL.has(event.job.state)) {
        cleanup();
        reply.raw.end();
      }
    });
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.on('close', cleanup);
    if (FINAL.has(job.state)) {
      cleanup();
      reply.raw.end();
    }
  });
}
