/**
 * Speech to text with whatever whisper the machine has: whisper.cpp's `whisper-cli` or the Python
 * `whisper` command (openai-whisper). Both are optional tools found on the PATH, like ffmpeg; nothing
 * is bundled, nothing is downloaded by One Take itself (openai-whisper fetches its own model on first
 * use, and the dialog says so). The audio never leaves the machine.
 *
 * A transcription is a job: the browser sends 16 kHz mono WAV, the recogniser runs on it, progress is
 * reported as it goes, and the words come back with their times.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import {
  type TranscriptionEvent,
  type TranscriptionInfo,
  type TranscriptionJob,
  type TranscriptWord,
} from '@one-take/shared';

import { ApiError, errorMessage } from '../util/errors.js';

const execFileAsync = promisify(execFile);

export interface TranscribeConfig {
  /** A whisper program to use instead of searching the PATH. */
  whisperPath: string | null;
  /** A model name (openai-whisper) or a model file (whisper.cpp). */
  whisperModel: string | null;
  dataDir: string;
}

/** The programs looked for, fastest first. */
const CANDIDATES = ['whisper-cli', 'whisper-cpp', 'whisper'];
/** openai-whisper's default model, and where it keeps its models. */
const OPENAI_DEFAULT_MODEL = 'base.en';
/** Where whisper.cpp models are looked for when none is given. */
const CPP_MODEL_DIRS = (dataDir: string) => [
  path.join(dataDir, 'models'),
  path.join(os.homedir(), '.cache', 'whisper-cpp'),
  '/opt/homebrew/share/whisper-cpp',
  '/usr/local/share/whisper-cpp',
  '/usr/share/whisper-cpp',
];
const CPP_MODEL_PREFERENCE = ['ggml-base.en.bin', 'ggml-base.bin', 'ggml-small.en.bin', 'ggml-small.bin'];

/** Runs `program --help` and says which whisper it is from what it prints; null when it is neither. */
async function identify(program: string): Promise<'whisper-cpp' | 'openai-whisper' | null> {
  let text: string;
  try {
    const { stdout, stderr } = await execFileAsync(program, ['--help'], {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    text = `${stdout}\n${stderr}`;
  } catch (error) {
    // argparse exits with 0 for --help; whisper.cpp exits with 0 too, but be lenient about the code
    const e = error as { stdout?: string; stderr?: string; code?: unknown };
    if (typeof e.stdout !== 'string' && typeof e.stderr !== 'string') return null;
    text = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
  }
  if (text.includes('word_timestamps')) return 'openai-whisper';
  if (/output-json|whisper\.cpp|--max-len/.test(text)) return 'whisper-cpp';
  return null;
}

function openaiCacheDir(): string {
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'whisper');
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function findCppModel(dataDir: string, explicit: string | null): Promise<string | null> {
  if (explicit) return (await exists(explicit)) ? explicit : null;
  for (const dir of CPP_MODEL_DIRS(dataDir)) {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    const models = names.filter((n) => /^ggml-.*\.bin$/.test(n));
    if (models.length === 0) continue;
    const preferred = CPP_MODEL_PREFERENCE.find((p) => models.includes(p)) ?? models.sort()[0];
    if (preferred) return path.join(dir, preferred);
  }
  return null;
}

/** Looks for a whisper and its model; null when there is none. */
export async function detectTranscription(config: TranscribeConfig): Promise<TranscriptionInfo | null> {
  const programs = config.whisperPath ? [config.whisperPath] : CANDIDATES;
  for (const program of programs) {
    const engine = await identify(program);
    if (engine === null) continue;
    if (engine === 'openai-whisper') {
      const model = config.whisperModel ?? OPENAI_DEFAULT_MODEL;
      const modelReady = await exists(path.join(openaiCacheDir(), `${model}.pt`));
      return {
        engine,
        path: program,
        version: null,
        model,
        modelReady,
        note: modelReady
          ? `openai-whisper (${program}), model ${model}`
          : `openai-whisper (${program}), model ${model}: downloaded by whisper on first use (about 140 MB for base.en)`,
      };
    }
    const model = await findCppModel(config.dataDir, config.whisperModel);
    return {
      engine,
      path: program,
      version: null,
      model: model ?? '',
      modelReady: model !== null,
      note: model
        ? `whisper.cpp (${program}), model ${path.basename(model)}`
        : `whisper.cpp (${program}) found, but no model: put a ggml-*.bin model in ${path.join(config.dataDir, 'models')} or pass --whisper-model`,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Running it                                                          */
/* ------------------------------------------------------------------ */

interface InternalJob {
  job: TranscriptionJob;
  wavPath: string;
  outDir: string;
  child: ChildProcess | null;
  listeners: Set<(event: TranscriptionEvent) => void>;
  cancelled: boolean;
}

export interface TranscriptionManagerOptions {
  info: TranscriptionInfo | null;
  dataDir: string;
  log?: (message: string) => void;
  /** Finished jobs kept for the client to read. */
  keepFinished?: number;
}

/** openai-whisper's model for a language: the English-only model only for English. */
function openaiModelFor(model: string, language: string): string {
  if (language !== 'en' && model.endsWith('.en')) return model.slice(0, -3);
  return model;
}

/** The last percentage in a chunk of recogniser output, as 0..1; null when there is none. */
export function parseProgress(chunk: string): number | null {
  const matches = chunk.match(/(\d{1,3})%/g);
  const last = matches?.[matches.length - 1];
  if (!last) return null;
  const n = Number(last.slice(0, -1));
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n / 100)) : null;
}

/** openai-whisper prints a download bar in bytes before the model is ready; a transcription bar counts frames. */
export function looksLikeDownload(chunk: string): boolean {
  return (
    /\d+(\.\d+)?\s?[kMG]i?B\s*\//.test(chunk) ||
    /[kMG]\/\d+(\.\d+)?[kMG]/.test(chunk) ||
    /\[\d\d:\d\d<.*?iB\/s\]/.test(chunk)
  );
}

/** openai-whisper's JSON: words live inside segments. */
export function parseOpenaiJson(json: string): { words: TranscriptWord[]; language: string | null } {
  const parsed = JSON.parse(json) as {
    language?: string;
    segments?: { words?: { word: string; start: number; end: number }[] }[];
  };
  const words: TranscriptWord[] = [];
  for (const segment of parsed.segments ?? []) {
    for (const w of segment.words ?? []) {
      const text = w.word.trim();
      if (text) words.push({ text, start: w.start, end: Math.max(w.start, w.end) });
    }
  }
  return { words, language: typeof parsed.language === 'string' ? parsed.language : null };
}

/** whisper.cpp's JSON with `-ml 1 -sow`: one entry per word, offsets in milliseconds. */
export function parseCppJson(json: string): { words: TranscriptWord[]; language: string | null } {
  const parsed = JSON.parse(json) as {
    result?: { language?: string };
    transcription?: { offsets: { from: number; to: number }; text: string }[];
  };
  const words: TranscriptWord[] = [];
  for (const entry of parsed.transcription ?? []) {
    const text = entry.text.trim();
    if (!text || /^\[.*\]$/.test(text) || /^\(.*\)$/.test(text)) continue; // [BLANK_AUDIO], (music)
    words.push({
      text,
      start: entry.offsets.from / 1000,
      end: Math.max(entry.offsets.from, entry.offsets.to) / 1000,
    });
  }
  return { words, language: typeof parsed.result?.language === 'string' ? parsed.result.language : null };
}

export class TranscriptionManager {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly info: TranscriptionInfo | null;
  private readonly tmpDir: string;
  private readonly log: (message: string) => void;
  private readonly keepFinished: number;

  constructor(options: TranscriptionManagerOptions) {
    this.info = options.info;
    this.tmpDir = path.join(options.dataDir, 'tmp');
    this.log = options.log ?? (() => undefined);
    this.keepFinished = options.keepFinished ?? 20;
  }

  get available(): boolean {
    return this.info !== null;
  }

  get(id: string): TranscriptionJob {
    return this.internal(id).job;
  }

  subscribe(id: string, listener: (event: TranscriptionEvent) => void): () => void {
    const internal = this.internal(id);
    internal.listeners.add(listener);
    return () => internal.listeners.delete(listener);
  }

  /** Takes the WAV, starts the recogniser, and answers at once with the running job. */
  async create(
    audio: Readable,
    options: { language: string; durationSec: number },
  ): Promise<TranscriptionJob> {
    const info = this.info;
    if (!info) {
      throw new ApiError(
        400,
        'transcription_unavailable',
        'No speech recogniser was found on the server. Install whisper (brew install whisper-cpp or openai-whisper) and restart it.',
      );
    }
    if (info.engine === 'whisper-cpp' && !info.modelReady) {
      throw new ApiError(400, 'transcription_unavailable', info.note);
    }
    await fs.mkdir(this.tmpDir, { recursive: true });
    const id = randomUUID();
    const wavPath = path.join(this.tmpDir, `transcribe-${id}.wav`);
    const outDir = path.join(this.tmpDir, `transcribe-${id}`);
    await pipeline(audio, createWriteStream(wavPath));
    await fs.mkdir(outDir, { recursive: true });
    const now = new Date().toISOString();
    const language = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(options.language) ? options.language : 'auto';
    const job: TranscriptionJob = {
      id,
      state: 'running',
      progress: null,
      message: 'Starting the recogniser…',
      durationSec: options.durationSec,
      words: null,
      language: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    const internal: InternalJob = {
      job,
      wavPath,
      outDir,
      child: null,
      listeners: new Set(),
      cancelled: false,
    };
    this.jobs.set(id, internal);
    this.trim();
    void this.run(internal, info, language);
    return job;
  }

  async cancel(id: string): Promise<TranscriptionJob> {
    const internal = this.internal(id);
    const { job } = internal;
    if (job.state !== 'running') return job;
    internal.cancelled = true;
    internal.child?.kill('SIGKILL');
    job.state = 'cancelled';
    job.error = 'Cancelled';
    job.message = 'Cancelled';
    job.updatedAt = new Date().toISOString();
    this.emit(internal);
    await this.cleanup(internal);
    return job;
  }

  async dispose(): Promise<void> {
    for (const internal of this.jobs.values()) {
      if (internal.job.state === 'running') await this.cancel(internal.job.id);
    }
  }

  private async run(internal: InternalJob, info: TranscriptionInfo, language: string): Promise<void> {
    const { job } = internal;
    const threads = String(Math.max(1, Math.min(8, os.availableParallelism())));
    let args: string[];
    let resultFile: string;
    if (info.engine === 'openai-whisper') {
      const model = openaiModelFor(info.model, language);
      args = [
        internal.wavPath,
        '--model',
        model,
        '--output_format',
        'json',
        '--output_dir',
        internal.outDir,
        '--word_timestamps',
        'True',
        '--fp16',
        'False',
        '--verbose',
        'False',
        '--threads',
        threads,
      ];
      if (language !== 'auto') args.push('--language', language);
      resultFile = path.join(internal.outDir, `${path.basename(internal.wavPath, '.wav')}.json`);
    } else {
      const outBase = path.join(internal.outDir, 'result');
      args = [
        '-m',
        info.model,
        '-f',
        internal.wavPath,
        '-oj',
        '-of',
        outBase,
        '-ml',
        '1',
        '-sow',
        '-pp',
        '-np',
        '-l',
        language,
        '-t',
        threads,
      ];
      resultFile = `${outBase}.json`;
    }
    this.log(`transcription ${job.id}: ${info.path} ${args.join(' ')}`);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(info.path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        internal.child = child;
        const tail: string[] = [];
        let lastEmit = 0;
        const onOutput = (chunk: string) => {
          for (const line of chunk.split(/\r?\n|\r/)) {
            if (line.trim()) {
              tail.push(line.trim());
              if (tail.length > 20) tail.shift();
            }
          }
          const progress = parseProgress(chunk);
          const downloading = looksLikeDownload(chunk);
          if (progress === null && !downloading) return;
          job.message = downloading ? 'Downloading the model (first time only)…' : 'Transcribing…';
          if (progress !== null && !downloading) job.progress = progress;
          job.updatedAt = new Date().toISOString();
          const now = Date.now();
          if (now - lastEmit > 250) {
            lastEmit = now;
            this.emit(internal);
          }
        };
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', onOutput);
        child.stderr.on('data', onOutput);
        child.on('error', (error) => reject(new Error(`Could not start ${info.path}: ${error.message}`)));
        child.on('close', (code) => {
          if (internal.cancelled) reject(new Error('cancelled'));
          else if (code === 0) resolve();
          else
            reject(
              new Error(
                `${path.basename(info.path)} exited with code ${code ?? 'unknown'}: ${tail.slice(-4).join(' | ')}`,
              ),
            );
        });
      });
      const json = await fs.readFile(resultFile, 'utf8');
      const parsed = info.engine === 'openai-whisper' ? parseOpenaiJson(json) : parseCppJson(json);
      await this.cleanup(internal);
      job.words = parsed.words;
      job.language = parsed.language;
      job.state = 'done';
      job.progress = 1;
      job.message = `Transcribed ${parsed.words.length} words`;
      job.updatedAt = new Date().toISOString();
      this.emit(internal);
      this.log(`transcription ${job.id} done: ${parsed.words.length} words`);
    } catch (error) {
      await this.cleanup(internal);
      if (internal.cancelled) return;
      job.state = 'failed';
      job.error = errorMessage(error);
      job.message = `Failed: ${job.error}`;
      job.updatedAt = new Date().toISOString();
      this.emit(internal);
      this.log(`transcription ${job.id} failed: ${job.error}`);
    } finally {
      internal.child = null;
    }
  }

  private async cleanup(internal: InternalJob): Promise<void> {
    await fs.rm(internal.wavPath, { force: true }).catch(() => undefined);
    await fs.rm(internal.outDir, { recursive: true, force: true }).catch(() => undefined);
  }

  private internal(id: string): InternalJob {
    const internal = this.jobs.get(id);
    if (!internal) {
      throw new ApiError(
        404,
        'transcription_not_found',
        'Unknown transcription. The server may have restarted.',
      );
    }
    return internal;
  }

  private emit(internal: InternalJob): void {
    const event: TranscriptionEvent = { type: 'job', job: structuredClone(internal.job) };
    for (const l of internal.listeners) l(event);
  }

  private trim(): void {
    const finished = [...this.jobs.values()].filter((j) => j.job.state !== 'running');
    finished.sort((a, b) => (a.job.updatedAt < b.job.updatedAt ? -1 : 1));
    while (finished.length > this.keepFinished) {
      const victim = finished.shift();
      if (victim) this.jobs.delete(victim.job.id);
    }
  }
}
