/**
 * The model files the client needs (the voice check, the lip check, the camera cleanup), served by the
 * server at `/models/<name>` from wherever a copy is: the built client, `packages/client/public/models`
 * (where `npm run models` puts them, so a download after the build still counts), the server's own
 * data folder, or the studio's folder (which fetches the speaker model too). When no copy is anywhere,
 * the server fetches the file from its publisher into the data folder and serves it from there.
 *
 * The server does this rather than the browser because a browser page may not: sherpa-onnx publishes
 * the speaker model as a GitHub release asset, and GitHub's download redirect carries no CORS header,
 * so a page at 127.0.0.1 is refused the bytes. A Node process has no such rule.
 *
 * Every copy is checked against the catalogue's SHA-256 before it is served, once per server run (a
 * file that changes size or date is checked again), so a cut-short download or a wrong file is never
 * handed to the browser. One download runs per model at a time; requests that arrive while it runs wait
 * for it.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { type ModelFile } from '@one-take/shared';

export class ModelUnavailableError extends Error {
  constructor(
    readonly model: ModelFile,
    message: string,
  ) {
    super(message);
    this.name = 'ModelUnavailableError';
  }
}

export interface ModelStoreOptions {
  /** The models that may be asked for, by key. */
  catalogue: Record<string, ModelFile>;
  /** Folders a copy may be in, searched in this order. Missing folders are fine. */
  dirs: string[];
  /** Where a model fetched from its publisher is kept (made on first use). */
  cacheDir: string;
  /** `fetch`, replaceable for tests. */
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

/** Where a model was found, for the start-up line and the tests. */
export interface ModelLocation {
  model: ModelFile;
  /** The verified copy, or null when none is here yet. */
  path: string | null;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function statOrNull(file: string): Promise<fs.Stats | null> {
  try {
    return await fsp.stat(file);
  } catch {
    return null;
  }
}

export class ModelStore {
  private readonly catalogue: Record<string, ModelFile>;
  private readonly dirs: string[];
  readonly cacheDir: string;
  private readonly fetchFn: typeof fetch;
  private readonly log: (message: string) => void;
  /** Files whose hash matched, with the size and date they had then. */
  private readonly verified = new Map<string, { size: number; mtimeMs: number }>();
  /** The download under way for a model, shared by everyone asking for it. */
  private readonly downloads = new Map<string, Promise<string>>();

  constructor(options: ModelStoreOptions) {
    this.catalogue = options.catalogue;
    this.dirs = options.dirs;
    this.cacheDir = options.cacheDir;
    this.fetchFn = options.fetch ?? fetch;
    this.log = options.log ?? (() => undefined);
  }

  /** The catalogue entry for a file name, or null when no such model is served. */
  model(name: string): ModelFile | null {
    return Object.values(this.catalogue).find((m) => m.name === name) ?? null;
  }

  /** Every model in the catalogue and where its verified copy is, without fetching anything. */
  async locations(): Promise<ModelLocation[]> {
    const out: ModelLocation[] = [];
    for (const model of Object.values(this.catalogue)) out.push({ model, path: await this.find(model) });
    return out;
  }

  /**
   * The path of a verified copy of the model, fetched from its publisher first when none is here.
   * Throws {@link ModelUnavailableError} when it is nowhere and cannot be fetched.
   */
  async locate(model: ModelFile): Promise<string> {
    const found = await this.find(model);
    if (found) return found;
    let download = this.downloads.get(model.name);
    if (!download) {
      download = this.download(model).finally(() => this.downloads.delete(model.name));
      this.downloads.set(model.name, download);
    }
    return download;
  }

  /** A copy in one of the folders whose bytes are the model's, or null. */
  private async find(model: ModelFile): Promise<string | null> {
    for (const dir of [...this.dirs, this.cacheDir]) {
      const file = path.join(dir, model.name);
      if (await this.check(file, model)) return file;
    }
    return null;
  }

  private async check(file: string, model: ModelFile): Promise<boolean> {
    const stat = await statOrNull(file);
    if (!stat) return false;
    if (!stat.isFile() || stat.size !== model.bytes) return false;
    const seen = this.verified.get(file);
    if (seen?.size === stat.size && seen.mtimeMs === stat.mtimeMs) return true;
    if ((await sha256File(file)) !== model.sha256) {
      this.log(`${file} is not ${model.name} (checksum mismatch); ignoring it`);
      return false;
    }
    this.verified.set(file, { size: stat.size, mtimeMs: stat.mtimeMs });
    return true;
  }

  private async download(model: ModelFile): Promise<string> {
    const target = path.join(this.cacheDir, model.name);
    const partial = `${target}.${process.pid}.part`;
    this.log(
      `fetching ${model.name} (${(model.bytes / 1_048_576).toFixed(1)} MB) for ${model.what} from ${model.url}`,
    );
    try {
      await fsp.mkdir(this.cacheDir, { recursive: true });
      let response: Response;
      try {
        response = await this.fetchFn(model.url);
      } catch (error) {
        throw new Error(
          `the server could not reach ${new URL(model.url).host} (${error instanceof Error ? error.message : String(error)}); is this machine online?`,
          { cause: error },
        );
      }
      if (!response.ok || !response.body) {
        throw new Error(`${new URL(model.url).host} answered ${response.status} ${response.statusText}`);
      }
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial));
      const stat = await fsp.stat(partial);
      if (stat.size !== model.bytes) {
        throw new Error(`the download was ${stat.size} bytes, not ${model.bytes}`);
      }
      const got = await sha256File(partial);
      if (got !== model.sha256) throw new Error(`checksum mismatch: expected ${model.sha256}, got ${got}`);
      await fsp.rename(partial, target);
      this.verified.set(target, { size: stat.size, mtimeMs: (await fsp.stat(target)).mtimeMs });
      this.log(`${model.name} is in ${this.cacheDir}`);
      return target;
    } catch (error) {
      await fsp.rm(partial, { force: true }).catch(() => undefined);
      const reason = error instanceof Error ? error.message : String(error);
      this.log(`${model.name} could not be fetched: ${reason}`);
      throw new ModelUnavailableError(
        model,
        `${model.name} (for ${model.what}) is not on this machine and could not be fetched: ${reason}. Run "npm run models" once with the machine online, then reload the page.`,
      );
    }
  }
}
