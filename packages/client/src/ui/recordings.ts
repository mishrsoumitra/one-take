/**
 * The recordings saved on this computer: the rows that list them (in the Library and on the empty
 * stage) and what can be done with each: continue it, start again on its deck, show its folder, or
 * delete it. The list comes from the local server (`GET /api/recordings`).
 */
import {
  formatBytes,
  formatDuration,
  type RecordingSummary,
  type ServerCapabilities,
} from '@one-take/shared';

import { ApiRequestError, type ApiClient } from '../api/client.js';

import { type Confirm } from './confirm.js';
import { h, replaceChildren } from './dom.js';
import { icon } from './icon.js';
import { type Toast } from './toast.js';

export interface RecordingsDeps {
  api: ApiClient;
  serverCaps: () => ServerCapabilities | null;
  confirm: Confirm;
  toast: Toast;
  /** The recording open in the app right now, if any. */
  currentId: () => string | null;
  onContinue: (recording: RecordingSummary) => void;
  onStartAgain: (recording: RecordingSummary) => void;
  /** The recording open in the app was deleted: the app lets go of it. */
  onDeletedCurrent: (id: string) => void;
}

/** `/Users/me/.one-take/recordings/x` → `~/.one-take/recordings/x`. */
function shortPath(dir: string, home: string | undefined): string {
  if (home && (dir === home || dir.startsWith(`${home}/`) || dir.startsWith(`${home}\\`))) {
    return `~${dir.slice(home.length)}`;
  }
  return dir;
}

/** `just now`, `12 min ago`, `3 h ago`, else the date and time. */
export function ago(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 24 * 3600) return `${Math.round(sec / 3600)} h ago`;
  return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** One line on what a recording holds: `6 phrases · 1:42 · 2 sittings · camera · pen · last on slide 5 of 12`. */
export function describeRecording(r: RecordingSummary): string {
  const parts = [
    `${r.phrases} ${r.phrases === 1 ? 'phrase' : 'phrases'}`,
    formatDuration(r.seconds),
    `${r.sittings} ${r.sittings === 1 ? 'sitting' : 'sittings'}`,
  ];
  if (r.camera) parts.push('camera');
  if (r.ink) parts.push('pen');
  if (r.phrases > 0) parts.push(`last on slide ${Math.max(r.lastSlide, r.current) + 1} of ${r.slides}`);
  else parts.push(`${r.slides} slides`);
  return parts.join(' · ');
}

export class RecordingsPanel {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly status: HTMLElement;
  private records: RecordingSummary[] = [];
  private loading = false;

  constructor(private readonly deps: RecordingsDeps) {
    this.list = h('div', { class: 'recs', id: 'recordingsList' });
    this.summary = h('div', { class: 'hint summary-line', id: 'recordingsSummary' });
    this.status = h('div', { class: 'hint status', id: 'recordingsStatus' });
    this.el = h(
      'div',
      { class: 'pane', id: 'recordingsPane' },
      this.summary,
      this.list,
      this.status,
      h(
        'div',
        { class: 'hint note' },
        'Every recording is mirrored to a folder on this computer as you make it: the deck, each phrase as soon as it is stored, and where you are. Continue one from any browser, even after the browser’s storage was cleared, or start again on the same deck; the earlier recording stays.',
      ),
    );
  }

  /** The list as last loaded, for the end-to-end tests. */
  get items(): readonly RecordingSummary[] {
    return this.records;
  }

  /** Fetches the list from the server and redraws it. */
  async load(): Promise<RecordingSummary[]> {
    if (this.loading) return this.records;
    this.loading = true;
    try {
      if (!this.deps.serverCaps()) {
        this.records = [];
        this.render(
          'The local server is not running. Start it with "npm start" to see the recordings saved on this computer.',
        );
        return this.records;
      }
      this.records = await this.deps.api.listRecordings();
      this.render(null);
    } catch (error) {
      this.render(`Could not load the list: ${(error as Error).message}`);
    } finally {
      this.loading = false;
    }
    return this.records;
  }

  private render(problem: string | null): void {
    const home = this.deps.serverCaps()?.homeDirectory;
    const bytes = this.records.reduce((sum, r) => sum + r.bytes, 0);
    this.summary.textContent =
      this.records.length === 0
        ? ''
        : `${this.records.length} recording${this.records.length === 1 ? '' : 's'} · ${formatBytes(bytes)} on disk · ${shortPath(this.deps.serverCaps()?.recordingsDirectory ?? '', home)}`;
    this.status.textContent = problem ?? '';
    this.status.classList.toggle('error', problem !== null);
    if (problem !== null) {
      replaceChildren(this.list);
      return;
    }
    if (this.records.length === 0) {
      replaceChildren(
        this.list,
        h(
          'div',
          { class: 'empty' },
          'No recordings yet. Load a deck and start the mic: the recording is saved here as you go, ready to continue another day.',
        ),
      );
      return;
    }
    replaceChildren(this.list, ...this.records.map((r) => this.row(r, home)));
  }

  private row(r: RecordingSummary, home: string | undefined): HTMLElement {
    const current = this.deps.currentId() === r.id;
    const where = [`Saved ${ago(r.updatedAt)}`, formatBytes(r.bytes), shortPath(r.path, home)].join(' · ');
    const btnContinue = h(
      'button',
      {
        class: 'primary continue',
        disabled: current || !r.deckReady,
        title: current
          ? 'This is the recording you are working on'
          : r.deckReady
            ? `Load the deck and every phrase, and go on from slide ${Math.max(r.lastSlide, r.current) + 1}`
            : 'The deck did not finish uploading; load the deck again to continue',
        on: { click: () => this.deps.onContinue(r) },
      },
      icon('play', 16),
      current ? 'Open now' : 'Continue',
    );
    const btnAgain = h(
      'button',
      {
        class: 'again',
        disabled: !r.deckReady,
        title: 'A new recording of the same deck, from the first slide; this one stays saved',
        on: { click: () => this.deps.onStartAgain(r) },
      },
      icon('refresh', 16),
      'Start again',
    );
    const btnReveal = h(
      'button',
      {
        title: 'Show the recording’s folder in Finder or Explorer',
        on: { click: () => void this.deps.api.revealRecording(r.id).catch((e: unknown) => this.report(e)) },
      },
      icon('folder-open', 16),
      'Show in folder',
    );
    const btnDelete = h(
      'button',
      {
        class: 'ghost del',
        title: 'Delete the recording from this computer',
        on: { click: () => void this.remove(r) },
      },
      icon('bin', 16),
      'Delete',
    );
    return h(
      'div',
      { class: `rec${current ? ' current' : ''}`, dataset: { id: r.id } },
      h(
        'div',
        { class: 'rec-main' },
        h('div', { class: 'ico-wrap' }, icon(r.ink ? 'pen' : r.camera ? 'video' : 'mic', 20)),
        h(
          'div',
          { class: 'meta' },
          h(
            'b',
            { title: r.name },
            h('span', { class: 'name' }, r.name),
            current ? h('span', { class: 'chip-tag' }, 'open now') : null,
            r.deckReady ? null : h('span', { class: 'chip-tag warning' }, 'deck incomplete'),
          ),
          h('small', null, describeRecording(r)),
          h('small', { class: 'where', title: r.path }, where),
        ),
        h('div', { class: 'actions inline' }, btnContinue, btnAgain, btnReveal, btnDelete),
      ),
    );
  }

  private async remove(r: RecordingSummary): Promise<void> {
    const current = this.deps.currentId() === r.id;
    const ok = await this.deps.confirm.ask({
      title: `Delete the recording of ${r.name}?`,
      message: `${describeRecording(r)}. The folder and everything in it are deleted from this computer${current ? '; what this browser holds of it is dropped too, and the slides close' : ''}. This cannot be undone.`,
      confirm: 'Delete',
      cancel: 'Keep',
    });
    if (!ok) return;
    try {
      if (current) this.deps.onDeletedCurrent(r.id);
      await this.deps.api.deleteRecording(r.id);
      this.records = this.records.filter((x) => x.id !== r.id);
      this.render(null);
      this.deps.toast.show(`Deleted the recording of ${r.name}.`);
    } catch (error) {
      this.report(error);
      void this.load();
    }
  }

  private report(error: unknown): void {
    const message =
      error instanceof ApiRequestError || error instanceof Error ? error.message : 'Something went wrong.';
    this.deps.toast.show(message);
  }
}

/** A short row for the empty stage: the deck, one line about it, Continue and Start again. */
export function savedRecordingRow(
  r: RecordingSummary,
  handlers: { onContinue: (r: RecordingSummary) => void; onStartAgain: (r: RecordingSummary) => void },
): HTMLElement {
  return h(
    'div',
    { class: 'saved-rec', dataset: { id: r.id } },
    h('div', { class: 'ico-wrap' }, icon(r.ink ? 'pen' : r.camera ? 'video' : 'mic', 20)),
    h(
      'div',
      { class: 'meta' },
      h('b', { class: 'name', title: r.name }, r.name),
      h('small', null, `${describeRecording(r)} · saved ${ago(r.updatedAt)}`),
    ),
    h(
      'div',
      { class: 'actions inline' },
      h(
        'button',
        {
          class: 'primary continue',
          disabled: !r.deckReady,
          title: `Go on from slide ${Math.max(r.lastSlide, r.current) + 1}`,
          on: { click: () => handlers.onContinue(r) },
        },
        icon('play', 16),
        'Continue',
      ),
      h(
        'button',
        {
          class: 'again',
          disabled: !r.deckReady,
          title: 'A new recording of the same deck; this one stays saved',
          on: { click: () => handlers.onStartAgain(r) },
        },
        icon('refresh', 16),
        'Start again',
      ),
    ),
  );
}
