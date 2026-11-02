/**
 * The mirror of the project on this computer: every phrase and the project state go to the local
 * server's recordings folder as they change, so the recording can be continued from any browser,
 * even one whose storage was wiped.
 *
 * The browser's copy (IndexedDB) stays the working copy; this only follows it. A phrase is queued
 * the moment it is stored, packed into one file (see `pack.ts`), hashed, and sent with the hash;
 * the server keeps it only when the bytes arrived whole. A phrase the server already holds with
 * the same hash is not sent again. The project state (the order, the slide, the sittings, the
 * settings) goes a moment after it changes, and a timer flushes anything still waiting every
 * {@link SYNC_INTERVAL_MS}. When the server cannot be reached the queue waits and tries again
 * with a growing pause; nothing is dropped. One upload runs at a time, in the order things
 * happened, so a delete never overtakes the upload it undoes.
 */
import { type RecordingPhrase, type UpdateRecording } from '@one-take/shared';

import { ApiRequestError, type ApiClient } from '../api/client.js';
import { sha256Hex } from '../core/hash.js';
import { type Segment } from '../core/timeline.js';

import { packSegment, phraseMeta } from './pack.js';

/** Anything still waiting is sent at least this often. */
export const SYNC_INTERVAL_MS = 15_000;
/** The project state goes this long after the last change. */
const META_DEBOUNCE_MS = 800;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 30_000;

export type SyncState =
  /** Nothing is mirrored: no recording is attached (no server, nothing loaded), or it was lost. */
  | { kind: 'off'; reason: string | null }
  | { kind: 'saving'; pending: number }
  | { kind: 'saved'; at: number }
  /** The server could not be reached; the queue waits and tries again. */
  | { kind: 'waiting'; pending: number; reason: string };

type Op = { kind: 'put'; seg: Segment } | { kind: 'delete'; id: string };

export interface RecordingSyncHandlers {
  onState: (state: SyncState) => void;
  /** The recording's folder is gone from the disk: the caller decides what to do with the browser's copy. */
  onLost: (id: string) => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RecordingSync {
  private id: string | null = null;
  /** The hash the server holds for each phrase, so an unchanged phrase is never sent twice. */
  private readonly known = new Map<string, string>();
  /** One pending operation per phrase; a later one replaces an earlier one. */
  private readonly queue = new Map<string, Op>();
  private meta: UpdateRecording | null = null;
  private metaTimer = 0;
  private retryTimer = 0;
  private retryMs = RETRY_MIN_MS;
  private running = false;
  private state: SyncState = { kind: 'off', reason: null };

  constructor(
    private readonly api: ApiClient,
    private readonly handlers: RecordingSyncHandlers,
  ) {
    window.setInterval(() => this.kick(), SYNC_INTERVAL_MS);
  }

  get recordingId(): string | null {
    return this.id;
  }

  get current(): SyncState {
    return this.state;
  }

  /** Operations not yet confirmed by the server. */
  get pending(): number {
    return this.queue.size + (this.meta ? 1 : 0);
  }

  /** Follows a recording from now on; `phrases` is what the server already holds. */
  attach(id: string, phrases: readonly RecordingPhrase[]): void {
    this.id = id;
    this.known.clear();
    for (const p of phrases) this.known.set(p.id, p.sha256);
    this.retryMs = RETRY_MIN_MS;
    this.setState({ kind: 'saved', at: Date.now() });
    this.kick();
  }

  /** Stops following; anything still queued is dropped (flush first when it matters). */
  detach(reason: string | null = null): void {
    this.id = null;
    this.queue.clear();
    this.meta = null;
    this.known.clear();
    clearTimeout(this.metaTimer);
    clearTimeout(this.retryTimer);
    this.setState({ kind: 'off', reason });
  }

  /** The server's hash for a phrase, when it has one. */
  has(id: string): string | undefined {
    return this.known.get(id);
  }

  putSegment(seg: Segment): void {
    if (!this.id) return;
    this.queue.set(seg.id, { kind: 'put', seg });
    this.kick();
  }

  deleteSegment(id: string): void {
    if (!this.id) return;
    this.known.delete(id);
    this.queue.set(id, { kind: 'delete', id });
    this.kick();
  }

  /** The project state; fields given later replace earlier ones before anything is sent. */
  putMeta(patch: UpdateRecording): void {
    if (!this.id) return;
    this.meta = { ...(this.meta ?? {}), ...patch };
    clearTimeout(this.metaTimer);
    this.metaTimer = window.setTimeout(() => this.kick(), META_DEBOUNCE_MS);
    this.setState(this.state.kind === 'waiting' ? this.state : { kind: 'saving', pending: this.pending });
  }

  /**
   * Sends everything queued and resolves once the server has it all, or once it is clear nothing
   * more can be sent for now (the server is down), or after `timeoutMs`.
   */
  async flush(timeoutMs = 20_000): Promise<boolean> {
    clearTimeout(this.metaTimer);
    const deadline = Date.now() + timeoutMs;
    this.kick();
    while (this.id && this.pending > 0 && Date.now() < deadline) {
      // the server is away: one more try a second, not a storm
      if (this.state.kind === 'waiting' && !this.running) {
        await sleep(1000);
        this.kick();
      }
      await sleep(50);
    }
    return this.pending === 0;
  }

  /** The state given while an attempt was running (a method, so the type checker does not narrow it away). */
  private metaSince(): UpdateRecording {
    return this.meta ?? {};
  }

  private setState(state: SyncState): void {
    this.state = state;
    this.handlers.onState(state);
  }

  private kick(): void {
    if (!this.id || this.running || this.pending === 0) return;
    clearTimeout(this.retryTimer);
    void this.run();
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      while (this.id) {
        const entry = this.queue.entries().next();
        const next: [string, Op] | null = entry.done ? null : entry.value;
        const meta = next ? null : this.meta;
        if (!next && !meta) break;
        this.setState({ kind: 'saving', pending: this.pending });
        try {
          if (next) {
            await this.send(next[1]);
            // a newer operation for the same phrase may have arrived meanwhile: it stays
            if (this.queue.get(next[0]) === next[1]) this.queue.delete(next[0]);
          } else if (meta) {
            this.meta = null;
            try {
              await this.api.updateRecording(this.id, meta);
            } catch (error) {
              // what was given since the attempt wins over what failed
              this.meta = { ...meta, ...this.metaSince() };
              throw error;
            }
          }
          this.retryMs = RETRY_MIN_MS;
        } catch (error) {
          if (error instanceof ApiRequestError && error.code === 'recording_not_found') {
            const lost = this.id;
            this.detach('the recording was deleted from this computer');
            this.handlers.onLost(lost);
            return;
          }
          if (
            error instanceof ApiRequestError &&
            error.status >= 400 &&
            error.status < 500 &&
            error.status !== 408
          ) {
            // the server understood and refused: there is no point sending the same thing again
            console.warn(`recording: ${error.message}`, next ?? meta);
            if (next && this.queue.get(next[0]) === next[1]) this.queue.delete(next[0]);
            if (!next) this.meta = null;
            continue;
          }
          // the server is away: wait and try again
          const reason = error instanceof Error ? error.message : String(error);
          this.setState({ kind: 'waiting', pending: this.pending, reason });
          clearTimeout(this.retryTimer);
          this.retryTimer = window.setTimeout(() => this.kick(), this.retryMs);
          this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
          return;
        }
      }
      if (this.id) this.setState({ kind: 'saved', at: Date.now() });
    } finally {
      this.running = false;
    }
  }

  private async send(op: Op): Promise<void> {
    const id = this.id;
    if (!id) return;
    if (op.kind === 'delete') {
      await this.api.deleteRecordingPhrase(id, op.id);
      return;
    }
    const bytes = packSegment(op.seg);
    const sha256 = await sha256Hex(bytes);
    if (this.known.get(op.seg.id) === sha256) return;
    await this.api.uploadRecordingPhrase(id, op.seg.id, phraseMeta(op.seg), bytes, sha256);
    this.known.set(op.seg.id, sha256);
  }
}
