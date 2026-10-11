import { type CaptureMode } from '../core/recorder.js';
import { type Segment } from '../core/timeline.js';

import { DEFAULT_SETTINGS, type Settings, type Slide, type SlideSource } from './types.js';

export interface AppState {
  slides: Slide[];
  slideSource: SlideSource | null;
  current: number;
  segments: Segment[];
  deleted: { seg: Segment; index: number }[];
  armed: boolean;
  muted: boolean;
  /** How the mic is driven: the detector alone, or only while the talk key is held. */
  mode: CaptureMode;
  /** Press-to-speak: the talk key or button is down right now. */
  held: boolean;
  speaking: boolean;
  previewing: boolean;
  exporting: boolean;
}

export type StoreEvent = 'slides' | 'segments' | 'current' | 'status' | 'settings';

type Listener = () => void;

/** Plain mutable state plus a tiny event bus; views subscribe to the events they care about. */
export class Store {
  readonly state: AppState = {
    slides: [],
    slideSource: null,
    current: 0,
    segments: [],
    deleted: [],
    armed: false,
    muted: false,
    mode: 'auto',
    held: false,
    speaking: false,
    previewing: false,
    exporting: false,
  };
  readonly settings: Settings = { ...DEFAULT_SETTINGS };
  private readonly listeners = new Map<StoreEvent, Set<Listener>>();

  on(event: StoreEvent, listener: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  emit(...events: StoreEvent[]): void {
    for (const event of events) {
      const set = this.listeners.get(event);
      if (set) for (const l of set) l();
    }
  }

  get busy(): boolean {
    return this.state.previewing || this.state.exporting;
  }
}
