/**
 * Turns PowerPoint files into PDF with pptxtojson (parsing) and pdfkit (drawing): plain JavaScript, so
 * nothing has to be installed and nothing opens on screen. Rendering runs in a worker thread so a big
 * deck never stalls the export progress stream; one deck is rendered at a time.
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import { Worker } from 'node:worker_threads';

import { PRESENTATION_EXTENSIONS, presentationExtension, type PresentationSupport } from '@one-take/shared';

import { ApiError, errorMessage } from '../util/errors.js';

import { FontIndex } from './pptx/fonts.js';
import { renderDeck, type Deck } from './pptx/render.js';

import type { parse as parsePptx } from 'pptxtojson';

// pptxtojson ships an ESM build without a package "exports" map, so Node needs the CommonJS file.
const load = createRequire(import.meta.url);
const pptxtojson = load('pptxtojson/dist/index.cjs') as { parse: typeof parsePptx };

export const RENDERER = 'pptxtojson + pdfkit';

export const presentationSupport: PresentationSupport = {
  extensions: [...PRESENTATION_EXTENSIONS],
  renderer: RENDERER,
};

/** Converting a big deck can take a while, mostly embedding pictures. */
export const DEFAULT_CONVERT_TIMEOUT_MS = 10 * 60 * 1000;

export interface ConversionResult {
  pdf: Buffer;
  pages: number;
  warnings: string[];
}

export interface ConvertOptions {
  /** Extra folders with fonts, searched before the system ones. */
  fontDirectories?: string[];
  /** Goes into the PDF's metadata. */
  title?: string;
}

const fontIndexes = new Map<string, FontIndex>();

/** One index per set of folders; scanning happens on first use and is remembered for the process. */
export function fontIndexFor(directories: string[]): FontIndex {
  const key = directories.join('\n');
  let index = fontIndexes.get(key);
  if (!index) {
    index = new FontIndex(directories);
    fontIndexes.set(key, index);
  }
  return index;
}

/** Parses and draws in the current thread. */
export async function convertPptxToPdf(
  file: Uint8Array,
  options: ConvertOptions = {},
): Promise<ConversionResult> {
  const bytes = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
  let deck: Deck;
  try {
    deck = await pptxtojson.parse(bytes, { imageMode: 'base64' });
  } catch (error) {
    throw new ApiError(
      422,
      'unreadable_presentation',
      `Could not read the presentation (is it a PowerPoint .pptx file?): ${errorMessage(error)}`,
    );
  }
  if (deck.slides.length === 0)
    throw new ApiError(422, 'empty_presentation', 'The presentation has no slides');
  if (!(deck.size.width > 0 && deck.size.height > 0)) deck.size = { width: 960, height: 540 };
  return renderDeck(deck, { fonts: fontIndexFor(options.fontDirectories ?? []), title: options.title });
}

/** What the HTTP layer needs; tests swap in a fake. */
export interface ConverterService {
  support(): PresentationSupport;
  convert(file: Buffer, name: string): Promise<ConversionResult>;
}

/* ------------------------------------------------------------------ */
/* Worker thread                                                       */
/* ------------------------------------------------------------------ */

export interface WorkerRequest {
  id: number;
  file: ArrayBuffer;
  title: string;
}

export type WorkerResponse =
  | { id: number; ok: true; pdf: ArrayBuffer; pages: number; warnings: string[] }
  | { id: number; ok: false; status: number; code: string; message: string };

interface Pending {
  resolve: (result: ConversionResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface PptxConverterOptions {
  fontDirectories?: string[];
  timeoutMs?: number;
  log?: (message: string) => void;
  /** Render on this thread instead of a worker (tests, and when running from TypeScript sources). */
  inline?: boolean;
  /**
   * Heap the renderer may grow to, in MB. A deck that needs more fails with a clear message instead of
   * taking the whole server down; the default is half of the machine's memory.
   */
  memoryLimitMb?: number;
}

const MB = 1024 * 1024;

/** Half the machine's memory, between 1 GB and 32 GB. */
export function defaultRendererMemoryMb(totalBytes = os.totalmem()): number {
  return Math.min(32 * 1024, Math.max(1024, Math.floor(totalBytes / MB / 2)));
}

export class PptxConverter implements ConverterService {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly fontDirectories: string[];
  private readonly timeoutMs: number;
  private readonly log: (message: string) => void;
  private readonly inline: boolean;
  private readonly memoryLimitMb: number;

  constructor(options: PptxConverterOptions = {}) {
    this.fontDirectories = options.fontDirectories ?? [];
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CONVERT_TIMEOUT_MS;
    this.log = options.log ?? (() => undefined);
    // tsx / vitest run the .ts sources, where a worker file cannot be loaded without a loader
    this.inline = options.inline ?? import.meta.url.endsWith('.ts');
    this.memoryLimitMb = options.memoryLimitMb ?? defaultRendererMemoryMb();
  }

  /** The renderer's heap limit in MB (for the start-up report). */
  get memoryLimit(): number {
    return this.memoryLimitMb;
  }

  support(): PresentationSupport {
    return presentationSupport;
  }

  convert(file: Buffer, name: string): Promise<ConversionResult> {
    if (!presentationExtension(name)) {
      return Promise.reject(new ApiError(415, 'unsupported_file', `${name} is not a PowerPoint file`));
    }
    const job = this.queue.then(() => this.run(file, name));
    this.queue = job.catch(() => undefined);
    return job;
  }

  /** Stops the worker; pending conversions fail. */
  async dispose(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.failAll(new ApiError(503, 'server_stopping', 'The server is shutting down'));
    if (worker) await worker.terminate();
  }

  private async run(file: Buffer, name: string): Promise<ConversionResult> {
    const started = Date.now();
    const title = name.replace(/\.[^.]+$/, '');
    const result = this.inline
      ? await convertPptxToPdf(file, { fontDirectories: this.fontDirectories, title })
      : await this.runInWorker(file, title);
    this.log(
      `converted ${name}: ${result.pages} slides in ${((Date.now() - started) / 1000).toFixed(1)} s${result.warnings.length ? ` (${result.warnings.length} warnings)` : ''}`,
    );
    return result;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./pptx/worker.js', import.meta.url), {
      workerData: { fontDirectories: this.fontDirectories },
      resourceLimits: { maxOldGenerationSizeMb: this.memoryLimitMb },
    });
    worker.on('message', (response: WorkerResponse) => this.onResponse(response));
    worker.on('error', (error) => {
      this.log(`presentation worker failed: ${errorMessage(error)}`);
      this.worker = null;
      const outOfMemory = (error as { code?: string }).code === 'ERR_WORKER_OUT_OF_MEMORY';
      this.failAll(
        outOfMemory
          ? new ApiError(
              507,
              'conversion_out_of_memory',
              `The presentation needs more than the ${(this.memoryLimitMb / 1024).toFixed(1)} GB this computer can give the renderer. Export the deck as PDF instead, or remove embedded videos.`,
            )
          : new ApiError(500, 'conversion_failed', `The renderer crashed: ${errorMessage(error)}`),
      );
    });
    worker.on('exit', (code) => {
      if (this.worker === worker) this.worker = null;
      if (code !== 0)
        this.failAll(new ApiError(500, 'conversion_failed', `The renderer stopped (exit code ${code})`));
    });
    this.worker = worker;
    return worker;
  }

  private runInWorker(file: Buffer, title: string): Promise<ConversionResult> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    const payload = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
    return new Promise<ConversionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const stuck = this.worker;
        this.worker = null;
        void stuck?.terminate();
        reject(
          new ApiError(
            504,
            'conversion_timeout',
            'Rendering the presentation took too long; try a smaller deck or export it as PDF',
          ),
        );
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const request: WorkerRequest = { id, file: payload, title };
      worker.postMessage(request, [payload]);
    });
  }

  private onResponse(response: WorkerResponse): void {
    const entry = this.pending.get(response.id);
    if (!entry) return;
    this.pending.delete(response.id);
    clearTimeout(entry.timer);
    if (response.ok) {
      entry.resolve({ pdf: Buffer.from(response.pdf), pages: response.pages, warnings: response.warnings });
    } else {
      entry.reject(new ApiError(response.status, response.code, response.message));
    }
  }

  private failAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }
}
