import { formatBytes, type DirectoryListing, type ServerCapabilities } from '@one-take/shared';

import { type ApiClient } from '../api/client.js';

import { clear, h } from './dom.js';
import { icon } from './icon.js';

/** Browses folders on the computer running the server and returns the chosen path. */
export class FolderPicker {
  private readonly overlay: HTMLElement;
  private readonly pathInput: HTMLInputElement;
  private readonly list: HTMLElement;
  private readonly shortcuts: HTMLElement;
  private readonly status: HTMLElement;
  private readonly btnChoose: HTMLButtonElement;
  private readonly btnUp: HTMLButtonElement;
  private readonly newRow: HTMLElement;
  private readonly newName: HTMLInputElement;
  private listing: DirectoryListing | null = null;
  private resolve: ((value: string | null) => void) | null = null;

  constructor(
    parent: HTMLElement,
    private readonly api: ApiClient,
  ) {
    this.pathInput = h('input', { type: 'text', class: 'path', placeholder: '/path/to/folder' });
    this.list = h('div', { class: 'folders' });
    this.shortcuts = h('div', { class: 'shortcuts' });
    this.status = h('div', { class: 'hint status' });
    this.btnChoose = h('button', { class: 'primary' }, icon('check'), 'Choose this folder');
    this.btnUp = h('button', { title: 'Parent folder' }, icon('arrow-up', 16), 'Up');
    this.newName = h('input', { type: 'text', placeholder: 'New folder name' });
    this.newRow = h(
      'div',
      { class: 'newrow', hidden: true },
      this.newName,
      h('button', { on: { click: () => void this.createFolder() } }, 'Create'),
      h(
        'button',
        {
          class: 'ghost',
          on: {
            click: () => {
              this.newRow.hidden = true;
            },
          },
        },
        'Cancel',
      ),
    );
    this.overlay = h(
      'div',
      { class: 'modal picker' },
      h(
        'div',
        { class: 'box' },
        h('h3', null, 'Choose a folder'),
        this.shortcuts,
        h(
          'div',
          { class: 'pathrow' },
          this.btnUp,
          this.pathInput,
          h('button', { on: { click: () => void this.load(this.pathInput.value) } }, 'Go'),
        ),
        this.list,
        this.newRow,
        this.status,
        h(
          'div',
          { class: 'actions' },
          h(
            'button',
            {
              class: 'ghost',
              on: {
                click: () => {
                  this.newRow.hidden = false;
                  this.newName.focus();
                },
              },
            },
            icon('plus'),
            'New folder…',
          ),
          h('div', { class: 'spacer' }),
          h('button', { on: { click: () => this.finish(null) } }, 'Cancel'),
          this.btnChoose,
        ),
      ),
    );
    this.btnChoose.onclick = () => this.finish(this.listing?.path ?? null);
    this.btnUp.onclick = () => {
      if (this.listing?.parent) void this.load(this.listing.parent);
    };
    this.pathInput.onkeydown = (e) => {
      if (e.key === 'Enter') void this.load(this.pathInput.value);
    };
    this.newName.onkeydown = (e) => {
      if (e.key === 'Enter') void this.createFolder();
    };
    this.overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.finish(null);
    });
    parent.appendChild(this.overlay);
  }

  get isOpen(): boolean {
    return this.overlay.classList.contains('on');
  }

  pick(initialPath: string, caps: ServerCapabilities): Promise<string | null> {
    clear(this.shortcuts);
    for (const s of caps.shortcuts) {
      this.shortcuts.appendChild(
        h('button', { class: 'chip', on: { click: () => void this.load(s.path) } }, s.label),
      );
    }
    this.overlay.classList.add('on');
    this.newRow.hidden = true;
    void this.load(initialPath || caps.defaultDirectory);
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  private finish(value: string | null): void {
    this.overlay.classList.remove('on');
    const r = this.resolve;
    this.resolve = null;
    r?.(value);
  }

  private async load(path: string): Promise<void> {
    this.status.textContent = 'Loading…';
    try {
      const listing = await this.api.listDirectory(path);
      this.listing = listing;
      this.pathInput.value = listing.path;
      this.btnUp.disabled = listing.parent === null;
      clear(this.list);
      if (!listing.exists) {
        this.list.appendChild(
          h(
            'div',
            { class: 'hint empty' },
            'This folder does not exist yet. Use "New folder…" to create it.',
          ),
        );
      } else if (listing.entries.length === 0) {
        this.list.appendChild(h('div', { class: 'hint empty' }, 'No sub-folders.'));
      }
      for (const entry of listing.entries) {
        this.list.appendChild(
          h(
            'div',
            { class: 'folder', on: { click: () => void this.load(entry.path) } },
            icon('folder', 16),
            entry.name,
          ),
        );
      }
      const free = listing.freeBytes === null ? '' : ` · ${formatBytes(listing.freeBytes)} free`;
      this.status.textContent = listing.exists
        ? listing.writable
          ? `Writable${free}`
          : 'Not writable: choose another folder'
        : 'Does not exist';
      this.btnChoose.disabled = !listing.exists || !listing.writable;
    } catch (error) {
      this.status.textContent = `Could not list folder: ${(error as Error).message}`;
      this.btnChoose.disabled = true;
    }
  }

  private async createFolder(): Promise<void> {
    const name = this.newName.value.trim();
    const base = this.listing?.path ?? this.pathInput.value;
    if (!name || !base) return;
    const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
    try {
      const created = await this.api.makeDirectory(`${base.replace(/[\\/]+$/, '')}${sep}${name}`);
      this.newName.value = '';
      this.newRow.hidden = true;
      await this.load(created.path);
    } catch (error) {
      this.status.textContent = `Could not create folder: ${(error as Error).message}`;
    }
  }
}
