/**
 * The studio on the server: finds the Python environment and the models `npm run studio` set up,
 * runs the worker (`py/studio.py`) as a long-lived process that is started on first use and
 * stopped after a while of nothing to do, and keeps the jobs the browser sends.
 *
 * A job is a list of clips. The browser uploads every clip's audio as one run of 16-bit PCM and,
 * for the clips it has them for, the mouth crops as one run of JPEG frames; then it starts the job
 * and follows it over server-sent events. The deep clean goes over the clips that asked for it as
 * one recording (so the model hears the room over seconds, and a short clip gets its neighbours
 * for context) and the result is cut back into clips; then each clip that asked for its voice is
 * done on its own, from the cleaned audio when there is one. Every result is a file the browser
 * fetches as soon as the job says it is there, so a job stopped half way still hands over what it
 * finished.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import {
  MODELS,
  STUDIO_MODELS,
  type CreateStudioJobRequest,
  type StudioClipResult,
  type StudioDevice,
  type StudioEvent,
  type StudioInfo,
  type StudioJob,
  type StudioMethod,
  type StudioModelKind,
} from '@one-take/shared';

import { ApiError, errorMessage } from '../util/errors.js';

export interface StudioConfig {
  /** Where the studio keeps its environment and models: `<dataDir>/studio`. */
  dataDir: string;
  /** A Python to use instead of the studio's own environment. */
  pythonPath: string | null;
  /** The built client's folder, where `npm run models` may have put the speaker model. */
  staticDir: string | null;
}

/** The worker script, next to the compiled server. */
export const WORKER_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../py/studio.py');

export function studioDir(dataDir: string): string {
  return path.join(dataDir, 'studio');
}

export function venvPython(dataDir: string): string {
  const venv = path.join(studioDir(dataDir), 'venv');
  return process.platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python');
}

export function modelsDir(dataDir: string): string {
  return path.join(studioDir(dataDir), 'models');
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Where the speaker model is, for picking a voice by profile: the studio's folder, else the client's. */
async function findSpeakerModel(config: StudioConfig): Promise<string | null> {
  const candidates = [path.join(modelsDir(config.dataDir), MODELS.speaker.name)];
  if (config.staticDir) candidates.push(path.join(config.staticDir, 'models', MODELS.speaker.name));
  for (const c of candidates) if (await exists(c)) return c;
  return null;
}

interface CheckOutput {
  models?: Partial<Record<StudioModelKind, boolean>>;
  speaker?: boolean;
  torch?: string;
  device?: string;
  clearvoice?: boolean;
  error?: string;
}

function asDevice(value: unknown): StudioDevice | null {
  return value === 'mps' || value === 'cuda' || value === 'cpu' ? value : null;
}

/** Runs the worker's `--check` and says what the studio can do here. */
export async function detectStudio(config: StudioConfig, log?: (m: string) => void): Promise<StudioInfo> {
  const python = config.pythonPath ?? venvPython(config.dataDir);
  const models = modelsDir(config.dataDir);
  const speaker = await findSpeakerModel(config);
  const none: Record<StudioModelKind, boolean> = { denoise: false, separate: false, extract: false };
  const setup = 'run "npm run studio" once (about 1.7 GB of models) and restart the server';
  if (!(await exists(python))) {
    return {
      python: null,
      device: null,
      models: none,
      speaker: speaker !== null,
      denoise: false,
      voice: false,
      note: `The studio is not set up: ${setup}.`,
    };
  }
  let output: CheckOutput;
  try {
    output = await new Promise<CheckOutput>((resolve, reject) => {
      const child = spawn(
        python,
        ['-I', WORKER_SCRIPT, '--models', models, ...(speaker ? ['--speaker', speaker] : []), '--check'],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
      let out = '';
      let err = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d: string) => (out += d));
      child.stderr.on('data', (d: string) => (err += d));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('the studio check took too long'));
      }, 90_000);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const line = out
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.startsWith('{'))
          .pop();
        if (!line) {
          reject(new Error(`the studio check exited with ${code ?? 'no code'}: ${err.trim().split('\n').pop() ?? ''}`));
          return;
        }
        try {
          resolve(JSON.parse(line) as CheckOutput);
        } catch (e) {
          reject(e as Error);
        }
      });
    });
  } catch (error) {
    log?.(`studio check failed: ${errorMessage(error)}`);
    return {
      python,
      device: null,
      models: none,
      speaker: speaker !== null,
      denoise: false,
      voice: false,
      note: `The studio environment at ${python} does not run (${errorMessage(error)}); ${setup}.`,
    };
  }
  const have: Record<StudioModelKind, boolean> = {
    denoise: output.models?.denoise === true,
    separate: output.models?.separate === true,
    extract: output.models?.extract === true,
  };
  const device = asDevice(output.device);
  const imports = output.clearvoice === true && device !== null;
  const missing = (Object.keys(STUDIO_MODELS) as StudioModelKind[]).filter((k) => !have[k]);
  let note: string;
  if (!imports) note = `The studio environment is incomplete (${output.error ?? 'clearvoice does not import'}); ${setup}.`;
  else if (missing.length > 0)
    note = `The studio runs on the ${deviceLabel(device)}, but ${missing.map((k) => STUDIO_MODELS[k].name).join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing; ${setup}.`;
  else
    note = `The studio runs on the ${deviceLabel(device)} (torch ${output.torch ?? '?'}); the deep clean and keeping only your voice are ready${speaker ? '' : ' (a voice is picked by its level without the speaker model)'}.`;
  return {
    python,
    device,
    models: have,
    speaker: speaker !== null,
    denoise: imports && have.denoise,
    voice: imports && have.separate && have.extract,
    note,
  };
}

export function deviceLabel(device: StudioDevice | null): string {
  switch (device) {
    case 'mps':
      return 'GPU (Apple Metal)';
    case 'cuda':
      return 'GPU (CUDA)';
    case 'cpu':
      return 'CPU';
    case null:
      return 'CPU';
  }
}

/* ------------------------------------------------------------------ */
/* The worker process                                                  */
/* ------------------------------------------------------------------ */

interface WorkerLine {
  event: string;
  id?: string;
  progress?: number;
  message?: string;
  [key: string]: unknown;
}

/** One request to the worker: resolved by its `done` line, rejected by its `error` line or by the process going. */
interface Pending {
  id: string;
  onProgress: (fraction: number) => void;
  resolve: (line: WorkerLine) => void;
  reject: (error: Error) => void;
}

/**
 * The worker as a process: one request at a time, started when the first comes and stopped after
 * `idleMs` without one, so the models (a gigabyte or two of memory) are not held for ever.
 */
export class StudioWorker {
  private child: ChildProcess | null = null;
  private starting: Promise<ChildProcess> | null = null;
  private pending: Pending | null = null;
  private queue: Promise<void> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private serial = 0;

  constructor(
    private readonly python: string,
    private readonly models: string,
    private readonly speaker: string | null,
    private readonly log: (m: string) => void,
    private readonly idleMs = 3 * 60_000,
  ) {}

  get running(): boolean {
    return this.child !== null;
  }

  /** Sends one request and waits for its answer; requests run one after another. */
  request(op: string, body: Record<string, unknown>, onProgress: (fraction: number) => void): Promise<WorkerLine> {
    const run = this.queue.then(() => this.send(op, body, onProgress));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async send(op: string, body: Record<string, unknown>, onProgress: (fraction: number) => void): Promise<WorkerLine> {
    const child = await this.start();
    this.clearIdle();
    const id = `r${++this.serial}`;
    const answer = new Promise<WorkerLine>((resolve, reject) => {
      this.pending = { id, onProgress, resolve, reject };
    });
    child.stdin?.write(`${JSON.stringify({ op, id, ...body })}\n`);
    try {
      return await answer;
    } finally {
      this.pending = null;
      this.armIdle();
    }
  }

  private start(): Promise<ChildProcess> {
    if (this.child) return Promise.resolve(this.child);
    this.starting ??= this.spawn().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private spawn(): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const args = ['-I', WORKER_SCRIPT, '--models', this.models];
      if (this.speaker) args.push('--speaker', this.speaker);
      this.log(`studio worker: ${this.python} ${args.join(' ')}`);
      const child = spawn(this.python, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let ready = false;
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (d: string) => {
        for (const line of d.split('\n')) if (line.trim() && !/warn/i.test(line)) this.log(`studio: ${line.trim()}`);
      });
      const lines = readline.createInterface({ input: child.stdout as Readable });
      lines.on('line', (line) => {
        let message: WorkerLine;
        try {
          message = JSON.parse(line) as WorkerLine;
        } catch {
          return;
        }
        if (message.event === 'hello') {
          ready = true;
          this.child = child;
          resolve(child);
          return;
        }
        const pending = this.pending;
        if (!pending || message.id !== pending.id) return;
        if (message.event === 'progress') {
          if (typeof message.progress === 'number') pending.onProgress(message.progress);
        } else if (message.event === 'done') {
          pending.resolve(message);
        } else if (message.event === 'error') {
          pending.reject(new Error(message.message ?? 'the studio worker failed'));
        }
      });
      child.on('error', (error) => {
        if (!ready) reject(new Error(`could not start the studio worker: ${error.message}`));
        this.gone(error);
      });
      child.on('close', (code) => {
        if (!ready) reject(new Error(`the studio worker exited with ${code ?? 'no code'} before it was ready`));
        this.gone(new Error(`the studio worker stopped (exit ${code ?? 'unknown'})`));
      });
      child.stdin?.write(`${JSON.stringify({ op: 'hello' })}\n`);
    });
  }

  private gone(error: Error): void {
    this.child = null;
    this.clearIdle();
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
  }

  /** Stops the process now; a request in flight fails as cancelled, the next request starts it again. */
  stop(): void {
    const child = this.child;
    this.child = null;
    this.clearIdle();
    if (!child) return;
    try {
      child.stdin?.write(`${JSON.stringify({ op: 'quit' })}\n`);
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 2000).unref();
    const pending = this.pending;
    this.pending = null;
    pending?.reject(new Error('cancelled'));
  }

  private armIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.log('studio worker idle; stopping it');
      this.stop();
    }, this.idleMs);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

interface ClipFiles {
  index: number;
  request: CreateStudioJobRequest['clips'][number];
  raw: string;
  faces: string | null;
  deep: string;
  voice: string;
}

interface InternalJob {
  job: StudioJob;
  dir: string;
  request: CreateStudioJobRequest;
  audioPath: string;
  facesPath: string;
  audioBytes: number;
  faceBytes: number;
  clips: ClipFiles[];
  listeners: Set<(event: StudioEvent) => void>;
  cancelled: boolean;
}

export interface StudioManagerOptions {
  info: StudioInfo;
  dataDir: string;
  staticDir: string | null;
  log?: (message: string) => void;
  /** Finished jobs (and their result files) kept for the client to read. */
  keepFinished?: number;
  /** For tests: a worker to use instead of the real process. */
  worker?: Pick<StudioWorker, 'request' | 'stop'>;
}

const FINAL = new Set<StudioJob['state']>(['done', 'failed', 'cancelled']);

export class StudioManager {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly info: StudioInfo;
  private readonly tmpDir: string;
  private readonly log: (message: string) => void;
  private readonly keepFinished: number;
  private worker: Pick<StudioWorker, 'request' | 'stop'> | null;
  private readonly dataDir: string;
  private readonly staticDir: string | null;
  /** Jobs run one after another: the worker holds one model set, and the GPU is one. */
  private chain: Promise<void> = Promise.resolve();

  constructor(options: StudioManagerOptions) {
    this.info = options.info;
    this.dataDir = options.dataDir;
    this.staticDir = options.staticDir;
    this.tmpDir = path.join(options.dataDir, 'tmp');
    this.log = options.log ?? (() => undefined);
    this.keepFinished = options.keepFinished ?? 10;
    this.worker = options.worker ?? null;
  }

  get available(): boolean {
    return this.info.denoise || this.info.voice;
  }

  get(id: string): StudioJob {
    return this.internal(id).job;
  }

  subscribe(id: string, listener: (event: StudioEvent) => void): () => void {
    const internal = this.internal(id);
    internal.listeners.add(listener);
    return () => internal.listeners.delete(listener);
  }

  private async ensureWorker(): Promise<Pick<StudioWorker, 'request' | 'stop'>> {
    if (this.worker) return this.worker;
    if (!this.info.python) {
      throw new ApiError(400, 'studio_unavailable', this.info.note);
    }
    const speaker = await findSpeakerModel({ dataDir: this.dataDir, pythonPath: null, staticDir: this.staticDir });
    this.worker = new StudioWorker(this.info.python, modelsDir(this.dataDir), speaker, this.log);
    return this.worker;
  }

  /** A new job, waiting for its uploads. */
  async create(request: CreateStudioJobRequest): Promise<StudioJob> {
    const wantsDenoise = request.clips.some((c) => c.denoise);
    const wantsVoice = request.clips.some((c) => c.voice !== 'off');
    if (wantsDenoise && !this.info.denoise) throw new ApiError(400, 'studio_unavailable', this.info.note);
    if (wantsVoice && !this.info.voice) throw new ApiError(400, 'studio_unavailable', this.info.note);
    if (!wantsDenoise && !wantsVoice) throw ApiError.badRequest('No clip asks for anything');
    await fs.mkdir(this.tmpDir, { recursive: true });
    const id = randomUUID();
    const dir = path.join(this.tmpDir, `studio-${id}`);
    await fs.mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    const seconds = (c: CreateStudioJobRequest['clips'][number]) => c.samples / c.rate;
    const clips: ClipFiles[] = request.clips.map((c, index) => ({
      index,
      request: c,
      raw: path.join(dir, `clip-${index}.pcm`),
      faces: c.faceBytes > 0 ? path.join(dir, `faces-${index}.bin`) : null,
      deep: path.join(dir, `clip-${index}.deep.pcm`),
      voice: path.join(dir, `clip-${index}.voice.pcm`),
    }));
    const job: StudioJob = {
      id,
      state: 'uploading',
      createdAt: now,
      updatedAt: now,
      durationSec: request.clips.reduce((s, c) => s + seconds(c), 0),
      denoiseSec: request.clips.filter((c) => c.denoise).reduce((s, c) => s + seconds(c), 0),
      voiceSec: request.clips.filter((c) => c.voice !== 'off').reduce((s, c) => s + seconds(c), 0),
      progress: { stage: 'upload', clip: null, done: 0, total: request.clips.length, fraction: null, message: 'Waiting for the audio…' },
      clips: request.clips.map((c) => ({
        id: c.id,
        deep: false,
        voice: false,
        method: null,
        similarity: null,
        faceFrames: null,
        overlap: null,
        otherShare: null,
        otherLevelDb: null,
        otherRunSec: null,
        error: null,
      })),
      error: null,
    };
    const internal: InternalJob = {
      job,
      dir,
      request,
      audioPath: path.join(dir, 'audio.pcm'),
      facesPath: path.join(dir, 'faces.bin'),
      audioBytes: 0,
      faceBytes: 0,
      clips,
      listeners: new Set(),
      cancelled: false,
    };
    this.jobs.set(id, internal);
    await this.trim();
    return job;
  }

  /** The audio of every clip, in order, as 16-bit PCM. */
  async writeAudio(id: string, body: Readable): Promise<StudioJob> {
    const internal = this.internal(id);
    if (internal.job.state !== 'uploading') throw ApiError.conflict('studio_started', 'The job has already started');
    await pipeline(body, createWriteStream(internal.audioPath));
    internal.audioBytes = (await fs.stat(internal.audioPath)).size;
    return internal.job;
  }

  /** The mouth crops of every clip that has them, in order. */
  async writeFaces(id: string, body: Readable): Promise<StudioJob> {
    const internal = this.internal(id);
    if (internal.job.state !== 'uploading') throw ApiError.conflict('studio_started', 'The job has already started');
    await pipeline(body, createWriteStream(internal.facesPath));
    internal.faceBytes = (await fs.stat(internal.facesPath)).size;
    return internal.job;
  }

  /** Checks the uploads against the manifest, cuts them into clips and queues the work. */
  async start(id: string): Promise<StudioJob> {
    const internal = this.internal(id);
    const { job, request } = internal;
    if (job.state !== 'uploading') throw ApiError.conflict('studio_started', 'The job has already started');
    const expectedAudio = request.clips.reduce((s, c) => s + c.samples * 2, 0);
    if (internal.audioBytes !== expectedAudio) {
      throw ApiError.badRequest(
        `The audio upload has ${internal.audioBytes} bytes; the clips add up to ${expectedAudio}`,
      );
    }
    const expectedFaces = request.clips.reduce((s, c) => s + c.faceBytes, 0);
    if (internal.faceBytes !== expectedFaces) {
      throw ApiError.badRequest(
        `The faces upload has ${internal.faceBytes} bytes; the clips add up to ${expectedFaces}`,
      );
    }
    await this.split(internal);
    job.state = 'queued';
    job.progress = { ...job.progress, message: 'Waiting for the studio…' };
    this.touch(internal);
    this.chain = this.chain.then(() => this.run(internal)).catch(() => undefined);
    return job;
  }

  /** One clip's result as a file path, once it is there. */
  resultPath(id: string, clipId: string, kind: 'deep' | 'voice'): string {
    const internal = this.internal(id);
    const clip = internal.clips.find((c) => c.request.id === clipId);
    const result = internal.job.clips.find((c) => c.id === clipId);
    if (!clip || !result) throw ApiError.notFound(`No clip ${clipId} in this job`);
    if (!result[kind]) throw ApiError.conflict('studio_not_ready', `The ${kind} result of clip ${clipId} is not there yet`);
    return clip[kind];
  }

  /** Stops the job; results already finished stay fetchable. */
  async cancel(id: string): Promise<StudioJob> {
    const internal = this.internal(id);
    const { job } = internal;
    if (FINAL.has(job.state)) return job;
    internal.cancelled = true;
    if (job.state === 'running') this.worker?.stop();
    job.state = 'cancelled';
    job.error = 'Cancelled';
    job.progress = { ...job.progress, message: 'Cancelled' };
    this.touch(internal);
    await Promise.resolve();
    return job;
  }

  async dispose(): Promise<void> {
    for (const internal of this.jobs.values()) {
      if (!FINAL.has(internal.job.state)) await this.cancel(internal.job.id);
    }
    this.worker?.stop();
  }

  /* ---------------------------------------------------------------- the work */

  /** Cuts the two uploads into one file per clip. */
  private async split(internal: InternalJob): Promise<void> {
    const audio = await fs.open(internal.audioPath, 'r');
    const faces = internal.faceBytes > 0 ? await fs.open(internal.facesPath, 'r') : null;
    try {
      let at = 0;
      let facesAt = 0;
      for (const clip of internal.clips) {
        const bytes = clip.request.samples * 2;
        await copyRange(audio, at, bytes, clip.raw);
        at += bytes;
        if (clip.faces && faces) {
          await copyRange(faces, facesAt, clip.request.faceBytes, clip.faces);
          facesAt += clip.request.faceBytes;
        }
      }
    } finally {
      await audio.close();
      await faces?.close();
    }
    await fs.rm(internal.audioPath, { force: true });
    await fs.rm(internal.facesPath, { force: true });
  }

  private async run(internal: InternalJob): Promise<void> {
    const { job } = internal;
    if (internal.cancelled) return;
    job.state = 'running';
    this.touch(internal);
    try {
      const worker = await this.ensureWorker();
      await this.denoiseAll(internal, worker);
      await this.voiceEach(internal, worker);
      if (internal.cancelled) return;
      job.state = 'done';
      job.progress = { stage: 'done', clip: null, done: job.clips.length, total: job.clips.length, fraction: 1, message: 'Done' };
      this.touch(internal);
      this.log(`studio job ${job.id} done`);
    } catch (error) {
      if (internal.cancelled) return;
      job.state = 'failed';
      job.error = errorMessage(error);
      job.progress = { ...job.progress, message: `Failed: ${job.error}` };
      this.touch(internal);
      this.log(`studio job ${job.id} failed: ${job.error}`);
    } finally {
      await this.cleanupInputs(internal);
    }
  }

  /** The deep clean over every clip that asked for it, as one recording per sample rate. */
  private async denoiseAll(internal: InternalJob, worker: Pick<StudioWorker, 'request'>): Promise<void> {
    const { job } = internal;
    const wanted = internal.clips.filter((c) => c.request.denoise);
    if (wanted.length === 0) return;
    const rates = [...new Set(wanted.map((c) => c.request.rate))];
    const total = wanted.reduce((s, c) => s + c.request.samples / c.request.rate, 0);
    let doneSec = 0;
    job.progress = { stage: 'denoise', clip: null, done: 0, total: wanted.length, fraction: 0, message: 'Deep clean: listening to the whole recording…' };
    this.touch(internal);
    for (const rate of rates) {
      if (internal.cancelled) return;
      const group = wanted.filter((c) => c.request.rate === rate);
      const joined = path.join(internal.dir, `denoise-in-${rate}.pcm`);
      const out = path.join(internal.dir, `denoise-out-${rate}.pcm`);
      await concatFiles(
        group.map((c) => c.raw),
        joined,
      );
      const groupSec = group.reduce((s, c) => s + c.request.samples / c.request.rate, 0);
      await worker.request('denoise', { audio: joined, rate, out }, (fraction) => {
        job.progress = {
          ...job.progress,
          fraction: total > 0 ? (doneSec + fraction * groupSec) / total : fraction,
          message: 'Deep clean: listening to the whole recording…',
        };
        this.touch(internal);
      });
      // cut the result back into clips
      const handle = await fs.open(out, 'r');
      try {
        let at = 0;
        for (const clip of group) {
          const bytes = clip.request.samples * 2;
          await copyRange(handle, at, bytes, clip.deep);
          at += bytes;
          const result = job.clips[clip.index];
          if (result) result.deep = true;
        }
      } finally {
        await handle.close();
      }
      await fs.rm(joined, { force: true });
      await fs.rm(out, { force: true });
      doneSec += groupSec;
      job.progress = { ...job.progress, done: job.clips.filter((c) => c.deep).length, fraction: total > 0 ? doneSec / total : 1 };
      this.touch(internal);
    }
  }

  /** Each clip that asked for its voice, one at a time, from its cleaned audio when there is one. */
  private async voiceEach(internal: InternalJob, worker: Pick<StudioWorker, 'request'>): Promise<void> {
    const { job, request } = internal;
    const wanted = internal.clips.filter((c) => c.request.voice !== 'off');
    if (wanted.length === 0) return;
    const total = wanted.reduce((s, c) => s + c.request.samples / c.request.rate, 0);
    let doneSec = 0;
    let done = 0;
    for (const clip of wanted) {
      if (internal.cancelled) return;
      const result = job.clips[clip.index];
      if (!result) continue;
      const seconds = clip.request.samples / clip.request.rate;
      const measure = clip.request.voice === 'measure';
      const label = measure ? 'Listening for a second voice' : 'Keeping only your voice';
      job.progress = {
        stage: 'voice',
        clip: clip.request.id,
        done,
        total: wanted.length,
        fraction: total > 0 ? doneSec / total : 0,
        message: `${label} in phrase ${clip.index + 1}…`,
      };
      this.touch(internal);
      const input = result.deep ? clip.deep : clip.raw;
      try {
        const line = await worker.request(
          'voice',
          {
            audio: input,
            rate: clip.request.rate,
            out: clip.voice,
            faces: clip.request.voice === 'faces' ? clip.faces : null,
            profile: request.profile,
            measure,
          },
          (fraction) => {
            job.progress = { ...job.progress, fraction: total > 0 ? (doneSec + fraction * seconds) / total : fraction };
            this.touch(internal);
          },
        );
        result.method = asMethod(line.method);
        result.similarity = Array.isArray(line.similarity) ? line.similarity.map(Number) : null;
        result.faceFrames = typeof line.faceFrames === 'number' ? line.faceFrames : null;
        result.overlap = typeof line.overlap === 'number' ? line.overlap : null;
        result.otherShare = typeof line.otherShare === 'number' ? line.otherShare : null;
        result.otherLevelDb = typeof line.otherLevelDb === 'number' ? line.otherLevelDb : null;
        result.otherRunSec = typeof line.otherRunSec === 'number' ? line.otherRunSec : null;
        result.voice = !measure && typeof line.samples === 'number';
      } catch (error) {
        if (internal.cancelled) return;
        // one clip failing (a face file the model cannot read, say) does not sink the rest
        result.error = errorMessage(error);
        this.log(`studio job ${job.id}: clip ${clip.request.id} failed: ${result.error}`);
      }
      doneSec += seconds;
      done++;
      job.progress = { ...job.progress, done, fraction: total > 0 ? doneSec / total : 1 };
      this.touch(internal);
    }
  }

  private async cleanupInputs(internal: InternalJob): Promise<void> {
    for (const clip of internal.clips) {
      await fs.rm(clip.raw, { force: true }).catch(() => undefined);
      if (clip.faces) await fs.rm(clip.faces, { force: true }).catch(() => undefined);
    }
  }

  private async remove(internal: InternalJob): Promise<void> {
    await fs.rm(internal.dir, { recursive: true, force: true }).catch(() => undefined);
    this.jobs.delete(internal.job.id);
  }

  private internal(id: string): InternalJob {
    const internal = this.jobs.get(id);
    if (!internal) throw new ApiError(404, 'studio_not_found', 'Unknown studio job. The server may have restarted.');
    return internal;
  }

  private touch(internal: InternalJob): void {
    internal.job.updatedAt = new Date().toISOString();
    const event: StudioEvent = { type: 'job', job: structuredClone(internal.job) };
    for (const l of internal.listeners) l(event);
  }

  /** Finished jobs beyond the last few go, with their files. */
  private async trim(): Promise<void> {
    const finished = [...this.jobs.values()].filter((j) => FINAL.has(j.job.state));
    finished.sort((a, b) => (a.job.updatedAt < b.job.updatedAt ? -1 : 1));
    while (finished.length > this.keepFinished) {
      const victim = finished.shift();
      if (victim) await this.remove(victim);
    }
  }
}

function asMethod(value: unknown): StudioMethod | null {
  return value === 'faces' || value === 'profile' || value === 'energy' ? value : null;
}

/** Copies `bytes` from `offset` of an open file into a new file. */
async function copyRange(handle: fs.FileHandle, offset: number, bytes: number, target: string): Promise<void> {
  const out = await fs.open(target, 'w');
  try {
    const chunk = Buffer.alloc(Math.min(bytes, 4 * 1024 * 1024));
    let at = 0;
    while (at < bytes) {
      const want = Math.min(chunk.length, bytes - at);
      const { bytesRead } = await handle.read(chunk, 0, want, offset + at);
      if (bytesRead === 0) throw new Error('the upload is shorter than the clips add up to');
      await out.write(chunk, 0, bytesRead);
      at += bytesRead;
    }
  } finally {
    await out.close();
  }
}

async function concatFiles(sources: readonly string[], target: string): Promise<void> {
  const out = createWriteStream(target);
  try {
    for (const source of sources) {
      const data = await fs.readFile(source);
      await new Promise<void>((resolve, reject) => {
        out.write(data, (error) => (error ? reject(error) : resolve()));
      });
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }
}

/** The clip result the client sees for a clip that was never asked for anything. */
export function emptyClipResult(id: string): StudioClipResult {
  return {
    id,
    deep: false,
    voice: false,
    method: null,
    similarity: null,
    faceFrames: null,
    overlap: null,
    otherShare: null,
    otherLevelDb: null,
    otherRunSec: null,
    error: null,
  };
}
