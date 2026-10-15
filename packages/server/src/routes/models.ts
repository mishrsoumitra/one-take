import fs from 'node:fs';

import { MODELS_PATH } from '@one-take/shared';
import { type FastifyInstance } from 'fastify';

import { type AppDependencies } from '../app.js';
import { ModelUnavailableError } from '../services/models.js';

/**
 * `GET /models/<name>`: a catalogued model file, from wherever a verified copy is, fetched from its
 * publisher first when there is none (see services/models.ts). Registered ahead of the static client,
 * whose copy under `dist/models` is only one of the places looked in. A name that is not in the
 * catalogue is a 404 like any other missing file; a model that is nowhere and cannot be fetched is a
 * 502 with the reason, which the client shows.
 */
export function registerModelRoutes(app: FastifyInstance, deps: AppDependencies): void {
  app.get<{ Params: { name: string } }>(`${MODELS_PATH}/:name`, async (request, reply) => {
    const model = deps.models.model(request.params.name);
    if (!model) {
      return reply
        .code(404)
        .send({ error: { code: 'not_found', message: `No model called ${request.params.name}` } });
    }
    const etag = `"${model.sha256}"`;
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    let file: string;
    try {
      file = await deps.models.locate(model);
    } catch (error) {
      if (error instanceof ModelUnavailableError) {
        return reply.code(502).send({ error: { code: 'model_unavailable', message: error.message } });
      }
      throw error;
    }
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Length', String(model.bytes))
      .header('Cache-Control', 'public, max-age=604800')
      .header('ETag', etag)
      .send(fs.createReadStream(file));
  });
}
