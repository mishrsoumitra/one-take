/**
 * The studio: the heavy audio models the server runs at export time (and from the editor, one clip
 * at a time) in a Python environment of its own. What there is, what each model is for, how fast it
 * goes, and the wire types of a studio job.
 *
 * The models come from ClearerVoice-Studio (Alibaba, Apache 2.0). `npm run studio` sets up the
 * environment and fetches them, about 1.7 GB; without it the studio's switches are greyed out and
 * everything else works as before.
 */
import { z } from 'zod';

export type StudioModelKind = 'denoise' | 'separate' | 'extract';

export interface StudioModel {
  /** The folder the checkpoint lives in, and ClearerVoice's name for it. */
  name: string;
  /** The Hugging Face repository it is published in. */
  repo: string;
  /** The checkpoint's size, for the setup's messages. */
  bytes: number;
  /** What it is for, for messages. */
  what: string;
}

export const STUDIO_MODELS: Record<StudioModelKind, StudioModel> = {
  denoise: {
    name: 'MossFormer2_SE_48K',
    repo: 'alibabasglab/MossFormer2_SE_48K',
    bytes: 222_000_000,
    what: 'the deep clean (MossFormer2 speech enhancement at 48 kHz)',
  },
  separate: {
    name: 'MossFormer2_SS_16K',
    repo: 'alibabasglab/MossFormer2_SS_16K',
    bytes: 670_000_000,
    what: 'telling two voices apart (MossFormer2 speech separation)',
  },
  extract: {
    name: 'AV_MossFormer2_TSE_16K',
    repo: 'alibabasglab/AV_MossFormer2_TSE_16K',
    bytes: 735_000_000,
    what: 'keeping the voice of the face on camera (AV-MossFormer2 target speaker extraction)',
  },
};

/** The Python package the models are run through, pinned to the version the worker was written against. */
export const STUDIO_PACKAGES = ['clearvoice==0.1.2', 'onnxruntime', 'pillow'] as const;

export type StudioDevice = 'mps' | 'cuda' | 'cpu';

/** What the server found of the studio at start-up (`/api/capabilities`). */
export interface StudioInfo {
  /** The Python the studio runs in, once it is set up; null when it is not. */
  python: string | null;
  /** Where the models will run; null until the environment imports. */
  device: StudioDevice | null;
  /** Which checkpoints are there. */
  models: Record<StudioModelKind, boolean>;
  /** The speaker model is there, so a voice can be picked by the enrolled profile without a face. */
  speaker: boolean;
  /** The deep clean can run: the environment imports and its checkpoint is there. */
  denoise: boolean;
  /** Keeping only a voice can run: the environment imports and both voice checkpoints are there. */
  voice: boolean;
  /** One line for the dialog. */
  note: string;
}

/**
 * How long the models take as a share of real time, for the first estimate of the time left (the
 * measured rate takes over as the step runs). Measured on an M2 Max for `mps`: the deep clean at
 * 0.02 to 0.1, separation and extraction at about 0.3. The other two rows are rough.
 */
export const STUDIO_SPEED: Record<StudioDevice, { denoise: number; voice: number }> = {
  mps: { denoise: 0.08, voice: 0.35 },
  cuda: { denoise: 0.04, voice: 0.2 },
  cpu: { denoise: 0.6, voice: 3 },
};

/** Loading a model into memory before the first clip, in seconds; charged once per model used. */
export const STUDIO_LOAD_SEC = 4;

/* ------------------------------------------------------------------ */
/* A studio job                                                        */
/* ------------------------------------------------------------------ */

/** The speaker model's vector length. */
export const PROFILE_DIM = 256;

export const StudioVoiceSchema = z.enum(['off', 'faces', 'profile', 'measure']);
/**
 * What to do about other voices in a clip: nothing; keep the voice of the face whose crops were sent
 * (`faces`); keep the voice closest to the enrolled profile, or the louder one without a profile
 * (`profile`); or only measure how much a second voice talks over the first (`measure`).
 */
export type StudioVoice = z.infer<typeof StudioVoiceSchema>;

export const StudioClipSchema = z.object({
  id: z.string().min(1).max(100),
  rate: z.int().min(8000).max(192_000),
  /** Samples of 16-bit mono PCM sent for this clip. */
  samples: z.int().min(1).max(48_000 * 3600 * 4),
  /** Run the deep clean on it. */
  denoise: z.boolean(),
  voice: StudioVoiceSchema,
  /** Bytes of mouth crops sent for it (JPEG frames, each after its little-endian uint32 length). */
  faceBytes: z.int().min(0).max(512 * 1024 * 1024),
});
export type StudioClipRequest = z.infer<typeof StudioClipSchema>;

export const CreateStudioJobSchema = z.object({
  clips: z.array(StudioClipSchema).min(1).max(5000),
  /** The enrolled voice as a unit vector, for picking a voice without a face; null without one. */
  profile: z.array(z.number()).length(PROFILE_DIM).nullable(),
});
export type CreateStudioJobRequest = z.infer<typeof CreateStudioJobSchema>;

export type StudioJobState = 'uploading' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export type StudioStage = 'upload' | 'denoise' | 'voice' | 'done';

export type StudioMethod = 'faces' | 'profile' | 'energy';

/** What became of one clip. */
export interface StudioClipResult {
  id: string;
  /** The deep clean is done and can be fetched. */
  deep: boolean;
  /** The voice result is done and can be fetched (false after `measure`, which writes nothing). */
  voice: boolean;
  /** How the voice was kept. */
  method: StudioMethod | null;
  /** The cosine of each separated voice against the profile (the kept one first); null without a profile or by faces. */
  similarity: number[] | null;
  /** Mouth crops the extraction used. */
  faceFrames: number | null;
  /** The share of the kept voice's speech that a second voice talks over; null by faces. */
  overlap: number | null;
  /** The share of the clip in which the second voice is active. */
  otherShare: number | null;
  /** How loud the second voice is while it speaks, against the kept one, in dB. */
  otherLevelDb: number | null;
  /** The longest stretch the second voice keeps going, in seconds (pauses under 0.3 s bridged). */
  otherRunSec: number | null;
  error: string | null;
}

export interface StudioProgress {
  stage: StudioStage;
  /** The clip being worked on, in the voice stage. */
  clip: string | null;
  /** Clips finished in this stage, and how many there are. */
  done: number;
  total: number;
  /** 0..1 of the stage, or null before the worker reports. */
  fraction: number | null;
  message: string;
}

export interface StudioJob {
  id: string;
  state: StudioJobState;
  createdAt: string;
  updatedAt: string;
  /** Seconds of audio sent. */
  durationSec: number;
  /** Seconds of audio the deep clean goes over, and seconds the voice step goes over. */
  denoiseSec: number;
  voiceSec: number;
  progress: StudioProgress;
  clips: StudioClipResult[];
  error: string | null;
}

export interface StudioEvent {
  type: 'job';
  job: StudioJob;
}

/**
 * A second voice counts as talking over the kept one when it is active in at least a tenth of the
 * clip, keeps going for at least a second, and speaks within 24 dB of the kept voice. The bars come
 * from a bench on synthetic voices: a second speaker 6 dB under came out at −20 dB after the
 * separation, and what the separation leaves of a single voice at −28 dB.
 */
export const OVERLAP_MIN_SHARE = 0.1;
export const OVERLAP_MIN_LEVEL_DB = -24;
export const OVERLAP_MIN_RUN_SEC = 1;

/** Whether a clip's measure says two people talk at once in it. */
export function twoVoices(result: Pick<StudioClipResult, 'otherShare' | 'otherLevelDb' | 'otherRunSec'>): boolean {
  return (
    result.otherShare !== null &&
    result.otherLevelDb !== null &&
    result.otherShare >= OVERLAP_MIN_SHARE &&
    result.otherLevelDb >= OVERLAP_MIN_LEVEL_DB &&
    (result.otherRunSec ?? Infinity) >= OVERLAP_MIN_RUN_SEC
  );
}

/** The frames file: each crop is a JPEG after its little-endian uint32 length. */
export const FACE_FPS = 25;
export const FACE_SIZE = 112;
