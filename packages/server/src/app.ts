import path from 'node:path';

import { fastifyStatic } from '@fastify/static';
import { type ServerCapabilities } from '@one-take/shared';
import Fastify, { LogController, type FastifyInstance } from 'fastify';

import { type ServerConfig } from './config.js';
import { registerCapabilityRoutes } from './routes/capabilities.js';
import { registerConvertRoutes } from './routes/convert.js';
import { registerExportRoutes } from './routes/exports.js';
import { registerFsRoutes } from './routes/fs.js';
import { registerLibraryRoutes } from './routes/library.js';
import { type ConverterService } from './services/convert.js';
import { type JobManager } from './services/jobs.js';
import { type ExportLibrary } from './services/library.js';
import { type LoadMonitor } from './services/load.js';
import { ApiError, errorMessage } from './util/errors.js';

export interface AppDependencies {
  config: ServerConfig;
  jobs: JobManager;
  converter: ConverterService;
  capabilities: () => ServerCapabilities;
  /** The live CPU and memory figures behind `/api/system/load`. */
  load: LoadMonitor;
  /** The exports the server finished, remembered across restarts. */
  library: ExportLibrary;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

export function hostIsLoopback(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  let host = hostHeader.trim().toLowerCase();
  // strip the port, keeping IPv6 brackets intact
  if (host.startsWith('[')) host = host.slice(0, host.indexOf(']') + 1);
  else host = host.replace(/:\d+$/, '');
  return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost');
}

export function originIsLoopback(origin: string | undefined): boolean {
  if (!origin) return true; // same-origin GETs and non-browser clients send no Origin
  try {
    const url = new URL(origin);
    return hostIsLoopback(url.host);
  } catch {
    return false;
  }
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const { config } = deps;
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 4 * 1024 * 1024,
    logController: new LogController({
      disableRequestLogging: config.logLevel !== 'debug' && config.logLevel !== 'trace',
    }),
  });

  // Raw streams for chunk uploads; the JSON parser handles everything else.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
    done(null, payload);
  });

  // Defence against DNS rebinding and cross-site requests: only loopback hosts and origins may talk to us.
  if (!config.allowRemote) {
    app.addHook('onRequest', (request, reply, done) => {
      if (!hostIsLoopback(request.headers.host)) {
        void reply.code(403).send({
          error: {
            code: 'forbidden_host',
            message: 'This server only answers requests addressed to localhost.',
          },
        });
        return;
      }
      if (
        request.method !== 'GET' &&
        request.method !== 'HEAD' &&
        !originIsLoopback(request.headers.origin)
      ) {
        void reply
          .code(403)
          .send({ error: { code: 'forbidden_origin', message: 'Cross-site requests are not allowed.' } });
        return;
      }
      done();
    });
  }

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ApiError) {
      void reply
        .code(error.status)
        .send({ error: { code: error.code, message: error.message, details: error.details } });
      return;
    }
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
    const status = typeof statusCode === 'number' && statusCode >= 400 ? statusCode : 500;
    if (status >= 500) request.log.error(error);
    void reply
      .code(status)
      .send({ error: { code: status >= 500 ? 'internal' : 'bad_request', message: errorMessage(error) } });
  });

  registerCapabilityRoutes(app, deps);
  registerFsRoutes(app);
  registerExportRoutes(app, deps);
  registerLibraryRoutes(app, deps);
  registerConvertRoutes(app, deps);

  if (config.staticDir) {
    void app.register(fastifyStatic, {
      root: path.resolve(config.staticDir),
      prefix: '/',
      index: ['index.html'],
      wildcard: true,
    });
  }
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      void reply
        .code(404)
        .send({ error: { code: 'not_found', message: `No route for ${request.method} ${request.url}` } });
      return;
    }
    if (config.staticDir && request.method === 'GET') {
      void reply.sendFile('index.html');
      return;
    }
    void reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
  });

  return app;
}
