import { type Readable } from 'node:stream';

import { CreateExportJobSchema, FinishExportJobSchema, type JobEvent } from '@one-take/shared';
import { type FastifyInstance } from 'fastify';

import { type AppDependencies } from '../app.js';
import { revealInFileManager } from '../util/desktop.js';
import { ApiError } from '../util/errors.js';

interface IdParams {
  Params: { id: string };
}

export function registerExportRoutes(app: FastifyInstance, deps: AppDependencies): void {
  const { jobs } = deps;

  app.get('/api/exports', () => jobs.list());

  app.post('/api/exports', async (request, reply) => {
    const parsed = CreateExportJobSchema.safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest('Invalid export request', parsed.error.issues);
    const job = await jobs.create(parsed.data);
    return reply.code(201).send(job);
  });

  app.get<IdParams>('/api/exports/:id', (request) => jobs.get(request.params.id));

  app.put<IdParams & { Querystring: { offset?: string } }>('/api/exports/:id/data', async (request) => {
    const offset = Number(request.query.offset ?? '0');
    if (!Number.isInteger(offset) || offset < 0 || offset > Number.MAX_SAFE_INTEGER) {
      throw ApiError.badRequest('offset must be a non-negative integer');
    }
    const body = request.body as Readable | undefined;
    if (!body || typeof body.on !== 'function')
      throw ApiError.badRequest('Send the chunk as application/octet-stream');
    const job = await jobs.write(request.params.id, offset, body);
    return { received: job.bytesReceived };
  });

  app.post<IdParams>('/api/exports/:id/finish', async (request) => {
    const parsed = FinishExportJobSchema.safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest('Invalid body', parsed.error.issues);
    return jobs.finish(request.params.id, parsed.data.totalBytes);
  });

  app.delete<IdParams>('/api/exports/:id', (request) => jobs.cancel(request.params.id));

  // Server-sent events: the current job first, then every change until it finishes.
  app.get<IdParams>('/api/exports/:id/events', (request, reply) => {
    const job = jobs.get(request.params.id);
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (event: JobEvent) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    send({ type: 'job', job });
    const unsubscribe = jobs.subscribe(job.id, (event) => {
      send(event);
      if (event.type === 'job' && ['done', 'failed', 'cancelled'].includes(event.job.state)) {
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
    if (['done', 'failed', 'cancelled'].includes(job.state)) {
      cleanup();
      reply.raw.end();
    }
  });

  // Show the result in Finder / Explorer / the file manager.
  app.post<IdParams>('/api/exports/:id/reveal', (request) => {
    const job = jobs.get(request.params.id);
    const target = job.outputs[0]?.path;
    if (!target) throw ApiError.conflict('no_output', 'This export has no output yet.');
    revealInFileManager(target);
    return { ok: true };
  });
}
