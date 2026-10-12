/** Small per-browser preferences (not project data) kept in localStorage; every access is fail-safe. */
import { type CaptureMode } from '../core/recorder.js';

const KEY = 'one-take.prefs';

/** grauity's two themes; the class on <html> picks one. */
export type Theme = 'dark' | 'light';

export interface Prefs {
  /** The welcome tour has been shown (or dismissed) once. */
  welcomeSeen: boolean;
  /** Show the step-by-step tip on the stage while working. */
  tips: boolean;
  /** Dark (the default, like a projection room) or light. */
  theme: Theme;
  /** `auto`: the detector decides when you speak. `hold`: only while the talk key or button is held. */
  captureMode: CaptureMode;
  /** The chosen microphone's device id; empty for the browser's default. */
  micDeviceId: string;
  /** Run the noise filter over the microphone. */
  noiseFilter: boolean;
}

const DEFAULT_PREFS: Prefs = {
  welcomeSeen: false,
  tips: true,
  theme: 'dark',
  captureMode: 'auto',
  micDeviceId: '',
  noiseFilter: true,
};

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      welcomeSeen: typeof parsed.welcomeSeen === 'boolean' ? parsed.welcomeSeen : DEFAULT_PREFS.welcomeSeen,
      tips: typeof parsed.tips === 'boolean' ? parsed.tips : DEFAULT_PREFS.tips,
      theme: parsed.theme === 'light' || parsed.theme === 'dark' ? parsed.theme : DEFAULT_PREFS.theme,
      captureMode:
        parsed.captureMode === 'hold' || parsed.captureMode === 'auto'
          ? parsed.captureMode
          : DEFAULT_PREFS.captureMode,
      micDeviceId: typeof parsed.micDeviceId === 'string' ? parsed.micDeviceId : DEFAULT_PREFS.micDeviceId,
      noiseFilter: typeof parsed.noiseFilter === 'boolean' ? parsed.noiseFilter : DEFAULT_PREFS.noiseFilter,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(patch: Partial<Prefs>): Prefs {
  const next = { ...loadPrefs(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode or storage blocked: the preference simply does not persist */
  }
  return next;
}
