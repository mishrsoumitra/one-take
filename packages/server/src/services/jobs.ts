/**
 * Export jobs: receive the browser's encoded file in positioned chunks, then finish it in place or
 * hand it to ffmpeg. Jobs live in memory; a server restart invalidates in-flight uploads.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type Readable } from 'node:stream';

import {
  browserCodecForServerCodec,
  CONTAINER_INFO,
  evenDimension,
  sanitizeFileName,
  type CreateExportJobRequest,
  type ExportJob,
  type FfmpegInfo,
  type JobEvent,
  type JobOutput,
  type JobProgress,
  type ProcessLoad,
  type Sidecar,
  type SystemProfile,
} from '@one-take/shared';

import { ApiError, errorMessage } from '../util/errors.js';
import { Semaphore } from '../util/semaphore.js';

import { buildFfmpegArgs, FfmpegError, formatCommand, runFfmpeg } from './ffmpeg.js';
import {
  directorySize,
  foreignFileIn,
  freeBytes,
  isWritableDirectory,
  normalizeDirectory,
  pathExists,
  removeQuietly,
  uniquePath,
} from './filesystem.js';
import { type ExportLibrary } from './library.js';

interface InternalJob {
  job: ExportJob;
  uploadPath: string;
  handle: fs.FileHandle | null;
  finalPath: string;
  tempOutputPath: string;
  abort: AbortController;
  listeners: Set<(event: JobEvent) => void>;
  /** Serialises chunk writes so positions are honoured even when requests overlap. */
  writeChain: Promise<void>;
  /** The ffmpeg video encoder the job used, once its command has been built. */
  encoder: string | null;
  /** Subtitle and transcript files to write next to the result. */
  sidecars: Sidecar[];
}

export interface JobManagerOptions {
  ffmpeg: FfmpegInfo | null;
  /** Finished jobs kept in memory for the job list. */
  keepFinished?: number;
  log?: (message: string) => void;
  /** The machine profile: decides how many re-encodes run at once and whether decoding uses the GPU. */
  system?: SystemProfile | null;
  /** Reads a process's CPU and memory, for the ffmpeg figures in the progress; null when it cannot. */
  processLoad?: (pid: number) => Promise<ProcessLoad | null>;
  /** Where finished exports are remembered across restarts; null keeps them in memory only. */
  library?: ExportLibrary | null;
}

/** How often the ffmpeg process is sampled for CPU and memory while it runs. */
const PROCESS_SAMPLE_MS = 1000;

/** A progress record with the ffmpeg figures left empty unless given. */
function progressOf(
  p: Pick<JobProgress, 'stage' | 'percent' | 'message'> & Partial<JobProgress>,
): JobProgress {
  return {
    speed: null,
    outTimeSec: null,
    fps: null,
    outputBytes: null,
    process: null,
    ...p,
  };
}

export class JobManager {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly ffmpeg: FfmpegInfo | null;
  private readonly keepFinished: number;
  private readonly log: (message: string) => void;
  /** Re-encodes compete for the same cores, so only `maxEncodeJobs` run at once; the rest wait here. */
  private readonly encodeSlots: Semaphore;
  private readonly processLoad: ((pid: number) => Promise<ProcessLoad | null>) | null;
  private readonly library: ExportLibrary | null;
  /** The verified hardware decoders, best first: the first one decodes uploads when the switch is on. */
  private readonly decoders: string[];

  constructor(options: JobManagerOptions) {
    this.ffmpeg = options.ffmpeg;
    this.keepFinished = options.keepFinished ?? 50;
    this.log = options.log ?? (() => undefined);
    this.encodeSlots = new Semaphore(Math.max(1, options.system?.maxEncodeJobs ?? 1));
    this.processLoad = options.processLoad ?? null;
    this.library = options.library ?? null;
    this.decoders = options.system?.ffmpeg?.decoders ?? [];
  }

  /** The hardware decoder a re-encode with the switch on uses, null when there is none. */
  get hardwareDecoder(): string | null {
    return this.decoders[0] ?? null;
  }

  /** How many re-encodes may run at the same time. */
  get maxEncodeJobs(): number {
    return this.encodeSlots.size;
  }

  list(): ExportJob[] {
    return [...this.jobs.values()].map((j) => j.job).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  get(id: string): ExportJob {
    return this.internal(id).job;
  }

  subscribe(id: string, listener: (event: JobEvent) => void): () => void {
    const internal = this.internal(id);
    internal.listeners.add(listener);
    return () => internal.listeners.delete(listener);
  }

  async create(request: CreateExportJobRequest): Promise<ExportJob> {
    const directory = normalizeDirectory(request.directory);
    if (!(await isWritableDirectory(directory))) {
      throw new ApiError(
        400,
        'directory_not_writable',
        `Cannot write to ${directory}. Choose another folder or create it first.`,
      );
    }
    if (request.processing !== null && this.ffmpeg === null) {
      throw new ApiError(
        400,
        'ffmpeg_missing',
        'This export needs ffmpeg, which was not found on the server.',
      );
    }
    const baseName = sanitizeFileName(request.fileName);
    const finalInfo = CONTAINER_INFO[request.processing?.container ?? request.upload.container];
    const finalExt = finalInfo.isDirectory ? null : finalInfo.extension;

    // Where does the result go, and is it free?
    let finalPath = path.join(directory, finalExt ? `${baseName}.${finalExt}` : baseName);
    if (await pathExists(finalPath)) {
      if (!request.overwrite) {
        finalPath = await uniquePath(directory, baseName, finalExt);
      } else if (finalInfo.isDirectory) {
        await this.assertReplaceableFolder(finalPath);
      }
    }

    // Enough room? The upload plus (when ffmpeg runs) a temporary copy of similar size.
    const needed = request.upload.estimatedBytes * (request.processing ? 2 : 1);
    const free = await freeBytes(directory);
    if (free !== null && needed > free) {
      throw new ApiError(
        400,
        'disk_full',
        `This export may need up to ${Math.ceil(needed / 1e9)} GB but only ${Math.floor(free / 1e9)} GB are free in ${directory}.`,
      );
    }

    const id = randomUUID();
    const uploadExt = CONTAINER_INFO[request.upload.container].extension;
    const uploadPath = path.join(directory, `${baseName}.${id.slice(0, 8)}.uploading.${uploadExt}`);
    const tempOutputPath = finalInfo.isDirectory
      ? path.join(directory, `${baseName}.${id.slice(0, 8)}.processing`)
      : path.join(directory, `${baseName}.${id.slice(0, 8)}.processing.${finalInfo.extension}`);
    const handle = await fs.open(uploadPath, 'w');
    const now = new Date().toISOString();
    const job: ExportJob = {
      id,
      createdAt: now,
      updatedAt: now,
      fileName: path.basename(finalPath),
      directory,
      state: 'uploading',
      bytesReceived: 0,
      progress: progressOf({ stage: 'upload', percent: 0, message: 'Receiving video from the browser…' }),
      outputs: [],
      error: null,
      upload: request.upload,
      processing: request.processing,
      command: null,
      sidecars: [],
    };
    this.jobs.set(id, {
      job,
      uploadPath,
      handle,
      finalPath,
      tempOutputPath,
      abort: new AbortController(),
      listeners: new Set(),
      writeChain: Promise.resolve(),
      encoder: null,
      sidecars: request.sidecars ?? [],
    });
    this.trim();
    this.log(`job ${id} created → ${finalPath}`);
    return job;
  }

  /** Writes a chunk at `offset`. Re-sent chunks simply overwrite the same bytes. */
  async write(id: string, offset: number, body: Readable): Promise<ExportJob> {
    const internal = this.internal(id);
    const { job } = internal;
    if (job.state !== 'uploading')
      throw ApiError.conflict('not_uploading', `Job is ${job.state}; no more data accepted.`);
    const handle = internal.handle;
    if (!handle) throw ApiError.conflict('not_uploading', 'Upload already closed.');

    const chunks: Buffer[] = [];
    for await (const piece of body) {
      chunks.push(Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array));
    }
    const data = Buffer.concat(chunks);
    const run = internal.writeChain.then(async () => {
      let written = 0;
      while (written < data.length) {
        const r = await handle.write(data, written, data.length - written, offset + written);
        written += r.bytesWritten;
      }
      job.bytesReceived = Math.max(job.bytesReceived, offset + data.length);
      job.updatedAt = new Date().toISOString();
    });
    internal.writeChain = run.catch(() => undefined);
    await run;
    const estimated = job.upload.estimatedBytes;
    job.progress = progressOf({
      stage: 'upload',
      percent: estimated > 0 ? Math.min(99, Math.round((job.bytesReceived / estimated) * 100)) : null,
      message: 'Receiving video from the browser…',
    });
    return job;
  }

  async finish(id: string, totalBytes: number): Promise<ExportJob> {
    const internal = this.internal(id);
    const { job } = internal;
    if (job.state !== 'uploading') throw ApiError.conflict('not_uploading', `Job is ${job.state}.`);
    await internal.writeChain;
    const handle = internal.handle;
    if (handle) {
      await handle.sync().catch(() => undefined);
      const size = (await handle.stat()).size;
      if (size < totalBytes) {
        await handle.close();
        internal.handle = null;
        await this.fail(internal, `The upload is incomplete: ${size} of ${totalBytes} bytes arrived.`);
        return job;
      }
      if (size > totalBytes) await handle.truncate(totalBytes);
      await handle.close();
      internal.handle = null;
    }
    job.bytesReceived = totalBytes;
    this.emit(internal);
    void this.process(internal);
    return job;
  }

  async cancel(id: string): Promise<ExportJob> {
    const internal = this.internal(id);
    const { job } = internal;
    if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') return job;
    internal.abort.abort();
    if (internal.handle) {
      await internal.handle.close().catch(() => undefined);
      internal.handle = null;
    }
    job.state = 'cancelled';
    job.error = 'Cancelled';
    job.progress = progressOf({ stage: 'done', percent: null, message: 'Cancelled' });
    job.updatedAt = new Date().toISOString();
    await removeQuietly(internal.uploadPath);
    await removeQuietly(internal.tempOutputPath);
    this.emit(internal);
    this.log(`job ${id} cancelled`);
    return job;
  }

  /** Closes every open handle; used on shutdown. */
  async dispose(): Promise<void> {
    for (const internal of this.jobs.values()) {
      if (internal.job.state === 'uploading' || internal.job.state === 'processing')
        await this.cancel(internal.job.id);
    }
  }

  private async process(internal: InternalJob): Promise<void> {
    const { job } = internal;
    job.state = 'processing';
    job.updatedAt = new Date().toISOString();
    try {
      if (job.processing === null) {
        job.progress = progressOf({ stage: 'finalize', percent: null, message: 'Moving file into place…' });
        this.emit(internal);
        if (await pathExists(internal.finalPath)) await removeQuietly(internal.finalPath);
        await fs.rename(internal.uploadPath, internal.finalPath);
      } else {
        if (!this.ffmpeg) throw new Error('ffmpeg is not available');
        const spec = job.processing;
        const isDir = CONTAINER_INFO[spec.container].isDirectory;
        await removeQuietly(internal.tempOutputPath);
        if (isDir) await fs.mkdir(internal.tempOutputPath, { recursive: true });
        const plan = buildFfmpegArgs(
          spec,
          {
            path: internal.uploadPath,
            videoCodec: job.upload.videoCodec,
            audioCodec: job.upload.audioCodec,
            fps: job.upload.fps,
            height: job.upload.height,
          },
          internal.tempOutputPath,
          this.ffmpeg,
          { hwaccel: this.hardwareDecoder },
        );
        job.command = formatCommand(this.ffmpeg.path, plan.args);
        internal.encoder = plan.videoEncoder;
        if (plan.videoEncoder) {
          this.log(
            `job ${job.id}: ${plan.videoEncoder} encodes${plan.videoDecoder ? `, ${plan.videoDecoder} decodes` : ', the CPU decodes'}`,
          );
        }
        const reencode = spec.video.mode === 'encode';
        if (reencode && !this.encodeSlots.tryAcquire()) {
          job.progress = progressOf({
            stage: 'process',
            percent: null,
            message: 'Waiting for another export to finish re-encoding…',
          });
          this.emit(internal);
          await this.encodeSlots.acquire(internal.abort.signal);
        }
        job.progress = progressOf({
          stage: 'process',
          percent: 0,
          message: reencode
            ? 'Compressing with ffmpeg…'
            : `Packaging as ${CONTAINER_INFO[spec.container].label}…`,
        });
        this.emit(internal);
        this.log(`job ${job.id}: ${job.command}`);
        const duration = job.upload.durationSec;
        let lastEmit = 0;
        const timers: { sampler: NodeJS.Timeout | null } = { sampler: null };
        try {
          await runFfmpeg(this.ffmpeg.path, plan.args, {
            cwd: plan.cwd,
            signal: internal.abort.signal,
            onSpawn: (pid) => {
              // CPU and memory of the ffmpeg process, about once a second, for the live meters.
              const read = this.processLoad;
              if (!read) return;
              let busy = false;
              timers.sampler = setInterval(() => {
                if (busy || job.state !== 'processing') return;
                busy = true;
                void read(pid)
                  .then((load) => {
                    if (!load || job.progress.stage !== 'process') return;
                    job.progress = { ...job.progress, process: load };
                    this.emit(internal);
                  })
                  .catch(() => undefined)
                  .finally(() => {
                    busy = false;
                  });
              }, PROCESS_SAMPLE_MS);
            },
            onProgress: (p) => {
              const now = Date.now();
              if (now - lastEmit < 250) return;
              lastEmit = now;
              const t = p.outTimeSec ?? 0;
              job.progress = {
                ...job.progress,
                stage: 'process',
                percent: duration > 0 ? Math.min(99, Math.round((t / duration) * 100)) : null,
                speed: p.speed,
                outTimeSec: p.outTimeSec,
                fps: p.fps,
                outputBytes: p.outputBytes,
              };
              this.emit(internal);
            },
            onLog: (line) => this.emitLog(internal, line),
          });
        } finally {
          if (timers.sampler) clearInterval(timers.sampler);
          if (reencode) this.encodeSlots.release();
        }
        job.progress = progressOf({ stage: 'finalize', percent: 99, message: 'Moving result into place…' });
        this.emit(internal);
        if (await pathExists(internal.finalPath)) await removeQuietly(internal.finalPath);
        await fs.rename(internal.tempOutputPath, internal.finalPath);
        await removeQuietly(internal.uploadPath);
      }
      job.outputs = await this.describeOutput(internal.finalPath);
      job.sidecars = await this.writeSidecars(internal);
      job.state = 'done';
      job.progress = progressOf({ stage: 'done', percent: 100, message: 'Saved' });
      job.updatedAt = new Date().toISOString();
      await this.remember(internal);
      this.emit(internal);
      this.log(`job ${job.id} done → ${internal.finalPath}`);
    } catch (error) {
      if (internal.abort.signal.aborted) return; // cancel() already reported
      const message = error instanceof FfmpegError ? error.message : errorMessage(error);
      await this.fail(internal, message);
    }
  }

  private async fail(internal: InternalJob, message: string): Promise<void> {
    const { job } = internal;
    job.state = 'failed';
    job.error = message;
    job.progress = progressOf({ stage: 'done', percent: null, message: `Failed: ${message}` });
    job.updatedAt = new Date().toISOString();
    await removeQuietly(internal.uploadPath);
    await removeQuietly(internal.tempOutputPath);
    this.emit(internal);
    this.log(`job ${job.id} failed: ${message}`);
  }

  /** Writes the subtitles and the transcript next to the result (inside the folder for HLS and DASH). */
  private async writeSidecars(internal: InternalJob): Promise<string[]> {
    const { job } = internal;
    if (internal.sidecars.length === 0) return [];
    const final = internal.finalPath;
    const isDir = CONTAINER_INFO[job.processing?.container ?? job.upload.container].isDirectory;
    const base = isDir ? path.basename(final) : path.basename(final, path.extname(final));
    const dir = isDir ? final : path.dirname(final);
    const written: string[] = [];
    for (const s of internal.sidecars) {
      const target = path.join(dir, `${base}.${s.extension}`);
      try {
        await fs.writeFile(target, s.content, 'utf8');
        written.push(target);
      } catch (error) {
        this.log(`job ${job.id}: could not write ${target}: ${errorMessage(error)}`);
      }
    }
    return written;
  }

  /** Writes the finished export into the library, so it is still listed after a restart. */
  private async remember(internal: InternalJob): Promise<void> {
    const { job } = internal;
    const output = job.outputs[0];
    if (!this.library || !output) return;
    const spec = job.processing;
    const encode = spec?.video.mode === 'encode' ? spec.video : null;
    const height = encode?.height ?? job.upload.height;
    const width = evenDimension(Math.round((job.upload.width * height) / job.upload.height));
    await this.library.add({
      id: job.id,
      createdAt: job.updatedAt,
      path: output.path,
      directory: job.directory,
      fileName: path.basename(output.path),
      kind: output.kind,
      container: spec?.container ?? job.upload.container,
      bytes: output.bytes,
      durationSec: job.upload.durationSec,
      width,
      height,
      fps: encode?.fps ?? job.upload.fps,
      videoCodec: encode ? browserCodecForServerCodec(encode.codec) : job.upload.videoCodec,
      audioCodec: spec?.audio.mode === 'encode' ? spec.audio.codec : job.upload.audioCodec,
      encoder: internal.encoder,
      command: job.command,
      sidecars: job.sidecars,
    });
  }

  private async describeOutput(finalPath: string): Promise<JobOutput[]> {
    const st = await fs.stat(finalPath);
    if (st.isDirectory())
      return [{ path: finalPath, kind: 'directory', bytes: await directorySize(finalPath) }];
    return [{ path: finalPath, kind: 'file', bytes: st.size }];
  }

  /** Only folders that look like our own HLS/DASH output may be replaced. */
  private async assertReplaceableFolder(dir: string): Promise<void> {
    const st = await fs.stat(dir);
    if (!st.isDirectory()) return;
    const foreign = await foreignFileIn(dir);
    if (foreign !== null) {
      throw new ApiError(
        400,
        'folder_not_empty',
        `${dir} contains files that are not a One Take export (${foreign}); refusing to replace it.`,
      );
    }
  }

  private internal(id: string): InternalJob {
    const internal = this.jobs.get(id);
    if (!internal)
      throw new ApiError(
        404,
        'job_not_found',
        'Unknown export job. The server may have restarted; please export again.',
      );
    return internal;
  }

  private emit(internal: InternalJob): void {
    const event: JobEvent = { type: 'job', job: structuredClone(internal.job) };
    for (const l of internal.listeners) l(event);
  }

  private emitLog(internal: InternalJob, line: string): void {
    const event: JobEvent = { type: 'log', line };
    for (const l of internal.listeners) l(event);
  }

  private trim(): void {
    const finished = [...this.jobs.values()].filter((j) =>
      ['done', 'failed', 'cancelled'].includes(j.job.state),
    );
    finished.sort((a, b) => (a.job.updatedAt < b.job.updatedAt ? -1 : 1));
    while (finished.length > this.keepFinished) {
      const victim = finished.shift();
      if (victim) this.jobs.delete(victim.job.id);
    }
  }
}
