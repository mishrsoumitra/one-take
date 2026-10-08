import path from 'node:path';
import { type Readable } from 'node:stream';

import { formatBytes, PRESENTATION_EXTENSIONS, presentationExtension } from '@one-take/shared';
import { type FastifyInstance } from 'fastify';

import { type AppDependencies } from '../app.js';
import { ApiError } from '../util/errors.js';

/** Decks with embedded video get big, but anything past this is not a slide deck. */
export const MAX_PRESENTATION_BYTES = 1024 * 1024 * 1024;
/** Only so many notes fit in a response header. */
const MAX_WARNINGS = 25;

/** Reads a raw request body into memory, failing fast once it is clearly too large. */
export async function readBody(body: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > max) {
      throw new ApiError(413, 'file_too_large', `Presentation files are limited to ${formatBytes(max)}`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

/**
 * `POST /api/convert?name=deck.pptx` with the file as the raw body answers with the PDF. The name only
 * decides the type and the PDF title. Notes about things that could not be drawn faithfully travel in the
 * `x-one-take-warnings` header as a URL-encoded JSON array.
 */
export function registerConvertRoutes(app: FastifyInstance, deps: AppDependencies): void {
  app.post<{ Querystring: { name?: string } }>('/api/convert', async (request, reply) => {
    const name = path.basename(request.query.name ?? '');
    const extension = presentationExtension(name);
    if (!extension) {
      throw new ApiError(
        415,
        'unsupported_file',
        `"${name}" is not a presentation file. Known types: ${PRESENTATION_EXTENSIONS.map((e) => `.${e}`).join(', ')}.`,
      );
    }
    const body = request.body as Readable | undefined;
    if (!body || typeof body.on !== 'function') {
      throw ApiError.badRequest('Send the file as application/octet-stream');
    }
    const file = await readBody(body, MAX_PRESENTATION_BYTES);
    if (file.length === 0) throw ApiError.badRequest('The file is empty');
    const result = await deps.converter.convert(file, name);
    request.log.info(
      `converted ${name} (${formatBytes(file.length)}) to a ${result.pages}-page PDF (${formatBytes(result.pdf.length)})`,
    );
    void reply
      .header('content-type', 'application/pdf')
      .header('x-one-take-pages', String(result.pages))
      .header(
        'x-one-take-warnings',
        encodeURIComponent(JSON.stringify(result.warnings.slice(0, MAX_WARNINGS))),
      )
      .send(result.pdf);
    return reply;
  });
}
