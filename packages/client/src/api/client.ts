import {
  SHA256_HEADER,
  type ApiErrorBody,
  type CreateExportJobRequest,
  type CreateRecording,
  type CreateStudioJobRequest,
  type DirectoryListing,
  type ExportJob,
  type ExportRecord,
  type JobEvent,
  type PhraseMeta,
  type RecordingPhrase,
  type RecordingRecord,
  type RecordingSummary,
  type ServerCapabilities,
  type StudioEvent,
  type StudioJob,
  type SystemLoad,
  type TranscriptionEvent,
  type TranscriptionJob,
  type UpdateRecording,
  type UploadReceipt,
} from '@one-take/shared';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

const TERMINAL = new Set(['done', 'failed', 'cancelled']);

/** Thin typed wrapper over the server's JSON API. */
export class ApiClient {
  constructor(readonly base = '') {}

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}/api/health`, { signal: AbortSignal.timeout(2500) });
      return res.ok;
    } catch {
      return false;
    }
  }

  capabilities(): Promise<ServerCapabilities> {
    return this.json<ServerCapabilities>('GET', '/api/capabilities', undefined, AbortSignal.timeout(4000));
  }

  /** How busy the computer running the server is right now; polled once a second during an export. */
  systemLoad(): Promise<SystemLoad> {
    return this.json<SystemLoad>('GET', '/api/system/load', undefined, AbortSignal.timeout(1500));
  }

  listDirectory(path?: string, files = false): Promise<DirectoryListing> {
    const params = new URLSearchParams();
    if (path) params.set('path', path);
    if (files) params.set('files', '1');
    return this.json<DirectoryListing>('GET', `/api/fs/list?${params.toString()}`);
  }

  makeDirectory(path: string): Promise<DirectoryListing> {
    return this.json<DirectoryListing>('POST', '/api/fs/mkdir', { path });
  }

  createExport(request: CreateExportJobRequest): Promise<ExportJob> {
    return this.json<ExportJob>('POST', '/api/exports', request);
  }

  getExport(id: string): Promise<ExportJob> {
    return this.json<ExportJob>('GET', `/api/exports/${id}`);
  }

  async uploadChunk(id: string, offset: number, data: Uint8Array, signal?: AbortSignal): Promise<number> {
    const res = await fetch(`${this.base}/api/exports/${id}/data?offset=${offset}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: data as BodyInit,
      signal: signal ?? null,
    });
    const body = (await this.parse(res)) as { received: number };
    return body.received;
  }

  finishExport(id: string, totalBytes: number): Promise<ExportJob> {
    return this.json<ExportJob>('POST', `/api/exports/${id}/finish`, { totalBytes });
  }

  cancelExport(id: string): Promise<ExportJob> {
    return this.json<ExportJob>('DELETE', `/api/exports/${id}`);
  }

  async revealExport(id: string): Promise<void> {
    await this.json('POST', `/api/exports/${id}/reveal`);
  }

  /** The videos the server has saved, newest first, with whether each is still on disk. */
  listLibrary(): Promise<ExportRecord[]> {
    return this.json<ExportRecord[]>('GET', '/api/library', undefined, AbortSignal.timeout(10_000));
  }

  /** Deletes the file (or the export's folder) and forgets it; with `deleteFiles` false it only forgets. */
  deleteLibraryItem(id: string, deleteFiles = true): Promise<{ record: ExportRecord; deleted: boolean }> {
    return this.json('DELETE', `/api/library/${id}${deleteFiles ? '' : '?files=0'}`);
  }

  async revealLibraryItem(id: string): Promise<void> {
    await this.json('POST', `/api/library/${id}/reveal`);
  }

  /** Opens the video in the default player (or the folder in the file manager). */
  async openLibraryItem(id: string): Promise<void> {
    await this.json('POST', `/api/library/${id}/open`);
  }

  /** Where a <video> element can stream the file from (byte ranges supported). */
  libraryFileUrl(id: string): string {
    return `${this.base}/api/library/${id}/file`;
  }

  /** Sends 16 kHz mono WAV to the server's recogniser; answers with the running job. */
  async transcribe(
    wav: Uint8Array,
    language: string,
    durationSec: number,
    signal?: AbortSignal,
  ): Promise<TranscriptionJob> {
    const params = new URLSearchParams({ language, duration: String(durationSec) });
    const res = await fetch(`${this.base}/api/transcribe?${params.toString()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: wav as BodyInit,
      signal: signal ?? null,
    });
    return (await this.parse(res)) as TranscriptionJob;
  }

  getTranscription(id: string): Promise<TranscriptionJob> {
    return this.json<TranscriptionJob>('GET', `/api/transcribe/${id}`);
  }

  cancelTranscription(id: string): Promise<TranscriptionJob> {
    return this.json<TranscriptionJob>('DELETE', `/api/transcribe/${id}`);
  }

  /** Follows a transcription until it is done, over server-sent events with polling as the fallback. */
  watchTranscription(
    id: string,
    onEvent: (event: TranscriptionEvent) => void,
    signal?: AbortSignal,
  ): Promise<TranscriptionJob> {
    return this.watch<TranscriptionJob, TranscriptionEvent>(
      `/api/transcribe/${id}/events`,
      () => this.getTranscription(id),
      (event) => event.job,
      (job) => ({ type: 'job', job }),
      onEvent,
      signal,
    );
  }

  /* ---------------------------------------------------------------- the studio */

  /** A studio job from its manifest; the audio and the mouth crops follow as uploads. */
  createStudio(request: CreateStudioJobRequest): Promise<StudioJob> {
    return this.json<StudioJob>('POST', '/api/studio', request);
  }

  getStudio(id: string): Promise<StudioJob> {
    return this.json<StudioJob>('GET', `/api/studio/${id}`);
  }

  /** Every clip's audio in order, as 16-bit PCM, in one upload. */
  async uploadStudioAudio(id: string, pcm: Uint8Array, signal?: AbortSignal): Promise<StudioJob> {
    return this.octets(`/api/studio/${id}/audio`, pcm, signal);
  }

  /** Every clip's mouth crops in order (the frames file), in one upload. */
  async uploadStudioFaces(id: string, frames: Uint8Array, signal?: AbortSignal): Promise<StudioJob> {
    return this.octets(`/api/studio/${id}/faces`, frames, signal);
  }

  startStudio(id: string): Promise<StudioJob> {
    return this.json<StudioJob>('POST', `/api/studio/${id}/start`);
  }

  cancelStudio(id: string): Promise<StudioJob> {
    return this.json<StudioJob>('DELETE', `/api/studio/${id}`);
  }

  /** Follows a studio job until it is done, over server-sent events with polling as the fallback. */
  watchStudio(id: string, onEvent: (event: StudioEvent) => void, signal?: AbortSignal): Promise<StudioJob> {
    return this.watch<StudioJob, StudioEvent>(
      `/api/studio/${id}/events`,
      () => this.getStudio(id),
      (event) => event.job,
      (job) => ({ type: 'job', job }),
      onEvent,
      signal,
    );
  }

  /** One clip's result, as 16-bit PCM at the clip's own rate. */
  async studioResult(
    id: string,
    clipId: string,
    kind: 'deep' | 'voice',
    signal?: AbortSignal,
  ): Promise<Int16Array> {
    const res = await fetch(`${this.base}/api/studio/${id}/clips/${encodeURIComponent(clipId)}/${kind}`, {
      signal: signal ?? null,
    });
    if (!res.ok) {
      await this.parse(res);
      throw new ApiRequestError(res.status, 'http_error', `${res.status} ${res.statusText}`);
    }
    const bytes = await res.arrayBuffer();
    return new Int16Array(bytes, 0, Math.floor(bytes.byteLength / 2));
  }

  /* ---------------------------------------------------------------- recordings on disk */

  /** Every recording mirrored to this computer, newest first. */
  listRecordings(): Promise<RecordingSummary[]> {
    return this.json<RecordingSummary[]>('GET', '/api/recordings', undefined, AbortSignal.timeout(10_000));
  }

  getRecording(id: string, signal?: AbortSignal): Promise<RecordingRecord> {
    return this.json<RecordingRecord>('GET', `/api/recordings/${encodeURIComponent(id)}`, undefined, signal);
  }

  createRecording(body: CreateRecording): Promise<RecordingRecord> {
    return this.json<RecordingRecord>('POST', '/api/recordings', body);
  }

  updateRecording(id: string, patch: UpdateRecording): Promise<RecordingRecord> {
    return this.json<RecordingRecord>('PATCH', `/api/recordings/${encodeURIComponent(id)}`, patch);
  }

  async deleteRecording(id: string): Promise<void> {
    await this.json('DELETE', `/api/recordings/${encodeURIComponent(id)}`);
  }

  async revealRecording(id: string): Promise<void> {
    await this.json('POST', `/api/recordings/${encodeURIComponent(id)}/reveal`);
  }

  /** One of the deck's files, checked against its hash on the way in. */
  async uploadRecordingDeck(
    id: string,
    index: number,
    file: Blob,
    sha256: string,
    signal?: AbortSignal,
  ): Promise<UploadReceipt> {
    const res = await fetch(`${this.base}/api/recordings/${encodeURIComponent(id)}/deck/${index}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', [SHA256_HEADER]: sha256 },
      body: file,
      signal: signal ?? null,
    });
    return (await this.parse(res)) as UploadReceipt;
  }

  async fetchRecordingDeck(id: string, index: number, signal?: AbortSignal): Promise<Blob> {
    const res = await fetch(`${this.base}/api/recordings/${encodeURIComponent(id)}/deck/${index}`, {
      signal: signal ?? null,
    });
    if (!res.ok) await this.parse(res);
    return res.blob();
  }

  /** A phrase's file with what the manifest should say about it; the server keeps it only when the hash matches. */
  async uploadRecordingPhrase(
    id: string,
    phraseId: string,
    meta: PhraseMeta,
    bytes: Uint8Array,
    sha256: string,
    signal?: AbortSignal,
  ): Promise<RecordingPhrase> {
    const params = new URLSearchParams({
      slide: String(meta.slide),
      seconds: String(meta.seconds),
      sitting: String(meta.sitting),
      kind: meta.kind,
      camera: meta.camera ? '1' : '0',
      createdAt: String(meta.createdAt),
    });
    const res = await fetch(
      `${this.base}/api/recordings/${encodeURIComponent(id)}/phrases/${encodeURIComponent(phraseId)}?${params.toString()}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', [SHA256_HEADER]: sha256 },
        body: bytes as BodyInit,
        signal: signal ?? null,
      },
    );
    return (await this.parse(res)) as RecordingPhrase;
  }

  async fetchRecordingPhrase(id: string, phraseId: string, signal?: AbortSignal): Promise<Uint8Array> {
    const res = await fetch(
      `${this.base}/api/recordings/${encodeURIComponent(id)}/phrases/${encodeURIComponent(phraseId)}`,
      { signal: signal ?? null },
    );
    if (!res.ok) await this.parse(res);
    return new Uint8Array(await res.arrayBuffer());
  }

  deleteRecordingPhrase(id: string, phraseId: string): Promise<RecordingRecord> {
    return this.json<RecordingRecord>(
      'DELETE',
      `/api/recordings/${encodeURIComponent(id)}/phrases/${encodeURIComponent(phraseId)}`,
    );
  }

  private async octets(path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<StudioJob> {
    const res = await fetch(`${this.base}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes as BodyInit,
      signal: signal ?? null,
    });
    return (await this.parse(res)) as StudioJob;
  }

  /** Sends a PowerPoint file to the server's renderer and gets the PDF back, with any notes it made. */
  async convertToPdf(
    file: File,
    signal?: AbortSignal,
  ): Promise<{ blob: Blob; pages: number; warnings: string[] }> {
    const res = await fetch(`${this.base}/api/convert?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
      signal: signal ?? null,
    });
    if (!res.ok) {
      await this.parse(res);
      throw new ApiRequestError(res.status, 'http_error', `${res.status} ${res.statusText}`);
    }
    let warnings: string[] = [];
    try {
      const raw = res.headers.get('x-one-take-warnings');
      if (raw) {
        const parsed: unknown = JSON.parse(decodeURIComponent(raw));
        if (Array.isArray(parsed)) warnings = parsed.filter((w): w is string => typeof w === 'string');
      }
    } catch {
      // notes are optional
    }
    return {
      blob: new Blob([await res.arrayBuffer()], { type: 'application/pdf' }),
      pages: Number(res.headers.get('x-one-take-pages') ?? '0') || 0,
      warnings,
    };
  }

  /**
   * Follows a job over server-sent events until it reaches a final state. Falls back to polling when the
   * event stream drops. Resolves with the final job; rejects only on abort.
   */
  watchExport(id: string, onEvent: (event: JobEvent) => void, signal?: AbortSignal): Promise<ExportJob> {
    return this.watch<ExportJob, JobEvent>(
      `/api/exports/${id}/events`,
      () => this.getExport(id),
      (event) => (event.type === 'job' ? event.job : null),
      (job) => ({ type: 'job', job }),
      onEvent,
      signal,
    );
  }

  /** The event-stream-then-poll loop behind `watchExport` and `watchTranscription`. */
  private watch<J extends { state: string }, E>(
    eventsPath: string,
    get: () => Promise<J>,
    jobOf: (event: E) => J | null,
    eventOf: (job: J) => E,
    onEvent: (event: E) => void,
    signal?: AbortSignal,
  ): Promise<J> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let source: EventSource | null = null;
      let pollTimer = 0;
      const finish = (job: J) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(job);
      };
      const cleanup = () => {
        source?.close();
        source = null;
        clearTimeout(pollTimer);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const poll = () => {
        if (settled) return;
        get()
          .then((job) => {
            onEvent(eventOf(job));
            if (TERMINAL.has(job.state)) finish(job);
            else pollTimer = window.setTimeout(poll, 1000);
          })
          .catch(() => {
            pollTimer = window.setTimeout(poll, 2000);
          });
      };

      try {
        source = new EventSource(`${this.base}${eventsPath}`);
        source.onmessage = (e: MessageEvent<string>) => {
          const event = JSON.parse(e.data) as E;
          onEvent(event);
          const job = jobOf(event);
          if (job && TERMINAL.has(job.state)) finish(job);
        };
        source.onerror = () => {
          if (settled) return;
          source?.close();
          source = null;
          poll();
        };
      } catch {
        poll();
      }
    });
  }

  private async json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? null : JSON.stringify(body),
      signal: signal ?? null,
    });
    return (await this.parse(res)) as T;
  }

  private async parse(res: Response): Promise<unknown> {
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const err = (data as Partial<ApiErrorBody> | null)?.error;
      throw new ApiRequestError(
        res.status,
        err?.code ?? 'http_error',
        err?.message ?? `${res.status} ${res.statusText}`,
        err?.details,
      );
    }
    return data;
  }
}
