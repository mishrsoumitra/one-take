/**
 * Getting a model file's bytes. Three places are tried in turn: the app's own `/models` path (the
 * server serves a copy from wherever one is, and fetches a missing one from its publisher itself,
 * which a browser page cannot always do: GitHub's release downloads carry no CORS header), the
 * browser's cache storage (a copy kept from an earlier fetch), and the file's publisher directly,
 * after which the copy goes into the cache storage so the machine is never asked again. Whichever way
 * it came, the bytes are checked against the catalogue's SHA-256, so a server that answers a missing
 * file with the app's page, or a download cut short, is never mistaken for a model.
 */
import { MODELS_PATH, type ModelFile } from '@one-take/shared';

const CACHE = 'one-take-models';

export interface FetchProgress {
  loaded: number;
  total: number;
  source: 'local' | 'cache' | 'remote';
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Reads a response to the end, reporting how far it has got. */
async function read(
  response: Response,
  total: number,
  source: FetchProgress['source'],
  onProgress?: (p: FetchProgress) => void,
): Promise<ArrayBuffer> {
  const reader = response.body?.getReader();
  if (!reader) return response.arrayBuffer();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.({ loaded, total, source });
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out.buffer;
}

/** The message in a `{ error: { message } }` answer, when the body is one. */
async function errorIn(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    return typeof body.error?.message === 'string' ? body.error.message : null;
  } catch {
    return null;
  }
}

type Fetched = { bytes: ArrayBuffer } | { reason: string };

async function fromUrl(
  url: string,
  model: ModelFile,
  source: FetchProgress['source'],
  onProgress?: (p: FetchProgress) => void,
): Promise<Fetched> {
  const where = source === 'local' ? 'the One Take server' : new URL(url).host;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    return {
      reason:
        source === 'local'
          ? 'the One Take server is not answering'
          : `${where} refused the request from this page (${error instanceof Error ? error.message : String(error)}); the server can fetch it where a page cannot`,
    };
  }
  if (!response.ok) {
    const message = await errorIn(response);
    return { reason: message ?? `${where} answered ${response.status}` };
  }
  const length = Number(response.headers.get('content-length') ?? model.bytes);
  // the app's page answering for a missing file is small and never the right length
  if (source === 'local' && length !== model.bytes)
    return { reason: 'the One Take server has no copy of it' };
  const bytes = await read(response, length, source, onProgress);
  if (bytes.byteLength !== model.bytes || (await sha256(bytes)) !== model.sha256) {
    console.warn(`${model.name} from ${url} is not the expected file; ignoring it`);
    return { reason: `what ${where} sent was not the model (checksum mismatch)` };
  }
  return { bytes };
}

async function cache(): Promise<Cache | null> {
  try {
    return await caches.open(CACHE);
  } catch {
    return null; // no cache storage here (a private window, or storage blocked)
  }
}

/** The model's bytes, from wherever they are to be had, checked; throws when they are nowhere. */
export async function loadModel(
  model: ModelFile,
  onProgress?: (p: FetchProgress) => void,
): Promise<ArrayBuffer> {
  const reasons: string[] = [];
  const local = await fromUrl(`${MODELS_PATH}/${model.name}`, model, 'local', onProgress);
  if ('bytes' in local) return local.bytes;
  reasons.push(local.reason);
  const store = await cache();
  const cached = await store?.match(model.url).catch(() => undefined);
  if (cached) {
    const bytes = await read(cached, model.bytes, 'cache', onProgress);
    if (bytes.byteLength === model.bytes && (await sha256(bytes)) === model.sha256) return bytes;
    await store?.delete(model.url).catch(() => false);
  }
  const remote = await fromUrl(model.url, model, 'remote', onProgress);
  if ('reason' in remote) {
    reasons.push(remote.reason);
    throw new Error(
      `${model.name} (for ${model.what}) could not be fetched: ${reasons.join('; ')}. Run "npm run models" once with the machine online, then reload the page.`,
    );
  }
  await store
    ?.put(
      model.url,
      new Response(remote.bytes, { headers: { 'Content-Length': String(remote.bytes.byteLength) } }),
    )
    .catch(() => {
      /* the copy simply is not kept */
    });
  return remote.bytes;
}
