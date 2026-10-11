/**
 * Orchestrates one export: plan → encode in the browser → (server) finish and follow processing.
 *
 * Progress is reported as steps (encode, process, save) with a time left for the whole export. The
 * time left starts from what the plan expected each step to take and hands over to the measured rate
 * as the work settles (see shared/eta.ts), so it never opens with hours for a job of minutes.
 */
import {
  CONTAINER_INFO,
  estimateExport,
  formatBytes,
  sanitizeFileName,
  StageEta,
  WindowedRate,
  type EtaBasis,
  type ExportJob,
  type ExportPlan,
  type ExportRequest,
} from '@one-take/shared';

import { type ApiClient } from '../api/client.js';
import { type Slide } from '../app/types.js';
import { type Timeline } from '../core/timeline.js';

import { encodeLecture, ExportCancelledError, type EncodeProgress, type EncodeResult } from './encoder.js';
import { createBufferSink, createFileSink, createServerSink, type Sink } from './sinks.js';

export type ExportStage = 'preparing' | 'encoding' | 'processing' | 'finalizing' | 'done';

export type ExportStepId = 'encode' | 'process' | 'finalize';

export interface ExportStep {
  id: ExportStepId;
  /** `Encode in the browser`, `Compress with ffmpeg`, `Save`. */
  label: string;
  runsOn: 'browser' | 'server';
  state: 'pending' | 'active' | 'done';
  /** 0..1 of this step; null while unknown. */
  fraction: number | null;
  /** Seconds this step has been running, or took. */
  elapsedSec: number | null;
  remainingSec: number | null;
  basis: EtaBasis | null;
  /** What the plan expected this step to take. */
  modelSec: number | null;
  /** Live figures for the step: `320 fps · 21× real time · 48 MB written`. */
  detail: string;
}

/** Live figures for the meters. */
export interface ExportMetrics {
  /** Frames per second the browser encoder manages right now. */
  encodeFps: number | null;
  /** Seconds of video per second of wall time, right now. */
  encodeSpeed: number | null;
  /** Bytes the browser has handed to the file or the server. */
  bytesWritten: number;
  /** Bytes per second written right now. */
  writeRate: number | null;
  /** The page's JavaScript heap, where the browser tells (Chrome). */
  heapBytes: number | null;
  /** ffmpeg's figures while it runs on the server. */
  ffmpeg: {
    fps: number | null;
    speed: number | null;
    outputBytes: number | null;
    cpuPercent: number | null;
    rssBytes: number | null;
  } | null;
}

export interface ExportProgress {
  stage: ExportStage;
  /** 0..100 of the current step, or null when unknown. */
  percent: number | null;
  message: string;
  detail: string;
  encode: EncodeProgress | null;
  job: ExportJob | null;
  /** Seconds since the export started. */
  elapsedSec: number;
  /** Seconds left for the whole export; null until something sensible can be said. */
  remainingSec: number | null;
  basis: EtaBasis | null;
  /** 0..1 of the whole export, each step weighted by what the plan expected it to take. */
  overall: number;
  steps: ExportStep[];
  metrics: ExportMetrics;
}

/** What the plan expected each stage to take, from the resource map; the time left starts here. */
export interface ExportEstimates {
  encodeSec: number | null;
  processSec: number | null;
}

/** How WebCodecs was configured for the browser stage, for the result panel and the tests. */
export type EncoderUsed = EncodeResult['encoder'];

export type ExportResult =
  | { kind: 'server'; job: ExportJob; encoder: EncoderUsed }
  | { kind: 'file'; name: string; bytes: number; encoder: EncoderUsed }
  | { kind: 'blob'; name: string; blob: Blob; encoder: EncoderUsed };

export interface RunExportOptions {
  request: ExportRequest;
  plan: ExportPlan;
  timeline: Timeline;
  slides: readonly Slide[];
  api: ApiClient | null;
  signal: AbortSignal;
  onProgress: (progress: ExportProgress) => void;
  estimates?: ExportEstimates;
  /** Skip the save dialog and assemble the file in memory (tests, or browsers that block the picker). */
  forceInMemory?: boolean;
}

const MAX_IN_MEMORY_BYTES = 2 * 1024 ** 3;
/** Moving the result into place is quick; this is what the time left assumes for it. */
const FINALIZE_MODEL_SEC = 2;
/** Without progress events the panel still ticks: elapsed time and the countdown move on. */
const TICK_MS = 1000;
/** ffmpeg's byte count is shown once it is more than a container header. */
export const FFMPEG_BYTES_SHOWN_FROM = 64 * 1024;

export { ExportCancelledError };

const nowSec = () => performance.now() / 1000;

function heapBytes(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  const used = memory?.usedJSHeapSize;
  return typeof used === 'number' && used > 0 ? used : null;
}

/** Keeps the steps, the time left and the live figures, and emits one ExportProgress per change. */
class ProgressTracker {
  readonly steps: ExportStep[];
  private readonly startedAt = nowSec();
  private readonly etas = new Map<ExportStepId, StageEta>();
  private readonly startedSteps = new Map<ExportStepId, number>();
  private readonly fpsRate = new WindowedRate(3);
  private readonly secondsRate = new WindowedRate(3);
  private readonly bytesRate = new WindowedRate(3);
  private metrics: ExportMetrics = {
    encodeFps: null,
    encodeSpeed: null,
    bytesWritten: 0,
    writeRate: null,
    heapBytes: null,
    ffmpeg: null,
  };
  private last: Pick<ExportProgress, 'stage' | 'percent' | 'message' | 'detail' | 'encode' | 'job'> = {
    stage: 'preparing',
    percent: null,
    message: 'Preparing…',
    detail: '',
    encode: null,
    job: null,
  };
  private ticker: number | null = null;

  constructor(
    private readonly onProgress: (progress: ExportProgress) => void,
    steps: { id: ExportStepId; label: string; runsOn: 'browser' | 'server'; modelSec: number | null }[],
  ) {
    this.steps = steps.map((s) => ({
      ...s,
      state: 'pending',
      fraction: null,
      elapsedSec: null,
      remainingSec: null,
      basis: null,
      detail: '',
    }));
    for (const s of steps) this.etas.set(s.id, new StageEta(s.modelSec));
    this.ticker = window.setInterval(() => this.emit(), TICK_MS);
  }

  /** Marks `id` as running; everything before it is done. */
  begin(id: ExportStepId): void {
    const t = nowSec();
    for (const step of this.steps) {
      if (step.id === id) {
        if (step.state === 'active') return;
        step.state = 'active';
        step.fraction = 0;
        this.startedSteps.set(id, t);
        this.etas.get(id)?.update(t, 0);
        break;
      }
      if (step.state !== 'done') this.finish(step.id);
    }
  }

  /** Records how far `id` has come (0..1) and what it is doing. */
  update(id: ExportStepId, fraction: number | null, detail?: string): void {
    const step = this.steps.find((s) => s.id === id);
    if (!step) return;
    if (step.state === 'pending') this.begin(id);
    if (fraction !== null) {
      step.fraction = Math.min(1, Math.max(0, fraction));
      this.etas.get(id)?.update(nowSec(), step.fraction);
    }
    if (detail !== undefined) step.detail = detail;
  }

  finish(id: ExportStepId): void {
    const step = this.steps.find((s) => s.id === id);
    if (!step || step.state === 'done') return;
    const started = this.startedSteps.get(id);
    step.state = 'done';
    step.fraction = 1;
    step.elapsedSec = started === undefined ? 0 : nowSec() - started;
    step.remainingSec = 0;
    // the save step's "moving into place" line is over; the others keep their figures
    if (id === 'finalize') step.detail = '';
  }

  /** The browser encoder's progress: rates over the last few seconds, not since the start. */
  encodeProgress(e: EncodeProgress, bytesWritten: number, toServer: boolean): void {
    const t = nowSec();
    this.fpsRate.add(t, e.frames);
    this.secondsRate.add(t, e.seconds);
    this.bytesRate.add(t, bytesWritten);
    const fps = this.fpsRate.rate();
    const speed = this.secondsRate.rate();
    this.metrics = {
      ...this.metrics,
      encodeFps: fps,
      encodeSpeed: speed,
      bytesWritten,
      writeRate: this.bytesRate.rate(),
      heapBytes: heapBytes(),
    };
    const parts = [
      fps !== null ? `${Math.round(fps)} fps` : null,
      speed !== null ? `${speed.toFixed(1)}× real time` : null,
      `${formatBytes(bytesWritten)} ${toServer ? 'sent to the server' : 'written'}`,
    ].filter((p) => p !== null);
    this.update('encode', e.frames / Math.max(1, e.totalFrames), parts.join(' · '));
    this.emit({
      stage: 'encoding',
      percent: Math.round((e.frames / Math.max(1, e.totalFrames)) * 100),
      message: `Encoding phrase ${e.phrase} of ${e.totalPhrases}…`,
      detail: parts.join(' · '),
      encode: e,
    });
  }

  /** A job event from the server while it processes the upload. */
  jobProgress(job: ExportJob, durationSec: number): void {
    const p = job.progress;
    const stage: ExportStage =
      job.state === 'done' ? 'done' : p.stage === 'finalize' ? 'finalizing' : 'processing';
    if (p.stage === 'process') {
      const fraction =
        p.outTimeSec !== null && durationSec > 0
          ? Math.min(1, p.outTimeSec / durationSec)
          : p.percent !== null
            ? p.percent / 100
            : null;
      const parts = [
        p.fps !== null && p.fps > 0 ? `${Math.round(p.fps)} fps` : null,
        p.speed !== null ? `${p.speed.toFixed(1)}× real time` : null,
        // an MP4 muxer holds its index back, so the count reads a few header bytes until real data flushes
        p.outputBytes !== null && p.outputBytes >= FFMPEG_BYTES_SHOWN_FROM
          ? `${formatBytes(p.outputBytes)} written`
          : null,
        p.process?.cpuPercent !== null && p.process?.cpuPercent !== undefined
          ? `${Math.round(p.process.cpuPercent)} % CPU`
          : null,
      ].filter((x) => x !== null);
      this.metrics = {
        ...this.metrics,
        ffmpeg: {
          fps: p.fps,
          speed: p.speed,
          outputBytes: p.outputBytes,
          cpuPercent: p.process?.cpuPercent ?? null,
          rssBytes: p.process?.rssBytes ?? null,
        },
      };
      // "Waiting for another export" carries no percent: the step is active but not moving.
      this.update(
        'process',
        fraction,
        p.percent === null && fraction === null ? p.message : parts.join(' · '),
      );
    } else if (p.stage === 'finalize') {
      this.begin('finalize');
      this.update('finalize', null, p.message);
    } else if (p.stage === 'done' && job.state === 'done') {
      for (const s of this.steps) this.finish(s.id);
    }
    this.emit({
      stage,
      percent: p.percent,
      message: p.message,
      detail: p.speed ? `${p.speed.toFixed(1)}× real time` : '',
      job,
    });
  }

  /** The whole export is over, one way or another; the ticker stops. */
  stop(): void {
    if (this.ticker !== null) window.clearInterval(this.ticker);
    this.ticker = null;
  }

  emit(update?: Partial<ExportProgress> & Pick<ExportProgress, 'stage' | 'message'>): void {
    if (update) {
      this.last = {
        stage: update.stage,
        percent: update.percent ?? null,
        message: update.message,
        detail: update.detail ?? '',
        encode: update.encode ?? null,
        job: update.job ?? null,
      };
    }
    const t = nowSec();
    let active: ExportStep | null = null;
    let activeEta: { seconds: number | null; basis: EtaBasis | null } = { seconds: null, basis: null };
    let pendingModel: number | null = null;
    let weights = 0;
    let done = 0;
    for (const step of this.steps) {
      const weight = Math.max(1, step.modelSec ?? 5);
      weights += weight;
      if (step.state === 'done') {
        done += weight;
      } else if (step.state === 'active') {
        active = step;
        const started = this.startedSteps.get(step.id);
        step.elapsedSec = started === undefined ? null : t - started;
        activeEta = this.etas.get(step.id)?.current(t) ?? activeEta;
        step.remainingSec = activeEta.seconds;
        step.basis = activeEta.basis;
        done += weight * (step.fraction ?? 0);
      } else if (step.modelSec !== null) {
        // still to come: the plan's figure, which starts counting down once the step runs
        step.remainingSec = step.modelSec;
        step.basis = 'model';
        pendingModel = (pendingModel ?? 0) + step.modelSec;
      }
    }
    // The whole export: the running step's figure plus the plan's figures for the steps to come.
    // Before anything runs the plan alone is shown; a running step without any figure yet says nothing.
    let remaining: number | null = null;
    let basis: EtaBasis | null = null;
    if (this.last.stage === 'done') {
      remaining = 0;
      basis = 'measured';
    } else if (active !== null && activeEta.seconds !== null) {
      remaining = activeEta.seconds + (pendingModel ?? 0);
      basis = activeEta.basis;
    } else if (active === null && pendingModel !== null) {
      remaining = pendingModel;
      basis = 'model';
    }
    this.onProgress({
      ...this.last,
      elapsedSec: t - this.startedAt,
      remainingSec: remaining,
      basis,
      overall: weights > 0 ? Math.min(1, done / weights) : 0,
      steps: this.steps.map((s) => ({ ...s })),
      metrics: { ...this.metrics, heapBytes: heapBytes() ?? this.metrics.heapBytes },
    });
  }
}

/** What the server will do with the upload, as a step label. */
function processLabel(plan: ExportPlan): string {
  const p = plan.processing;
  if (!p) return 'Save';
  const container = CONTAINER_INFO[p.container].label;
  if (p.video.mode === 'copy') return `Package as ${container} on the server`;
  return `Compress with ffmpeg on the server`;
}

export async function runExport(options: RunExportOptions): Promise<ExportResult> {
  const { request, plan, timeline, signal, onProgress } = options;
  if (plan.blockers.length > 0) throw new Error(plan.blockers[0]);
  if (timeline.items.length === 0) throw new Error('Nothing to export yet');
  const info = CONTAINER_INFO[plan.browser.container];
  const baseName = sanitizeFileName(request.fileName);
  const estimate = estimateExport(plan, timeline.total);
  const estimates = options.estimates ?? { encodeSec: null, processSec: null };
  const toServer = plan.destination === 'server';

  const tracker = new ProgressTracker(onProgress, [
    { id: 'encode', label: 'Encode in the browser', runsOn: 'browser', modelSec: estimates.encodeSec },
    ...(toServer && plan.processing
      ? [
          {
            id: 'process' as const,
            label: processLabel(plan),
            runsOn: 'server' as const,
            modelSec: estimates.processSec,
          },
        ]
      : []),
    {
      id: 'finalize',
      label: toServer ? 'Save on the server' : 'Save',
      runsOn: toServer ? 'server' : 'browser',
      modelSec: FINALIZE_MODEL_SEC,
    },
  ]);
  tracker.emit({ stage: 'preparing', message: 'Preparing…' });

  const wakeLock = await requestWakeLock();
  try {
    if (toServer) {
      const api = options.api;
      if (!api) throw new Error('The server is not reachable.');
      if (request.destination.kind !== 'server') throw new Error('Internal: destination mismatch');
      const job = await api.createExport({
        fileName: baseName,
        directory: request.destination.directory,
        overwrite: request.destination.overwrite,
        upload: {
          container: plan.browser.container,
          videoCodec: plan.browser.videoCodec,
          audioCodec: plan.browser.audioCodec,
          width: plan.browser.width,
          height: plan.browser.height,
          fps: plan.browser.fps,
          durationSec: timeline.total,
          estimatedBytes: estimate.uploadBytes,
        },
        processing: plan.processing,
      });
      const sink = createServerSink(api, job.id, signal, plan.browser.container === 'fmp4');
      let encodeResult;
      try {
        encodeResult = await encodeWithSink(sink, options, tracker, true);
      } catch (error) {
        await api.cancelExport(job.id).catch(() => undefined);
        throw error;
      }
      tracker.finish('encode');
      tracker.begin(plan.processing ? 'process' : 'finalize');
      tracker.emit({ stage: 'processing', message: 'Finishing on the server…', percent: null });
      await api.finishExport(job.id, encodeResult.bytes);
      const final = await api.watchExport(
        job.id,
        (event) => {
          if (event.type !== 'job') return;
          tracker.jobProgress(event.job, timeline.total);
        },
        signal,
      );
      if (final.state === 'failed') throw new Error(final.error ?? 'The server could not finish the export.');
      if (final.state === 'cancelled') throw new ExportCancelledError();
      return { kind: 'server', job: final, encoder: encodeResult.encoder };
    }

    // Browser destination: a real file when the browser can stream to disk, otherwise memory + download.
    const fileName = `${baseName}.${info.extension}`;
    let sink: Sink | null = null;
    if (typeof window.showSaveFilePicker === 'function' && !options.forceInMemory) {
      sink = await createFileSink(fileName, info.mimeType as `${string}/${string}`, info.extension);
      if (!sink) throw new ExportCancelledError();
    } else {
      if (estimate.uploadBytes > MAX_IN_MEMORY_BYTES) {
        throw new Error(
          'This export may exceed 2 GB, which does not fit in memory here. Use the server, or lower the quality.',
        );
      }
      sink = createBufferSink(info.mimeType);
    }
    const result = await encodeWithSink(sink, options, tracker, false);
    tracker.finish('encode');
    tracker.begin('finalize');
    const blob = sink.blob();
    tracker.finish('finalize');
    tracker.emit({ stage: 'done', message: 'Done', percent: 100 });
    if (blob) return { kind: 'blob', name: fileName, blob, encoder: result.encoder };
    return { kind: 'file', name: fileName, bytes: result.bytes, encoder: result.encoder };
  } finally {
    tracker.stop();
    wakeLock?.release().catch(() => undefined);
  }
}

async function encodeWithSink(
  sink: Sink,
  options: RunExportOptions,
  tracker: ProgressTracker,
  toServer: boolean,
): Promise<{ bytes: number; frames: number; encoder: EncoderUsed }> {
  tracker.begin('encode');
  tracker.emit({ stage: 'encoding', message: 'Starting the encoder…', percent: 0 });
  try {
    const result = await encodeLecture({
      timeline: options.timeline,
      slides: options.slides,
      plan: options.plan.browser,
      target: sink.target,
      fastStart: sink.fastStart,
      seekable: sink.seekable,
      signal: options.signal,
      onProgress: (e) => tracker.encodeProgress(e, sink.bytes(), toServer),
    });
    tracker.emit({ stage: 'encoding', message: 'Closing the file…', percent: 100 });
    await sink.close();
    return { bytes: Math.max(result.bytes, sink.bytes()), frames: result.frames, encoder: result.encoder };
  } catch (error) {
    await sink.abort();
    throw error;
  }
}

async function requestWakeLock(): Promise<WakeLockSentinel | null> {
  try {
    return await navigator.wakeLock.request('screen');
  } catch {
    return null;
  }
}

/** Offers a Blob as a download. */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
