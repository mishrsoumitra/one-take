/** Orchestrates one export: plan → encode in the browser → (server) finish and follow processing. */
import {
  CONTAINER_INFO,
  estimateExport,
  sanitizeFileName,
  type ExportJob,
  type ExportPlan,
  type ExportRequest,
} from '@one-take/shared';

import { type ApiClient } from '../api/client.js';
import { type Slide } from '../app/types.js';
import { type Timeline } from '../core/timeline.js';

import { encodeLecture, ExportCancelledError, type EncodeProgress } from './encoder.js';
import { createBufferSink, createFileSink, createServerSink, type Sink } from './sinks.js';

export type ExportStage = 'preparing' | 'encoding' | 'processing' | 'finalizing' | 'done';

export interface ExportProgress {
  stage: ExportStage;
  /** 0..100 or null when unknown. */
  percent: number | null;
  message: string;
  detail: string;
  encode: EncodeProgress | null;
  job: ExportJob | null;
}

export type ExportResult =
  | { kind: 'server'; job: ExportJob }
  | { kind: 'file'; name: string; bytes: number }
  | { kind: 'blob'; name: string; blob: Blob };

export interface RunExportOptions {
  request: ExportRequest;
  plan: ExportPlan;
  timeline: Timeline;
  slides: readonly Slide[];
  api: ApiClient | null;
  signal: AbortSignal;
  onProgress: (progress: ExportProgress) => void;
  /** Skip the save dialog and assemble the file in memory (tests, or browsers that block the picker). */
  forceInMemory?: boolean;
}

const MAX_IN_MEMORY_BYTES = 2 * 1024 ** 3;

export { ExportCancelledError };

export async function runExport(options: RunExportOptions): Promise<ExportResult> {
  const { request, plan, timeline, signal, onProgress } = options;
  if (plan.blockers.length > 0) throw new Error(plan.blockers[0]);
  if (timeline.items.length === 0) throw new Error('Nothing to export yet');
  const info = CONTAINER_INFO[plan.browser.container];
  const baseName = sanitizeFileName(request.fileName);
  const estimate = estimateExport(plan, timeline.total);

  const progress = (p: Partial<ExportProgress> & Pick<ExportProgress, 'stage' | 'message'>) => {
    onProgress({ percent: null, detail: '', encode: null, job: null, ...p });
  };
  progress({ stage: 'preparing', message: 'Preparing…' });

  const wakeLock = await requestWakeLock();
  try {
    if (plan.destination === 'server') {
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
        encodeResult = await encodeWithSink(sink, options, progress);
      } catch (error) {
        await api.cancelExport(job.id).catch(() => undefined);
        throw error;
      }
      progress({ stage: 'processing', message: 'Finishing on the server…', percent: null });
      await api.finishExport(job.id, encodeResult.bytes);
      const final = await api.watchExport(
        job.id,
        (event) => {
          if (event.type !== 'job') return;
          const j = event.job;
          progress({
            stage:
              j.state === 'done' ? 'done' : j.progress.stage === 'finalize' ? 'finalizing' : 'processing',
            percent: j.progress.percent,
            message: j.progress.message,
            detail: j.progress.speed ? `${j.progress.speed.toFixed(1)}× real time` : '',
            job: j,
          });
        },
        signal,
      );
      if (final.state === 'failed') throw new Error(final.error ?? 'The server could not finish the export.');
      if (final.state === 'cancelled') throw new ExportCancelledError();
      return { kind: 'server', job: final };
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
    const result = await encodeWithSink(sink, options, progress);
    const blob = sink.blob();
    progress({ stage: 'done', message: 'Done', percent: 100 });
    if (blob) return { kind: 'blob', name: fileName, blob };
    return { kind: 'file', name: fileName, bytes: result.bytes };
  } finally {
    wakeLock?.release().catch(() => undefined);
  }
}

async function encodeWithSink(
  sink: Sink,
  options: RunExportOptions,
  progress: (p: Partial<ExportProgress> & Pick<ExportProgress, 'stage' | 'message'>) => void,
): Promise<{ bytes: number; frames: number }> {
  const startedAt = performance.now();
  try {
    const result = await encodeLecture({
      timeline: options.timeline,
      slides: options.slides,
      plan: options.plan.browser,
      target: sink.target,
      fastStart: sink.fastStart,
      seekable: sink.seekable,
      signal: options.signal,
      onProgress: (e) => {
        const elapsed = (performance.now() - startedAt) / 1000;
        const speed = elapsed > 0 ? e.seconds / elapsed : 0;
        const remaining = speed > 0 ? (e.totalSeconds - e.seconds) / speed : null;
        progress({
          stage: 'encoding',
          percent: Math.round((e.frames / Math.max(1, e.totalFrames)) * 100),
          message: `Encoding phrase ${e.phrase} of ${e.totalPhrases}…`,
          detail: `${speed.toFixed(1)}× real time · ${formatBytesShort(sink.bytes())} written${remaining !== null ? ` · about ${Math.ceil(remaining)} s left` : ''}`,
          encode: e,
        });
      },
    });
    await sink.close();
    return { bytes: Math.max(result.bytes, sink.bytes()), frames: result.frames };
  } catch (error) {
    await sink.abort();
    throw error;
  }
}

function formatBytesShort(bytes: number): string {
  if (bytes < 1e6) return `${Math.round(bytes / 1e3)} kB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
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
