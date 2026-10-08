import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

import { type ProjectMeta, type SlideSource } from '../app/types.js';
import { type Segment } from '../core/timeline.js';

interface OneTakeDB extends DBSchema {
  meta: { key: string; value: ProjectMeta };
  files: { key: string; value: SlideSource };
  segments: { key: string; value: Segment };
}

/** Everything is written the moment it exists, so a crash or reload loses nothing. */
export class ProjectStore {
  private db: Promise<IDBPDatabase<OneTakeDB>> | null = null;

  private open(): Promise<IDBPDatabase<OneTakeDB>> {
    this.db ??= openDB<OneTakeDB>('one-take', 2, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
        if (!db.objectStoreNames.contains('segments')) db.createObjectStore('segments', { keyPath: 'id' });
      },
    });
    return this.db;
  }

  private async guard<T>(fn: (db: IDBPDatabase<OneTakeDB>) => Promise<T>): Promise<T | undefined> {
    try {
      return await fn(await this.open());
    } catch (error) {
      console.warn('IndexedDB unavailable', error);
      return undefined;
    }
  }

  getMeta(): Promise<ProjectMeta | undefined> {
    return this.guard((db) => db.get('meta', 'project'));
  }

  async putMeta(meta: ProjectMeta): Promise<void> {
    await this.guard((db) => db.put('meta', meta, 'project'));
  }

  getSlideSource(): Promise<SlideSource | undefined> {
    return this.guard((db) => db.get('files', 'slides'));
  }

  async putSlideSource(source: SlideSource): Promise<void> {
    await this.guard((db) => db.put('files', source, 'slides'));
  }

  async getSegments(): Promise<Segment[]> {
    return (await this.guard((db) => db.getAll('segments'))) ?? [];
  }

  async putSegment(seg: Segment): Promise<void> {
    await this.guard((db) => db.put('segments', seg));
  }

  async deleteSegment(id: string): Promise<void> {
    await this.guard((db) => db.delete('segments', id));
  }

  async clear(): Promise<void> {
    await this.guard(async (db) => {
      const tx = db.transaction(['meta', 'files', 'segments'], 'readwrite');
      await Promise.all([
        tx.objectStore('meta').clear(),
        tx.objectStore('files').clear(),
        tx.objectStore('segments').clear(),
        tx.done,
      ]);
    });
  }
}
