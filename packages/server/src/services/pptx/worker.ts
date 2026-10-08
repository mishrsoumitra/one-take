/** Worker-thread side of the presentation converter: renders one deck per request and posts the PDF back. */
import { parentPort, workerData } from 'node:worker_threads';

import { ApiError, errorMessage } from '../../util/errors.js';
import { convertPptxToPdf, type WorkerRequest, type WorkerResponse } from '../convert.js';

const port = parentPort;
if (!port) throw new Error('This file must run as a worker thread');

const { fontDirectories } = (workerData ?? {}) as { fontDirectories?: string[] };

port.on('message', (request: WorkerRequest) => {
  void (async () => {
    let response: WorkerResponse;
    const transfer: ArrayBuffer[] = [];
    try {
      const result = await convertPptxToPdf(new Uint8Array(request.file), {
        fontDirectories: fontDirectories ?? [],
        title: request.title,
      });
      const pdf = result.pdf.buffer.slice(
        result.pdf.byteOffset,
        result.pdf.byteOffset + result.pdf.byteLength,
      ) as ArrayBuffer;
      transfer.push(pdf);
      response = { id: request.id, ok: true, pdf, pages: result.pages, warnings: result.warnings };
    } catch (error) {
      response =
        error instanceof ApiError
          ? { id: request.id, ok: false, status: error.status, code: error.code, message: error.message }
          : {
              id: request.id,
              ok: false,
              status: 500,
              code: 'conversion_failed',
              message: errorMessage(error),
            };
    }
    port.postMessage(response, transfer);
  })();
});
