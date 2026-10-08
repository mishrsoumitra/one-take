import os from 'node:os';

import { ListDirectoryQuerySchema, MakeDirectorySchema } from '@one-take/shared';
import { type FastifyInstance } from 'fastify';

import { listDirectory, makeDirectory } from '../services/filesystem.js';
import { ApiError } from '../util/errors.js';

export function registerFsRoutes(app: FastifyInstance): void {
  app.get('/api/fs/list', async (request) => {
    const parsed = ListDirectoryQuerySchema.safeParse(request.query);
    if (!parsed.success) throw ApiError.badRequest('Invalid query', parsed.error.issues);
    return listDirectory(parsed.data.path ?? os.homedir(), parsed.data.files);
  });

  app.post('/api/fs/mkdir', async (request) => {
    const parsed = MakeDirectorySchema.safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest('Invalid body', parsed.error.issues);
    const created = await makeDirectory(parsed.data.path);
    return listDirectory(created, false);
  });
}
