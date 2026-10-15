/**
 * The enrolled voice profile (`core/speaker.ts`), kept in this browser's localStorage. It is not
 * project data: it outlives the slides and the phrases, and closing the slides leaves it alone.
 * Every access is fail-safe.
 */
import { SPEAKER_MODEL, type VoiceProfile } from '../core/speaker.js';

const KEY = 'one-take.voice';

export function loadProfile(): VoiceProfile | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<VoiceProfile>;
    if (
      parsed.model !== SPEAKER_MODEL.name ||
      !Array.isArray(parsed.embedding) ||
      parsed.embedding.length !== SPEAKER_MODEL.dim ||
      !parsed.embedding.every((v) => typeof v === 'number' && Number.isFinite(v))
    ) {
      return null; // from another model, or damaged: enroll again
    }
    return {
      model: parsed.model,
      embedding: parsed.embedding,
      seconds: typeof parsed.seconds === 'number' ? parsed.seconds : 0,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
    };
  } catch {
    return null;
  }
}

export function saveProfile(profile: VoiceProfile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(profile));
  } catch {
    /* private mode or storage blocked: the profile lasts for this page only */
  }
}

export function clearProfile(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}
