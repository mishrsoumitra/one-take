import { type ExportRequest, type PresentationExtension, type RecordingSitting } from '@one-take/shared';

import { type TimelineSettings } from '../core/timeline.js';
import { type VadSettings } from '../core/vad.js';

export interface Slide {
  index: number;
  width: number;
  height: number;
  /** Full-size JPEG used for export. */
  blob: Blob;
  url: string;
  thumbUrl: string;
}

export interface SlideSource {
  kind: 'pdf' | 'images';
  files: { name: string; type: string; blob: Blob }[];
  /** Set when the PDF came out of a presentation file the server converted; keeps the original name. */
  origin?: { name: string; type: string; warnings: string[] };
  /**
   * The hash of what the user picked (the PowerPoint file, the PDF, the images in order; see
   * `core/hash.ts`): the same deck gives the same hash, which is how a saved recording of it is found.
   */
  hash?: string;
}

/** A PowerPoint-style file the user picked; it becomes a `SlideSource` once the server has converted it. */
export interface PresentationPick {
  kind: 'presentation';
  file: File;
  extension: PresentationExtension;
}

export type Settings = VadSettings & TimelineSettings;

export const DEFAULT_SETTINGS: Settings = {
  threshold: -45,
  gapMs: 150,
  hangoverMs: 700,
  prerollMs: 200,
  tailMs: 150,
  minSpeechMs: 200,
  slideGapMs: 250,
};

/** Project-level bookkeeping persisted next to the segments. */
export interface ProjectMeta {
  order: string[];
  current: number;
  settings: Partial<Settings>;
  savedAt: number;
  segmentCounter: number;
  exportRequest: ExportRequest | null;
  /** The recording on this computer this project is mirrored to (see `storage/remote.ts`), once there is one. */
  recordingId?: string | null;
  /** The sitting the project is in now, and every sitting so far. */
  sitting?: number;
  sittings?: RecordingSitting[];
}
