import { type FastifyInstance } from 'fastify';

import { type AppDependencies } from '../app.js';
import { SERVER_VERSION } from '../config.js';

export function registerCapabilityRoutes(app: FastifyInstance, deps: AppDependencies): void {
  app.get('/api/health', () => ({ ok: true, name: 'one-take-server', version: SERVER_VERSION }));
  app.get('/api/capabilities', () => deps.capabilities());
}
