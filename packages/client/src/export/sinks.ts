/** Where the encoder's bytes go: the server, a file on disk, or memory. */
import { BufferTarget, StreamTarget, type StreamTargetChunk, type Target } from 'mediabunny';

import { type ApiClient, ApiRequestError } from '../api/client.js';

import { type FastStart } from './encoder.js';

export interface Sink {
  target: Target;
  fastStart: FastStart;
  seekable: boolean;
  /** Bytes handed over so far. */
  bytes: () => number;
  /** Flush and close after a successful encode. */
  close: () => Promise<void>;
  /** Discard after a failure or cancel. */
  abort: () => Promise<void>;
  /** The assembled file for in-memory sinks; null otherwise. */
  blob: () => Blob | null;
}

const CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_ATTEMPTS = 6;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/** Streams positioned chunks to the server; a hiccup is retried with back-off since re-sent bytes are harmless. */
export function createServerSink(
  api: ApiClient,
  jobId: string,
  signal: AbortSignal,
  fragmented: boolean,
): Sink {
  let bytes = 0;
  const aborted = () => signal.aborted;
  const writable = new WritableStream<StreamTargetChunk>({
    async write(chunk) {
      let attempt = 0;
      for (;;) {
        if (aborted()) throw new DOMException('Aborted', 'AbortError');
        try {
          await api.uploadChunk(jobId, chunk.position, chunk.data, signal);
          bytes = Math.max(bytes, chunk.position + chunk.data.byteLength);
          return;
        } catch (error) {
          if (aborted()) throw error;
          // 4xx means the server rejected the job (gone, cancelled); retrying cannot help.
          if (error instanceof ApiRequestError && error.status < 500) throw error;
          if (++attempt >= MAX_ATTEMPTS) {
            throw new Error(
              `Lost the connection to the server while uploading (${(error as Error).message}).`,
              {
                cause: error,
              },
            );
          }
          await sleep(Math.min(8000, 400 * 2 ** attempt), signal);
        }
      }
    },
  });
  return {
    target: new StreamTarget(writable, { chunked: true, chunkSize: CHUNK_SIZE }),
    fastStart: fragmented ? 'fragmented' : false,
    seekable: true,
    bytes: () => bytes,
    close: () => Promise.resolve(),
    abort: () => Promise.resolve(),
    blob: () => null,
  };
}

/** Writes straight to a file chosen with the File System Access API (Chrome, Edge). Returns null if the user cancels. */
export async function createFileSink(
  suggestedName: string,
  mimeType: `${string}/${string}`,
  extension: string,
): Promise<Sink | null> {
  let handle: FileSystemFileHandle;
  try {
    handle = await window.showSaveFilePicker({
      suggestedName,
      types: [
        {
          description: `${extension.toUpperCase()} video`,
          accept: { [mimeType]: [`.${extension}` as const] },
        },
      ],
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }
  const writable = await handle.createWritable();
  let bytes = 0;
  const counting = new WritableStream<StreamTargetChunk>({
    async write(chunk) {
      await writable.write({ type: 'write', position: chunk.position, data: chunk.data });
      bytes = Math.max(bytes, chunk.position + chunk.data.byteLength);
    },
  });
  return {
    target: new StreamTarget(counting, { chunked: true, chunkSize: CHUNK_SIZE }),
    fastStart: false,
    seekable: true,
    bytes: () => bytes,
    close: () => writable.close(),
    abort: () => writable.abort().catch(() => undefined),
    blob: () => null,
  };
}

/** Keeps the whole file in memory; only for browsers without the File System Access API and modest sizes. */
export function createBufferSink(mimeType: string): Sink {
  const target = new BufferTarget();
  let bytes = 0;
  target.on('write', ({ end }) => {
    bytes = Math.max(bytes, end);
  });
  return {
    target,
    fastStart: 'in-memory',
    seekable: true,
    bytes: () => bytes,
    close: () => Promise.resolve(),
    abort: () => Promise.resolve(),
    blob: () => (target.buffer ? new Blob([target.buffer], { type: mimeType }) : null),
  };
}
