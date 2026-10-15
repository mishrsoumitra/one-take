/** Small per-browser preferences (not project data) kept in localStorage; every access is fail-safe. */
import { type NoiseFilterMode } from '../audio/mic.js';
import { DEFAULT_CAMERA_LAYOUT, normalizeLayout, type CameraLayout } from '../core/overlay.js';
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
  /** Which noise filter runs over the microphone: the deep one (DeepFilterNet3), the classic one, or none. */
  noiseFilter: NoiseFilterMode;
  /** Watch the camera for the lip check while recording. */
  lipCheck: boolean;
  /** The chosen camera's device id; empty for the browser's default. */
  cameraDeviceId: string;
  /** Compare each phrase's voice with the enrolled profile. */
  voiceCheck: boolean;
  /**
   * Use the dedicated hardware video engine (Apple's media engine, NVENC, Quick Sync) wherever this
   * computer has one: for encoding in the browser and in ffmpeg, and for ffmpeg's decoding of the
   * upload (`-hwaccel`). On until the user says no. The camera clips are left to WebCodecs' own
   * choice: forcing the hardware there softened the 360p picture for no gain.
   */
  hardwareEncoding: boolean;
  /** Record the camera along with the voice: the switch under the level meter. */
  camera: boolean;
  /** Where the camera picture sits on the slide and how big it is. */
  cameraLayout: CameraLayout;
}

const DEFAULT_PREFS: Prefs = {
  welcomeSeen: false,
  tips: true,
  theme: 'dark',
  captureMode: 'auto',
  micDeviceId: '',
  noiseFilter: 'deep',
  lipCheck: true,
  cameraDeviceId: '',
  voiceCheck: true,
  hardwareEncoding: true,
  camera: false,
  cameraLayout: { ...DEFAULT_CAMERA_LAYOUT },
};

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function noiseFilter(value: unknown): NoiseFilterMode {
  if (value === 'deep' || value === 'classic' || value === 'off') return value;
  // the switch used to be on or off: on meant the classic filter, the only one there was
  if (value === true) return 'classic';
  if (value === false) return 'off';
  return DEFAULT_PREFS.noiseFilter;
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<Record<keyof Prefs, unknown>>;
    return {
      welcomeSeen: bool(parsed.welcomeSeen, DEFAULT_PREFS.welcomeSeen),
      tips: bool(parsed.tips, DEFAULT_PREFS.tips),
      theme: parsed.theme === 'light' || parsed.theme === 'dark' ? parsed.theme : DEFAULT_PREFS.theme,
      captureMode:
        parsed.captureMode === 'hold' || parsed.captureMode === 'auto'
          ? parsed.captureMode
          : DEFAULT_PREFS.captureMode,
      micDeviceId: typeof parsed.micDeviceId === 'string' ? parsed.micDeviceId : DEFAULT_PREFS.micDeviceId,
      noiseFilter: noiseFilter(parsed.noiseFilter),
      lipCheck: bool(parsed.lipCheck, DEFAULT_PREFS.lipCheck),
      cameraDeviceId:
        typeof parsed.cameraDeviceId === 'string' ? parsed.cameraDeviceId : DEFAULT_PREFS.cameraDeviceId,
      voiceCheck: bool(parsed.voiceCheck, DEFAULT_PREFS.voiceCheck),
      hardwareEncoding: bool(parsed.hardwareEncoding, DEFAULT_PREFS.hardwareEncoding),
      camera: bool(parsed.camera, DEFAULT_PREFS.camera),
      cameraLayout: normalizeLayout(parsed.cameraLayout),
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
