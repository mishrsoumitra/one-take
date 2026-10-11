import { type FastifyInstance } from 'fastify';

import { type AppDependencies } from '../app.js';
import { SERVER_VERSION } from '../config.js';

export function registerCapabilityRoutes(app: FastifyInstance, deps: AppDependencies): void {
  app.get('/api/health', () => ({ ok: true, name: 'one-take-server', version: SERVER_VERSION }));
  app.get('/api/capabilities', () => deps.capabilities());
  /** The pre-flight result on its own: CPU, memory, GPU, disk, working hardware encoders, tier. */
  app.get('/api/system', () => deps.capabilities().system);
  /** How busy the machine is right now; the browser polls this once a second during an export. */
  app.get('/api/system/load', () => deps.load.sample());
}
