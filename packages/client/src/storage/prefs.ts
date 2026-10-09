/** Small per-browser preferences (not project data) kept in localStorage; every access is fail-safe. */

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
}

const DEFAULT_PREFS: Prefs = { welcomeSeen: false, tips: true, theme: 'dark' };

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      welcomeSeen: typeof parsed.welcomeSeen === 'boolean' ? parsed.welcomeSeen : DEFAULT_PREFS.welcomeSeen,
      tips: typeof parsed.tips === 'boolean' ? parsed.tips : DEFAULT_PREFS.tips,
      theme: parsed.theme === 'light' || parsed.theme === 'dark' ? parsed.theme : DEFAULT_PREFS.theme,
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
