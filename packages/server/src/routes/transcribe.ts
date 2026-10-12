/**
 * Transcription over HTTP: send 16 kHz mono WAV, get a running job back, follow it over server-sent
 * events (or polling), read the words when it is done.
 */
import { type Readable } from 'node:stream';

import { type TranscriptionEvent } from '@one-take/shared';
import { type FastifyInstance } from 'fastify';

import { type AppDependencies } from '../app.js';
import { ApiError } from '../util/errors.js';

interface IdParams {
  Params: { id: string };
}

const FINAL = new Set(['done', 'failed', 'cancelled']);

export function registerTranscribeRoutes(app: FastifyInstance, deps: AppDependencies): void {
  const { transcription } = deps;

  app.post<{ Querystring: { language?: string; duration?: string } }>(
    '/api/transcribe',
    async (request, reply) => {
      const body = request.body as Readable | undefined;
      if (!body || typeof body.on !== 'function') {
        throw ApiError.badRequest('Send the audio as application/octet-stream (16 kHz mono WAV)');
      }
      const duration = Number(request.query.duration ?? '0');
      const job = await transcription.create(body, {
        language: request.query.language ?? 'auto',
        durationSec: Number.isFinite(duration) && duration > 0 ? duration : 0,
      });
      return reply.code(201).send(job);
    },
  );

  app.get<IdParams>('/api/transcribe/:id', (request) => transcription.get(request.params.id));

  app.delete<IdParams>('/api/transcribe/:id', (request) => transcription.cancel(request.params.id));

  app.get<IdParams>('/api/transcribe/:id/events', (request, reply) => {
    const job = transcription.get(request.params.id);
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (event: TranscriptionEvent) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    send({ type: 'job', job });
    const unsubscribe = transcription.subscribe(job.id, (event) => {
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
