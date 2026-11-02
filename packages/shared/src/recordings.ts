/**
 * Recordings on disk: a deck plus everything recorded on it, kept by the local server in a folder of
 * its own (`<data dir>/recordings/<id>/`) so the recording can be continued from any browser, even
 * one whose storage was wiped.
 *
 * The app keeps its working copy in the browser (IndexedDB) and mirrors it here: the deck's files
 * once, every phrase as soon as it is stored (one file each, with its SHA-256 in the manifest), and
 * the project state (the order, the slide, the settings) a moment after each change. Continuing a
 * recording is the mirror image: the manifest, the deck and the phrases come back down.
 *
 * A recording is made of **sittings**: one for each time it was opened and worked on. Each phrase
 * carries the number of the sitting it was recorded in; the export plays them all as one video.
 */
import { z } from 'zod';

/** Ids name files on disk, so they are kept to a safe alphabet; the app makes them. */
export const RECORDING_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
export const RecordingIdSchema = z.string().regex(RECORDING_ID);

export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const Sha256Schema = z.string().regex(SHA256_HEX);

export const DeckFileSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.string().max(100),
  bytes: z.int().min(0),
  sha256: Sha256Schema,
});
export type DeckFile = z.infer<typeof DeckFileSchema>;

export const RecordingDeckSchema = z.object({
  /** What the deck is called in the app: the file's name, or `12 images`. */
  name: z.string().min(1).max(200),
  kind: z.enum(['pdf', 'images']),
  slides: z.int().min(1).max(10_000),
  /** The hash of what the user picked (the PowerPoint file, the PDF, the images in order): the same deck gives the same hash. */
  hash: Sha256Schema,
  /** The files the app renders slides from, in order (the converted PDF for a PowerPoint deck). */
  files: z.array(DeckFileSchema).min(1).max(2000),
  /** Set when the deck came out of a presentation file the server converted. */
  origin: z
    .object({ name: z.string().max(200), type: z.string().max(100), warnings: z.array(z.string()).max(1000) })
    .nullable(),
});
export type RecordingDeck = z.infer<typeof RecordingDeckSchema>;

export const RecordingSittingSchema = z.object({
  n: z.int().min(1),
  startedAt: z.string().max(40),
  /** The slide the sitting began on. */
  fromSlide: z.int().min(0),
});
export type RecordingSitting = z.infer<typeof RecordingSittingSchema>;

/** `POST /api/recordings`. */
export const CreateRecordingSchema = z.object({
  deck: RecordingDeckSchema,
  /**
   * Copy the deck's files from this recording instead of uploading them again: starting afresh on
   * the same deck. The decks must match file for file (name, size and hash).
   */
  deckFrom: RecordingIdSchema.optional(),
  settings: z.record(z.string(), z.number()).optional(),
  sittings: z.array(RecordingSittingSchema).max(10_000).optional(),
});
export type CreateRecording = z.infer<typeof CreateRecordingSchema>;

/** `PATCH /api/recordings/:id`: the project state, every field optional. */
export const UpdateRecordingSchema = z.object({
  /** The phrases in playback order. Ids the recording does not hold are kept too: their files may still be on their way. */
  order: z.array(RecordingIdSchema).max(100_000).optional(),
  current: z.int().min(0).optional(),
  sitting: z.int().min(1).optional(),
  sittings: z.array(RecordingSittingSchema).max(10_000).optional(),
  settings: z.record(z.string(), z.number()).optional(),
  /** The last export settings, kept as the app sent them; the app checks them when they come back. */
  exportRequest: z.unknown().optional(),
  counter: z.int().min(0).optional(),
});
export type UpdateRecording = z.infer<typeof UpdateRecordingSchema>;

/** What a phrase's upload says about it, in the query string of `PUT /api/recordings/:id/phrases/:phrase`. */
export const PhraseMetaSchema = z.object({
  slide: z.coerce.number().int().min(0),
  seconds: z.coerce.number().min(0),
  sitting: z.coerce.number().int().min(1),
  /** A phrase in the speaker's voice, or a drawing made with the pen. */
  kind: z.enum(['voice', 'ink']),
  /** The phrase carries the camera's picture. */
  camera: z
    .union([z.literal('1'), z.literal('0'), z.literal('true'), z.literal('false'), z.boolean()])
    .transform((v) => v === true || v === '1' || v === 'true'),
  createdAt: z.coerce.number().int().min(0),
});
export type PhraseMeta = z.infer<typeof PhraseMetaSchema>;

/** One phrase as the recording knows it: its file's size and hash, and what the app said about it. */
export interface RecordingPhrase extends PhraseMeta {
  id: string;
  sha256: string;
  bytes: number;
}

/** The whole recording, as `GET /api/recordings/:id` answers. */
export interface RecordingRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  deck: RecordingDeck;
  /** Every deck file has been uploaded, so the slides can be rendered from here. */
  deckReady: boolean;
  phrases: RecordingPhrase[];
  order: string[];
  current: number;
  sitting: number;
  sittings: RecordingSitting[];
  settings: Record<string, number>;
  exportRequest: unknown;
  counter: number;
  /** The recording's folder on disk. */
  path: string;
  /** Bytes the deck and the phrases take on disk. */
  bytes: number;
}

/** One line per recording, as `GET /api/recordings` lists them, newest first. */
export interface RecordingSummary {
  id: string;
  /** The deck's name. */
  name: string;
  deckHash: string;
  slides: number;
  deckReady: boolean;
  /** Phrases and drawings. */
  phrases: number;
  /** Speech and drawing time recorded, in seconds. */
  seconds: number;
  /** The slide the recording was left on (zero-based). */
  current: number;
  /** The highest slide anything was recorded on (zero-based), or -1 with nothing recorded. */
  lastSlide: number;
  /** How many sittings there have been. */
  sittings: number;
  /** Some phrase carries the camera's picture. */
  camera: boolean;
  /** Some clip is a drawing. */
  ink: boolean;
  createdAt: string;
  updatedAt: string;
  bytes: number;
  path: string;
}

/** What an upload answers with: the file as it landed. */
export interface UploadReceipt {
  id: string;
  sha256: string;
  bytes: number;
}

/** The header an upload may carry with the hash it expects the server to find. */
export const SHA256_HEADER = 'x-one-take-sha256';
