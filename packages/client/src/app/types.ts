import { type ExportRequest } from '@one-take/shared';

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
}
