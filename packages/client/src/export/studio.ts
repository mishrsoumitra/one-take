/**
 * The studio from the browser's side: decides which clips need what, sends the server their raw
 * audio (and their mouth films), follows the job, and hands each clip's result back the moment it
 * lands, so a job that is stopped half way still leaves what it finished. The export runs it before
 * anything else is done to the sound; the editor runs it for one clip at a time.
 *
 * What a clip needs (`planStudio`):
 * - the deep clean, when it is asked for and the clip has none yet;
 * - its voice kept, when that is asked for and the clip was flagged as another voice (or not surely
 *   the speaker's) and is being kept, or the clip was switched to Only my voice; by its mouth film
 *   when the camera saw it, else by the voice profile;
 * - a measure of a second voice, when every phrase is to be checked for one.
 *
 * The audio sent is the clip as the microphone heard it (`raw`), or the live version for a clip
 * without one. Results come back at the clip's own rate, as long as the clip, and are put on the
 * segment by the caller (`withVersion`).
 */
import {
  STUDIO_LOAD_SEC,
  STUDIO_SPEED,
  twoVoices,
  type Enhance,
  type StudioClipRequest,
  type StudioClipResult,
  type StudioInfo,
  type StudioJob,
  type StudioVoice,
} from '@one-take/shared';

import { type ApiClient } from '../api/client.js';
import { VOICE_OTHER, type VoiceProfile } from '../core/speaker.js';
import { segmentDuration, type Segment } from '../core/timeline.js';
import { flagged } from '../core/versions.js';

export interface StudioPlanOptions {
  settings: Enhance['studio'];
  info: StudioInfo | null;
  /** Ids of flagged phrases the user chose to drop from the export: nothing is done to them. */
  dropped?: ReadonlySet<string>;
  /** Do the work again even where a clip already has the result. */
  redo?: boolean;
}

/** One clip's part of a job. */
export interface StudioPlanClip {
  seg: Segment;
  denoise: boolean;
  voice: StudioVoice;
}

export interface StudioPlan {
  clips: StudioPlanClip[];
  /** Seconds of audio the deep clean goes over, and seconds the voice step goes over. */
  denoiseSec: number;
  voiceSec: number;
}

/** A clip whose voice the studio should keep: flagged and kept, or switched to Only my voice. */
export function wantsVoice(seg: Segment, dropped?: ReadonlySet<string>): boolean {
  if (dropped?.has(seg.id)) return false;
  return seg.choice === 'voice' || (flagged(seg) && seg.choice !== 'original' && seg.choice !== 'cleaned');
}

/** Which clips need which model, for a job or for the plan's figures. */
export function planStudio(segments: readonly Segment[], options: StudioPlanOptions): StudioPlan {
  const { settings, info } = options;
  const clips: StudioPlanClip[] = [];
  let denoiseSec = 0;
  let voiceSec = 0;
  for (const seg of segments) {
    if (options.dropped?.has(seg.id)) continue;
    const denoise = settings.denoise && (info?.denoise ?? false) && (options.redo === true || !seg.deep);
    let voice: StudioVoice = 'off';
    if (info?.voice) {
      if (settings.voice && wantsVoice(seg) && (options.redo === true || !seg.voice)) {
        voice = seg.faces && seg.faces.frames > 0 ? 'faces' : 'profile';
      } else if (settings.findOverlap && !seg.voice) {
        voice = 'measure';
      }
    }
    if (!denoise && voice === 'off') continue;
    clips.push({ seg, denoise, voice });
    const sec = segmentDuration(seg);
    if (denoise) denoiseSec += sec;
    if (voice !== 'off') voiceSec += sec;
  }
  return { clips, denoiseSec, voiceSec };
}

/** What the plan expects the studio to take, in seconds, for the time left before anything is measured. */
export function studioEstimate(
  plan: StudioPlan,
  info: StudioInfo | null,
): { denoiseSec: number | null; voiceSec: number | null } {
  const speed = STUDIO_SPEED[info?.device ?? 'cpu'];
  return {
    denoiseSec: plan.denoiseSec > 0 ? Math.round(STUDIO_LOAD_SEC + plan.denoiseSec * speed.denoise) : null,
    voiceSec: plan.voiceSec > 0 ? Math.round(STUDIO_LOAD_SEC + plan.voiceSec * speed.voice) : null,
  };
}

/** The audio sent for a clip: as the microphone heard it, or the live version without a raw copy. */
export function studioInput(seg: Segment): Int16Array {
  return seg.raw ?? seg.pcm;
}

export interface StudioRunOptions {
  api: ApiClient;
  plan: StudioPlan;
  profile: VoiceProfile | null;
  signal: AbortSignal;
  /** The job moved: which stage, how far. */
  onProgress: (job: StudioJob) => void;
  /** A clip's result landed; `pcm` is as long as the clip. */
  onResult: (seg: Segment, kind: 'deep' | 'voice', pcm: Int16Array, result: StudioClipResult) => void;
  /** A clip was measured (or its voice done) and the figures say two people talk at once in it. */
  onTwoVoices?: (seg: Segment, result: StudioClipResult) => void;
}

export interface StudioOutcome {
  job: StudioJob | null;
  /** The job was stopped before it was done; what had landed was handed over. */
  stopped: boolean;
  /** Clips whose result failed, with the reason. */
  failed: { seg: Segment; error: string }[];
}

export class StudioCancelledError extends Error {
  constructor() {
    super('The studio was stopped');
    this.name = 'StudioCancelledError';
  }
}

/** Runs one job for the plan's clips and hands every result to `onResult` as it lands. */
export async function runStudio(options: StudioRunOptions): Promise<StudioOutcome> {
  const { api, plan, signal } = options;
  if (plan.clips.length === 0) return { job: null, stopped: false, failed: [] };
  const clips: StudioClipRequest[] = plan.clips.map((c) => ({
    id: c.seg.id,
    rate: c.seg.sampleRate,
    samples: c.seg.pcm.length,
    denoise: c.denoise,
    voice: c.voice,
    faceBytes: c.voice === 'faces' ? (c.seg.faces?.data.length ?? 0) : 0,
  }));
  const job = await api.createStudio({
    clips,
    profile: options.profile ? options.profile.embedding : null,
  });
  const byId = new Map(plan.clips.map((c) => [c.seg.id, c.seg]));
  try {
    // the uploads: every clip's audio in one run of bytes, every film in another
    let bytes = 0;
    for (const c of clips) bytes += c.samples * 2;
    const audio = new Uint8Array(bytes);
    let at = 0;
    for (const c of plan.clips) {
      const pcm = studioInput(c.seg);
      audio.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), at);
      at += pcm.byteLength;
    }
    await api.uploadStudioAudio(job.id, audio, signal);
    const films = plan.clips.filter((c) => c.voice === 'faces' && c.seg.faces);
    if (films.length > 0) {
      let total = 0;
      for (const c of films) total += c.seg.faces?.data.length ?? 0;
      const frames = new Uint8Array(total);
      let k = 0;
      for (const c of films) {
        const data = c.seg.faces?.data;
        if (!data) continue;
        frames.set(data, k);
        k += data.length;
      }
      await api.uploadStudioFaces(job.id, frames, signal);
    }
    await api.startStudio(job.id);

    // results are fetched as the job announces them, one fetch per clip and kind
    const fetched = new Set<string>();
    const fetches: Promise<void>[] = [];
    const failed: StudioOutcome['failed'] = [];
    const reported = new Set<string>();
    const collect = (event: StudioJob) => {
      options.onProgress(event);
      for (const result of event.clips) {
        const seg = byId.get(result.id);
        if (!seg) continue;
        for (const kind of ['deep', 'voice'] as const) {
          const key = `${result.id}:${kind}`;
          if (!result[kind] || fetched.has(key)) continue;
          fetched.add(key);
          // a voice picked by the profile that is nothing like it: the speaker is not in this phrase
          if (
            kind === 'voice' &&
            result.method === 'profile' &&
            (result.similarity?.[0] ?? 1) <= VOICE_OTHER
          ) {
            failed.push({ seg, error: 'your voice was not found in it' });
            continue;
          }
          fetches.push(
            api
              .studioResult(event.id, result.id, kind, signal)
              .then((pcm) => {
                if (pcm.length !== seg.pcm.length) {
                  throw new Error(`the ${kind} result has ${pcm.length} samples, the clip ${seg.pcm.length}`);
                }
                options.onResult(seg, kind, pcm, result);
              })
              .catch((error: unknown) => {
                if (signal.aborted) return;
                failed.push({ seg, error: (error as Error).message });
              }),
          );
        }
        if (result.error && !reported.has(result.id)) {
          reported.add(result.id);
          failed.push({ seg, error: result.error });
        }
        if (!reported.has(`${result.id}:two`) && (result.voice || result.method) && twoVoices(result)) {
          reported.add(`${result.id}:two`);
          options.onTwoVoices?.(seg, result);
        }
      }
    };
    let final: StudioJob;
    try {
      final = await api.watchStudio(job.id, (event) => collect(event.job), signal);
    } catch (error) {
      if (signal.aborted) {
        // stopped by the user: keep what has landed, let the server stop the rest
        await api.cancelStudio(job.id).catch(() => undefined);
        const last = await api.getStudio(job.id).catch(() => null);
        if (last) collect(last);
        await Promise.all(fetches);
        return { job: last, stopped: true, failed };
      }
      throw error;
    }
    collect(final);
    await Promise.all(fetches);
    if (final.state === 'failed') throw new Error(final.error ?? 'The studio could not finish.');
    if (final.state === 'cancelled') return { job: final, stopped: true, failed };
    return { job: final, stopped: false, failed };
  } catch (error) {
    if (!signal.aborted) await api.cancelStudio(job.id).catch(() => undefined);
    throw error;
  }
}

/** One line on what the studio did, for the result panel. */
export function describeStudio(outcome: StudioOutcome, plan: StudioPlan): string | null {
  const job = outcome.job;
  if (!job) return null;
  const deep = job.clips.filter((c) => c.deep).length;
  const voices = job.clips.filter((c) => c.voice).length;
  const faces = job.clips.filter((c) => c.voice && c.method === 'faces').length;
  const parts: string[] = [];
  if (plan.denoiseSec > 0) parts.push(`deep clean on ${deep} phrase${deep === 1 ? '' : 's'}`);
  if (voices > 0)
    parts.push(
      `your voice kept in ${voices} phrase${voices === 1 ? '' : 's'}${faces > 0 ? ` (${faces} by the camera)` : ''}`,
    );
  if (outcome.failed.length > 0) parts.push(`${outcome.failed.length} could not be done`);
  if (outcome.stopped) parts.push('stopped before the end');
  return parts.length > 0 ? `Studio: ${parts.join(', ')}.` : null;
}
