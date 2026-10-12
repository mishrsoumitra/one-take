/**
 * The exports dialog: every video the local server has saved, newest first, to watch in place, show in
 * the file manager, or delete. The list comes from the server (`GET /api/library`), which remembers
 * its exports across restarts; files saved through the browser's own save dialog never pass through
 * the server and are not listed.
 */
import {
  AUDIO_CODEC_INFO,
  CONTAINER_INFO,
  formatBytes,
  formatDuration,
  VIDEO_CODEC_INFO,
  type ExportRecord,
  type ServerCapabilities,
} from '@one-take/shared';

import { ApiRequestError, type ApiClient } from '../api/client.js';

import { type Confirm } from './confirm.js';
import { h, replaceChildren } from './dom.js';
import { icon } from './icon.js';
import { type Toast } from './toast.js';

export interface LibraryDeps {
  api: ApiClient;
  serverCaps: () => ServerCapabilities | null;
  confirm: Confirm;
  toast: Toast;
}

/** Containers the <video> element plays in place; the rest open in the default player. */
const PLAYS_IN_PAGE = new Set(['mp4', 'fmp4', 'webm', 'mov']);

/** `/Users/me/Movies/One Take` → `~/Movies/One Take`. */
function shortPath(dir: string, home: string | undefined): string {
  if (home && (dir === home || dir.startsWith(`${home}/`) || dir.startsWith(`${home}\\`))) {
    return `~${dir.slice(home.length)}`;
  }
  return dir;
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export class Library {
  private readonly overlay: HTMLElement;
  private readonly list: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly status: HTMLElement;
  private readonly btnRefresh: HTMLButtonElement;
  private readonly btnClose: HTMLButtonElement;
  private records: ExportRecord[] = [];
  /** The export whose player is open, if any. */
  private playingId: string | null = null;
  private loading = false;

  constructor(
    parent: HTMLElement,
    private readonly deps: LibraryDeps,
  ) {
    this.list = h('div', { class: 'recs', id: 'libraryList' });
    this.summary = h('div', { class: 'hint summary-line', id: 'librarySummary' });
    this.status = h('div', { class: 'hint status', id: 'libraryStatus' });
    this.btnRefresh = h(
      'button',
      { class: 'ghost', id: 'btnLibraryRefresh', on: { click: () => void this.load() } },
      icon('refresh', 16),
      'Refresh',
    );
    this.btnClose = h('button', { id: 'btnLibraryClose', on: { click: () => this.close() } }, 'Close');
    this.overlay = h(
      'div',
      { class: 'modal library', id: 'libraryModal' },
      h(
        'div',
        { class: 'box', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'libraryTitle' } },
        h('h3', { id: 'libraryTitle' }, 'Exported videos'),
        this.summary,
        this.list,
        this.status,
        h(
          'div',
          { class: 'hint note' },
          'Videos saved to a folder on this computer are listed, even after the server restarts. Files saved through the browser (save dialog or download) are not.',
        ),
        h('div', { class: 'actions' }, this.btnRefresh, h('div', { class: 'spacer' }), this.btnClose),
      ),
    );
    this.overlay.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        this.close();
      }
    });
    this.overlay.addEventListener('click', (ev) => {
      if (ev.target === this.overlay) this.close();
    });
    parent.appendChild(this.overlay);
  }

  get isOpen(): boolean {
    return this.overlay.classList.contains('on');
  }

  /** The list as last loaded, for the end-to-end tests. */
  get items(): readonly ExportRecord[] {
    return this.records;
  }

  open(): void {
    this.overlay.classList.add('on');
    this.btnClose.focus();
    void this.load();
  }

  close(): void {
    this.stopPlayback();
    this.overlay.classList.remove('on');
  }

  /** Fetches the list from the server and redraws it. */
  async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.btnRefresh.disabled = true;
    try {
      if (!this.deps.serverCaps()) {
        this.records = [];
        this.render(
          'The local server is not running. Start it with "npm start" to see the videos it has saved.',
        );
        return;
      }
      this.records = await this.deps.api.listLibrary();
      this.render(null);
    } catch (error) {
      this.render(`Could not load the list: ${(error as Error).message}`);
    } finally {
      this.loading = false;
      this.btnRefresh.disabled = false;
    }
  }

  private render(problem: string | null): void {
    const home = this.deps.serverCaps()?.homeDirectory;
    const present = this.records.filter((r) => r.exists);
    const onDisk = present.reduce((sum, r) => sum + r.bytes, 0);
    this.summary.textContent =
      this.records.length === 0
        ? ''
        : `${this.records.length} export${this.records.length === 1 ? '' : 's'}${present.length < this.records.length ? ` (${this.records.length - present.length} no longer on disk)` : ''} · ${formatBytes(onDisk)} on disk`;
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
          'No exports yet. Videos you save to a folder on this computer appear here, ready to watch, find or delete.',
        ),
      );
      return;
    }
    replaceChildren(this.list, ...this.records.map((r) => this.row(r, home)));
  }

  private row(r: ExportRecord, home: string | undefined): HTMLElement {
    const info = CONTAINER_INFO[r.container];
    const video = VIDEO_CODEC_INFO[r.videoCodec].label.split(' / ')[0] ?? r.videoCodec;
    const audio = AUDIO_CODEC_INFO[r.audioCodec].label;
    const facts = [
      `${r.width}×${r.height}`,
      `${r.fps} fps`,
      `${video} + ${audio}`,
      formatDuration(r.durationSec),
      formatBytes(r.bytes),
    ].join(' · ');
    // the folder last, so a long path is what the ellipsis eats (Show in folder has the whole of it)
    const where = [when(r.createdAt), r.encoder, shortPath(r.directory, home)].filter((x) => x).join(' · ');
    const playable = r.exists && r.kind === 'file' && PLAYS_IN_PAGE.has(r.container);
    const player = h('div', { class: 'player', hidden: true });
    const btnPlay = h(
      'button',
      {
        class: 'primary',
        disabled: !r.exists,
        title: playable
          ? 'Watch it here'
          : r.kind === 'directory'
            ? 'Open the folder'
            : 'Open in the default player',
        on: {
          click: () => {
            if (playable) this.togglePlayer(r, player, btnPlay);
            else void this.deps.api.openLibraryItem(r.id).catch((e: unknown) => this.report(e));
          },
        },
      },
      icon('play', 16),
      playable ? 'Play' : 'Open',
    );
    const btnReveal = h(
      'button',
      {
        disabled: !r.exists,
        title: 'Show in Finder or Explorer',
        on: { click: () => void this.deps.api.revealLibraryItem(r.id).catch((e: unknown) => this.report(e)) },
      },
      icon('folder-open', 16),
      'Show in folder',
    );
    const btnDelete = h(
      'button',
      {
        class: 'ghost del',
        title: r.exists ? 'Delete the file from this computer' : 'Remove this entry from the list',
        on: { click: () => void this.remove(r) },
      },
      icon('bin', 16),
      r.exists ? 'Delete' : 'Remove from list',
    );
    return h(
      'div',
      { class: `rec${r.exists ? '' : ' missing'}`, dataset: { id: r.id } },
      h(
        'div',
        { class: 'rec-main' },
        h('div', { class: 'ico-wrap' }, icon(r.kind === 'directory' ? 'folder' : 'play', 20)),
        h(
          'div',
          { class: 'meta' },
          h(
            'b',
            { title: r.path },
            h('span', { class: 'name' }, r.fileName),
            h('span', { class: 'chip-tag' }, info.label.split(' (')[0] ?? info.label),
            r.exists ? null : h('span', { class: 'chip-tag warning' }, 'not on disk'),
          ),
          h('small', null, facts),
          h('small', { class: 'where', title: r.path }, where),
        ),
        h('div', { class: 'actions inline' }, btnPlay, btnReveal, btnDelete),
      ),
      player,
    );
  }

  /** Opens the in-page player under the row, or closes it again. One plays at a time. */
  private togglePlayer(r: ExportRecord, player: HTMLElement, button: HTMLButtonElement): void {
    if (this.playingId === r.id) {
      this.stopPlayback();
      return;
    }
    this.stopPlayback();
    this.playingId = r.id;
    const video = h('video', {
      src: this.deps.api.libraryFileUrl(r.id),
      attrs: { controls: '', preload: 'metadata' },
    });
    video.onerror = () => {
      replaceChildren(
        player,
        h(
          'div',
          { class: 'hint' },
          'This browser cannot play the file here. ',
          h(
            'button',
            {
              class: 'ghost',
              on: {
                click: () => void this.deps.api.openLibraryItem(r.id).catch((e: unknown) => this.report(e)),
              },
            },
            'Open in the default player',
          ),
        ),
      );
    };
    replaceChildren(player, video);
    player.hidden = false;
    button.classList.add('on');
    void video.play().catch(() => undefined);
  }

  private stopPlayback(): void {
    if (this.playingId === null) return;
    const row = this.list.querySelector<HTMLElement>(`.rec[data-id="${this.playingId}"]`);
    const video = row?.querySelector('video');
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    const player = row?.querySelector<HTMLElement>('.player');
    if (player) {
      replaceChildren(player);
      player.hidden = true;
    }
    row?.querySelector('.actions button')?.classList.remove('on');
    this.playingId = null;
  }

  private async remove(r: ExportRecord): Promise<void> {
    if (r.exists) {
      const what = r.kind === 'directory' ? `the folder ${r.fileName} and its segments` : r.fileName;
      const ok = await this.deps.confirm.ask({
        title: `Delete ${r.fileName}?`,
        message: `This deletes ${what} from ${r.directory}. It cannot be brought back.`,
        confirm: 'Delete',
        cancel: 'Keep',
      });
      if (!ok) return;
    }
    if (this.playingId === r.id) this.stopPlayback();
    try {
      const result = await this.deps.api.deleteLibraryItem(r.id, r.exists);
      this.records = this.records.filter((x) => x.id !== r.id);
      this.render(null);
      this.deps.toast.show(
        result.deleted ? `Deleted ${r.fileName}.` : `Removed ${r.fileName} from the list.`,
      );
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
