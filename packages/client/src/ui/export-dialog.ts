/** The export dialog: every knob of the pipeline, a live plan with estimates, progress and the result. */
import {
  AUDIO_BITRATES_KBPS,
  AUDIO_CODEC_INFO,
  COMPRESSION_PRESETS,
  CONTAINER_INFO,
  CONTAINERS,
  CRF_RANGES,
  FPS_OPTIONS,
  QUALITY_LABELS,
  QUALITY_LEVELS,
  RESOLUTION_PRESETS,
  RESOLUTION_SIZES,
  SEGMENT_SECONDS_OPTIONS,
  SERVER_VIDEO_CODECS,
  VIDEO_CODEC_INFO,
  VIDEO_CODECS,
  PERFORMANCE_MODE_INFO,
  PERFORMANCE_MODES,
  applyPerformanceMode,
  describeSystem,
  estimateExport,
  estimateResources,
  formatBytes,
  formatDuration,
  formatEta,
  formatGb,
  hardwareCodecLabels,
  peakMemoryBytes,
  performanceWarnings,
  pickServerVideoEncoder,
  planExport,
  resolveResolution,
  sanitizeFileName,
  serverUsesHardware,
  softwareBeatsHardware,
  totalSeconds,
  type BrowserCapabilities,
  type Container,
  type ExportPlan,
  type ExportRequest,
  type PerformanceMode,
  type ResourceLine,
  type ServerCapabilities,
  type SystemLoad,
} from '@one-take/shared';

import { type ApiClient } from '../api/client.js';
import { type Slide } from '../app/types.js';
import { type PhraseOrder, type Timeline } from '../core/timeline.js';
import { canRecordRealtime, recordRealtime } from '../export/fallback.js';
import {
  downloadBlob,
  ExportCancelledError,
  FFMPEG_BYTES_SHOWN_FROM,
  runExport,
  type ExportEstimates,
  type ExportProgress,
  type ExportResult,
  type ExportStep,
} from '../export/runner.js';

import { clear, h, replaceChildren, syncRangeFill } from './dom.js';
import { type FolderPicker } from './folder-picker.js';
import { icon } from './icon.js';

export interface ExportDialogDeps {
  api: ApiClient;
  folderPicker: FolderPicker;
  browserCaps: () => BrowserCapabilities;
  serverCaps: () => ServerCapabilities | null;
  refreshServer: () => Promise<ServerCapabilities | null>;
  timeline: (order: PhraseOrder) => Timeline;
  slides: () => readonly Slide[];
  suggestedName: () => string;
  initialRequest: () => ExportRequest;
  onRequestChange: (request: ExportRequest) => void;
  /** The hardware switch is a browser preference: read on opening, written when the user flips it. */
  hardwarePreference: () => boolean;
  onHardwarePreferenceChange: (on: boolean) => void;
  /** Opens the list of exported videos. */
  onOpenLibrary: () => void;
  onExportingChange: (exporting: boolean) => void;
  onBeforeExport: () => void;
}

interface Option<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  title?: string;
}

function setOptions<T extends string>(select: HTMLSelectElement, options: Option<T>[], value: T): void {
  clear(select);
  for (const o of options) {
    select.appendChild(
      h('option', { value: o.value, disabled: o.disabled ?? false, title: o.title }, o.label),
    );
  }
  select.value = value;
  if (select.value !== value) {
    const first = options.find((o) => !o.disabled);
    if (first) select.value = first.value;
  }
}

function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h(
    'div',
    { class: 'row' },
    h('label', null, label),
    h('div', { class: 'ctl' }, control, hint ? h('div', { class: 'hint' }, hint) : null),
  );
}

function section(title: string, ...children: (HTMLElement | null)[]): HTMLElement {
  return h('section', { class: 'sec' }, h('h4', null, title), ...children);
}

/** A checkbox or radio with its text beside it; the text wraps under itself, never under the box. */
function check(input: HTMLInputElement, text: string, ...rest: (HTMLElement | string)[]): HTMLElement {
  return h('label', { class: 'check' }, input, h('span', null, text, ...rest));
}

/** A number field that fills its row, with its unit after it: `[ 4 ] s`. */
function unit(input: HTMLElement, suffix: string): HTMLElement {
  return h('span', { class: 'unit' }, input, h('span', { class: 'suffix' }, suffix));
}

/** Seconds since an export started, as `m:ss` or `h:mm:ss`. */
function formatElapsed(seconds: number): string {
  return formatDuration(seconds);
}

/** Why the time left reads what it does. */
function basisText(p: ExportProgress): string {
  if (p.stage === 'done') return '';
  switch (p.basis) {
    case 'measured':
      return 'measured over the last few seconds';
    case 'measuring':
      return 'from the plan, settling on the measured speed';
    case 'model':
      return 'from the plan; measuring…';
    case null:
      return p.remainingSec === null ? 'measuring…' : '';
  }
}

/** A step's own time left, as a short clause for its row. */
function stepTimeLeft(step: ExportStep): string {
  if (step.state === 'done')
    return step.elapsedSec !== null ? `took ${formatElapsed(step.elapsedSec)}` : 'done';
  if (step.remainingSec === null) return step.state === 'active' ? 'measuring…' : '';
  const eta = formatEta(step.remainingSec);
  const about = step.basis === 'measured' || step.remainingSec < 8 ? '' : 'about ';
  return `${about}${eta} left`;
}

/** `45 s`, `3 min`, `1 h 20 min`. */
function formatSeconds(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function number(
  value: number | null,
  min: number,
  max: number,
  step: number,
  onChange: (v: number | null) => void,
  placeholder = '',
): HTMLInputElement {
  const input = h('input', {
    type: 'number',
    min,
    max,
    step,
    placeholder,
    value: value === null ? '' : String(value),
  });
  input.oninput = () => {
    const v = input.value.trim() === '' ? null : Number(input.value);
    onChange(v !== null && Number.isFinite(v) ? v : null);
  };
  return input;
}

export class ExportDialog {
  private readonly overlay: HTMLElement;
  private readonly box: HTMLElement;
  private request: ExportRequest;
  private opened = false;
  private plan: ExportPlan | null = null;
  /** The resource map of the current plan; its times seed the time left when an export starts. */
  private resourceLines: readonly ResourceLine[] = [];
  private running: AbortController | null = null;
  private lastJobId: string | null = null;
  private lastProgress: ExportProgress | null = null;
  /** The computer's load, polled once a second while an export runs. */
  private load: SystemLoad | null = null;
  private loadTimer: number | null = null;
  private loadFailed = false;
  private view: 'settings' | 'progress' = 'settings';
  private readonly els: {
    sumTime: HTMLElement;
    sumSegs: HTMLElement;
    sumSlides: HTMLElement;
    fileName: HTMLInputElement;
    destServer: HTMLInputElement;
    destBrowser: HTMLInputElement;
    serverNote: HTMLElement;
    folderRow: HTMLElement;
    folderPath: HTMLElement;
    overwrite: HTMLInputElement;
    container: HTMLSelectElement;
    containerNote: HTMLElement;
    streaming: HTMLElement;
    segmentSeconds: HTMLSelectElement;
    hlsType: HTMLSelectElement;
    hlsTypeRow: HTMLElement;
    ladder: HTMLInputElement;
    resolution: HTMLSelectElement;
    customSize: HTMLElement;
    width: HTMLInputElement;
    height: HTMLInputElement;
    fps: HTMLSelectElement;
    customFps: HTMLInputElement;
    customFpsWrap: HTMLElement;
    quality: HTMLSelectElement;
    customKbps: HTMLInputElement;
    customKbpsWrap: HTMLElement;
    videoCodec: HTMLSelectElement;
    keyInt: HTMLInputElement;
    audioCodec: HTMLSelectElement;
    audioBitrate: HTMLSelectElement;
    compression: HTMLElement;
    compEnabled: HTMLInputElement;
    compBody: HTMLElement;
    compCodec: HTMLSelectElement;
    crf: HTMLInputElement;
    crfV: HTMLElement;
    preset: HTMLSelectElement;
    tune: HTMLInputElement;
    tuneRow: HTMLElement;
    outFps: HTMLInputElement;
    outHeight: HTMLInputElement;
    maxBitrate: HTMLInputElement;
    compNote: HTMLElement;
    order: HTMLSelectElement;
    sysLine: HTMLElement;
    /** The hardware switch and the line under it saying what was found. */
    hardware: HTMLInputElement;
    hardwareNote: HTMLElement;
    modes: HTMLElement;
    modeInputs: Record<PerformanceMode, HTMLInputElement>;
    resources: HTMLElement;
    planBox: HTMLElement;
    warnings: HTMLElement;
    blockers: HTMLElement;
    settings: HTMLElement;
    // the exporting view
    panel: HTMLElement;
    panelTitle: HTMLElement;
    panelSub: HTMLElement;
    heroEta: HTMLElement;
    heroBasis: HTMLElement;
    kElapsed: HTMLElement;
    kOverall: HTMLElement;
    kWritten: HTMLElement;
    bigBar: HTMLElement;
    steps: HTMLElement;
    status: HTMLElement;
    cpuMeter: HTMLElement;
    cpuBar: HTMLElement;
    cpuText: HTMLElement;
    memMeter: HTMLElement;
    memBar: HTMLElement;
    memText: HTMLElement;
    factBrowser: HTMLElement;
    factFfmpeg: HTMLElement;
    factDisk: HTMLElement;
    loadNote: HTMLElement;
    result: HTMLElement;
    btnExport: HTMLButtonElement;
    btnCancel: HTMLButtonElement;
    btnClose: HTMLButtonElement;
    btnBack: HTMLButtonElement;
    fallback: HTMLElement;
  };

  constructor(
    parent: HTMLElement,
    private readonly deps: ExportDialogDeps,
  ) {
    this.request = deps.initialRequest();
    const r = this.request;
    const e = {} as ExportDialog['els'];

    e.sumTime = h('b', null, '0:00');
    e.sumSegs = h('b', null, '0');
    e.sumSlides = h('b', null, '0');

    e.fileName = h('input', { type: 'text', value: r.fileName, style: 'width:100%' });
    e.fileName.oninput = () =>
      this.update((q) => {
        q.fileName = e.fileName.value;
      });

    e.destServer = h('input', { type: 'radio', name: 'dest' });
    e.destBrowser = h('input', { type: 'radio', name: 'dest' });
    e.destServer.onchange = () => this.setDestination('server');
    e.destBrowser.onchange = () => this.setDestination('browser');
    e.serverNote = h('span', { class: 'hint' });
    e.folderPath = h('code', { class: 'path' });
    e.overwrite = h('input', { type: 'checkbox' });
    e.overwrite.onchange = () =>
      this.update((q) => {
        if (q.destination.kind === 'server') q.destination.overwrite = e.overwrite.checked;
      });
    e.folderRow = row(
      'Folder',
      h(
        'div',
        { class: 'stack' },
        h(
          'div',
          { class: 'folderrow' },
          e.folderPath,
          h(
            'button',
            { id: 'btnBrowse', on: { click: () => void this.browse() } },
            icon('folder-open', 16),
            'Browse…',
          ),
        ),
        check(e.overwrite, 'replace an existing file of the same name'),
      ),
    );

    e.container = h('select');
    e.container.onchange = () =>
      this.update((q) => {
        q.container = e.container.value as Container;
      });
    e.containerNote = h('div', { class: 'hint' });
    e.segmentSeconds = h('select');
    setOptions(
      e.segmentSeconds,
      SEGMENT_SECONDS_OPTIONS.map((s) => ({ value: String(s), label: `${s} s` })),
      String(r.streaming.segmentSeconds),
    );
    e.segmentSeconds.onchange = () =>
      this.update((q) => {
        q.streaming.segmentSeconds = Number(e.segmentSeconds.value);
      });
    e.hlsType = h('select');
    setOptions(
      e.hlsType,
      [
        { value: 'fmp4', label: 'fMP4 segments (.m4s, modern players)' },
        { value: 'mpegts', label: 'MPEG-TS segments (.ts, widest support)' },
      ],
      r.streaming.hlsSegmentType,
    );
    e.hlsType.onchange = () =>
      this.update((q) => {
        q.streaming.hlsSegmentType = e.hlsType.value as 'fmp4' | 'mpegts';
      });
    e.hlsTypeRow = row('Segment type', e.hlsType);
    e.ladder = h('input', { type: 'checkbox', checked: r.streaming.ladder });
    e.ladder.onchange = () =>
      this.update((q) => {
        q.streaming.ladder = e.ladder.checked;
      });
    e.streaming = h(
      'div',
      { class: 'sub' },
      row('Segment length', e.segmentSeconds, 'Shorter segments start faster; longer ones compress better.'),
      e.hlsTypeRow,
      row(
        'Adaptive bitrate',
        check(e.ladder, 'several renditions (1080p/720p/480p/360p) so the player can switch quality'),
        'Re-encodes on the server with ffmpeg.',
      ),
    );

    e.resolution = h('select');
    e.resolution.onchange = () =>
      this.update((q) => {
        const v = e.resolution.value;
        q.resolution =
          v === 'custom'
            ? { width: Number(e.width.value) || 1920, height: Number(e.height.value) || 1080 }
            : { preset: v as (typeof RESOLUTION_PRESETS)[number] };
      });
    const size = resolveResolution(r.resolution);
    e.width = number(size.width, 16, 7680, 2, () =>
      this.update((q) => {
        q.resolution = { width: Number(e.width.value) || 1920, height: Number(e.height.value) || 1080 };
      }),
    );
    e.height = number(size.height, 16, 4320, 2, () =>
      this.update((q) => {
        q.resolution = { width: Number(e.width.value) || 1920, height: Number(e.height.value) || 1080 };
      }),
    );
    e.customSize = h(
      'span',
      { class: 'unit pair' },
      e.width,
      h('span', { class: 'suffix' }, '×'),
      e.height,
      h('span', { class: 'suffix' }, 'px'),
    );

    e.fps = h('select');
    e.fps.onchange = () =>
      this.update((q) => {
        if (e.fps.value !== 'custom') q.fps = Number(e.fps.value);
      });
    e.customFps = number(r.fps, 1, 120, 1, (v) =>
      this.update((q) => {
        if (v !== null) q.fps = Math.min(120, Math.max(1, v));
      }),
    );
    e.customFpsWrap = unit(e.customFps, 'fps');

    e.quality = h('select');
    e.quality.onchange = () =>
      this.update((q) => {
        const v = e.quality.value;
        q.video.quality =
          v === 'custom'
            ? { kind: 'bitrate', kbps: Number(e.customKbps.value) || 5000 }
            : { kind: 'level', level: v as (typeof QUALITY_LEVELS)[number] };
      });
    e.customKbps = number(
      r.video.quality.kind === 'bitrate' ? r.video.quality.kbps : 5000,
      100,
      200000,
      100,
      (v) =>
        this.update((q) => {
          if (v !== null) q.video.quality = { kind: 'bitrate', kbps: Math.round(v) };
        }),
    );
    e.customKbpsWrap = unit(e.customKbps, 'kbit/s');

    e.videoCodec = h('select');
    e.videoCodec.onchange = () =>
      this.update((q) => {
        q.video.codec = e.videoCodec.value as ExportRequest['video']['codec'];
      });
    e.keyInt = number(r.video.keyFrameIntervalSec, 0.5, 60, 0.5, (v) =>
      this.update((q) => {
        if (v !== null) q.video.keyFrameIntervalSec = v;
      }),
    );

    e.audioCodec = h('select');
    e.audioCodec.onchange = () =>
      this.update((q) => {
        q.audio.codec = e.audioCodec.value as ExportRequest['audio']['codec'];
      });
    e.audioBitrate = h('select');
    setOptions(
      e.audioBitrate,
      AUDIO_BITRATES_KBPS.map((k) => ({ value: String(k), label: `${k} kbit/s` })),
      String(r.audio.bitrateKbps),
    );
    e.audioBitrate.onchange = () =>
      this.update((q) => {
        q.audio.bitrateKbps = Number(e.audioBitrate.value);
      });

    e.compEnabled = h('input', { type: 'checkbox', checked: r.compression.enabled });
    e.compEnabled.onchange = () =>
      this.update((q) => {
        q.compression.enabled = e.compEnabled.checked;
      });
    e.compCodec = h('select');
    e.compCodec.onchange = () =>
      this.update((q) => {
        q.compression.codec = e.compCodec.value as ExportRequest['compression']['codec'];
        q.compression.crf = CRF_RANGES[q.compression.codec].default;
        e.crf.value = String(q.compression.crf);
      });
    e.crf = h('input', { type: 'range', min: 0, max: 51, step: 1, value: String(r.compression.crf) });
    e.crf.oninput = () =>
      this.update((q) => {
        q.compression.crf = Number(e.crf.value);
      });
    e.crfV = h('b', null, String(r.compression.crf));
    e.preset = h('select');
    setOptions(
      e.preset,
      COMPRESSION_PRESETS.map((p) => ({ value: p, label: p })),
      r.compression.preset,
    );
    e.preset.onchange = () =>
      this.update((q) => {
        q.compression.preset = e.preset.value as ExportRequest['compression']['preset'];
      });
    e.tune = h('input', { type: 'checkbox', checked: r.compression.tune === 'stillimage' });
    e.tune.onchange = () =>
      this.update((q) => {
        q.compression.tune = e.tune.checked ? 'stillimage' : 'none';
      });
    e.tuneRow = row(
      'Tune',
      check(e.tune, 'optimise for still images (slides)'),
      'x264 only. Sharper text at the same size.',
    );
    e.outFps = number(
      r.compression.outputFps,
      1,
      120,
      1,
      (v) =>
        this.update((q) => {
          q.compression.outputFps = v;
        }),
      'same',
    );
    e.outHeight = number(
      r.compression.height,
      16,
      4320,
      2,
      (v) =>
        this.update((q) => {
          q.compression.height = v === null ? null : Math.round(v);
        }),
      'same',
    );
    e.maxBitrate = number(
      r.compression.maxBitrateKbps,
      100,
      200000,
      100,
      (v) =>
        this.update((q) => {
          q.compression.maxBitrateKbps = v === null ? null : Math.round(v);
        }),
      'none',
    );
    e.compNote = h('div', { class: 'hint' });
    e.compBody = h(
      'div',
      { class: 'sub' },
      row('Codec', e.compCodec),
      row(
        'Quality (CRF)',
        h('span', { class: 'unit slider' }, e.crf, h('span', { class: 'suffix' }, e.crfV)),
        'Lower is better quality and a bigger file. 18 is near lossless, 23 is the x264 default, 28 is small.',
      ),
      row('Speed preset', e.preset, 'Slower presets squeeze out a smaller file for the same quality.'),
      e.tuneRow,
      row('Output frame rate', unit(e.outFps, 'fps'), 'Leave empty to keep the recorded rate.'),
      row('Scale to height', unit(e.outHeight, 'px'), 'Leave empty to keep the recorded size.'),
      row('Max bitrate', unit(e.maxBitrate, 'kbit/s'), 'Caps peaks for streaming; leave empty for pure CRF.'),
      e.compNote,
    );
    e.compression = section(
      'Compression (server, ffmpeg)',
      row(
        'Compress',
        check(e.compEnabled, 're-encode on the server with a CRF quality target'),
        'The browser encodes at a high mezzanine quality first; ffmpeg then produces the final, smaller file.',
      ),
      e.compBody,
    );

    e.order = h('select');
    setOptions(
      e.order,
      [
        { value: 'recorded', label: 'As recorded (slides may repeat)' },
        { value: 'slide', label: 'Grouped by slide number' },
      ],
      r.order,
    );
    e.order.onchange = () =>
      this.update((q) => {
        q.order = e.order.value as PhraseOrder;
      });

    // System check, the hardware switch and the performance mode.
    e.sysLine = h('div', { class: 'sys', id: 'sysLine' });
    e.hardware = h('input', { type: 'checkbox', id: 'hwSwitch', checked: r.performance.hardware });
    e.hardware.onchange = () => {
      this.deps.onHardwarePreferenceChange(e.hardware.checked);
      this.update((q) => {
        q.performance.hardware = e.hardware.checked;
      });
    };
    e.hardwareNote = h('div', { class: 'hint', id: 'hwNote' });
    e.modeInputs = {} as Record<PerformanceMode, HTMLInputElement>;
    e.modes = h(
      'div',
      { class: 'modes', id: 'perfModes' },
      ...PERFORMANCE_MODES.map((mode) => {
        const input = h('input', { type: 'radio', name: 'perfMode', value: mode });
        input.onchange = () => {
          if (!input.checked) return;
          this.update((q) => {
            applyPerformanceMode(q, mode);
          });
          this.syncInputs();
        };
        e.modeInputs[mode] = input;
        const info = PERFORMANCE_MODE_INFO[mode];
        return h('label', null, input, h('span', null, info.label, h('small', null, info.description)));
      }),
    );
    e.resources = h('div', { class: 'resources', id: 'resources' });

    e.planBox = h('div', { class: 'plan' });
    e.warnings = h('ul', { class: 'warnings' });
    e.blockers = h('ul', { class: 'blockers' });

    e.fallback = h('div', { class: 'fallback alert warning', hidden: true });

    // The exporting view: the time left, the steps, and what the computer is doing meanwhile.
    e.panelTitle = h('div', { class: 'title', id: 'exportTitle' });
    e.panelSub = h('div', { class: 'hint' });
    e.heroEta = h('div', { class: 'hero-figure', id: 'etaFigure' }, '…');
    e.heroBasis = h('div', { class: 'hint', id: 'etaBasis' });
    e.kElapsed = h('b', { id: 'kElapsed' }, '0:00');
    e.kOverall = h('b', { id: 'kOverall' }, '0 %');
    e.kWritten = h('b', { id: 'kWritten' }, '0 B');
    e.bigBar = h('i');
    e.steps = h('ol', { class: 'steps', id: 'exportSteps' });
    e.status = h('div', { class: 'status', id: 'exportStatus' });
    e.cpuBar = h('i');
    e.cpuText = h('span', { class: 'val', id: 'cpuText' }, '…');
    e.memBar = h('i');
    e.memText = h('span', { class: 'val', id: 'memText' }, '…');
    const meter = (id: string, label: string, bar: HTMLElement, text: HTMLElement): HTMLElement =>
      h(
        'div',
        { class: 'meter', id },
        h('div', { class: 'meter-head' }, h('span', null, label), text),
        h('div', { class: 'progress' }, bar),
      );
    e.cpuMeter = meter('cpuMeter', 'CPU, whole computer', e.cpuBar, e.cpuText);
    e.memMeter = meter('memMeter', 'Memory in use', e.memBar, e.memText);
    e.factBrowser = h('div', { class: 'fact', id: 'factBrowser' });
    e.factFfmpeg = h('div', { class: 'fact', id: 'factFfmpeg' });
    e.factDisk = h('div', { class: 'fact', id: 'factDisk' });
    e.loadNote = h('div', { class: 'hint' });
    const kpi = (label: string, value: HTMLElement): HTMLElement =>
      h('div', { class: 'kpi' }, value, h('span', null, label));
    e.result = h('div', { id: 'result', class: 'alert success', hidden: true });
    e.panel = h(
      'div',
      { id: 'exportProgress', class: 'exporting', hidden: true },
      h('div', { class: 'head' }, e.panelTitle, e.panelSub),
      h(
        'div',
        { class: 'hero' },
        h('div', { class: 'eta' }, h('div', { class: 'overline' }, 'Time left'), e.heroEta, e.heroBasis),
        h(
          'div',
          { class: 'kpis' },
          kpi('elapsed', e.kElapsed),
          kpi('done', e.kOverall),
          kpi('written', e.kWritten),
        ),
      ),
      h('div', { class: 'progress big', id: 'bar' }, e.bigBar),
      e.steps,
      e.status,
      section(
        'This computer, live',
        h('div', { class: 'meters' }, e.cpuMeter, e.memMeter),
        h('div', { class: 'facts' }, e.factBrowser, e.factFfmpeg, e.factDisk),
        e.loadNote,
      ),
      e.result,
    );

    e.btnExport = h(
      'button',
      { class: 'primary', id: 'btnStartExport', on: { click: () => void this.start() } },
      icon('download'),
      'Export',
    );
    e.btnCancel = h(
      'button',
      { class: 'danger', id: 'btnCancelExport', hidden: true, on: { click: () => this.cancel() } },
      'Cancel export',
    );
    e.btnBack = h(
      'button',
      {
        class: 'ghost',
        id: 'btnBackToSettings',
        hidden: true,
        on: { click: () => this.setView('settings') },
      },
      icon('chevron-left', 16),
      'Back to settings',
    );
    e.btnClose = h('button', { id: 'btnCloseExport', on: { click: () => this.close() } }, 'Close');
    const btnLibrary = h(
      'button',
      {
        class: 'ghost',
        id: 'btnExportLibrary',
        title: 'The videos exported so far: watch, show in folder, delete',
        on: { click: () => this.deps.onOpenLibrary() },
      },
      icon('folder', 16),
      'Exported videos…',
    );

    e.settings = h(
      'div',
      { class: 'settings' },
      h(
        'div',
        { class: 'summary' },
        h('div', null, e.sumTime, h('span', null, 'video length')),
        h('div', null, e.sumSegs, h('span', null, 'phrases')),
        h('div', null, e.sumSlides, h('span', null, 'slides used')),
      ),
      h(
        'div',
        { class: 'cols' },
        h(
          'div',
          { class: 'col' },
          section(
            'Destination',
            row(
              'Save to',
              h(
                'div',
                { class: 'stack checks' },
                check(e.destServer, 'a folder on this computer ', e.serverNote),
                check(e.destBrowser, 'the browser (save dialog or download)'),
              ),
            ),
            e.folderRow,
            row('File name', e.fileName),
          ),
          section('Format', row('Container', e.container, undefined), e.containerNote, e.streaming),
          section(
            'Video',
            row('Resolution', h('div', { class: 'stack' }, e.resolution, e.customSize)),
            row(
              'Frame rate',
              h('div', { class: 'stack' }, e.fps, e.customFpsWrap),
              'Slides are still images: 10–15 fps looks identical to 30 and exports faster.',
            ),
            row(
              'Quality',
              h('div', { class: 'stack' }, e.quality, e.customKbpsWrap),
              'An upper bound; still slides compress far below it.',
            ),
            row('Video codec', e.videoCodec),
            row('Key frame every', unit(e.keyInt, 's'), 'Smaller values seek faster and make bigger files.'),
          ),
          section('Audio', row('Codec', e.audioCodec), row('Bitrate', e.audioBitrate)),
        ),
        h(
          'div',
          { class: 'col' },
          section(
            'This computer',
            e.sysLine,
            h(
              'div',
              { class: 'hw', id: 'hwRow' },
              check(e.hardware, 'Use the hardware encoder when this computer has one'),
              e.hardwareNote,
            ),
            e.modes,
          ),
          e.compression,
          section('Order', row('Phrases', e.order)),
          section('Plan', e.planBox, e.resources, e.warnings, e.blockers),
        ),
      ),
      e.fallback,
    );

    this.els = e;
    this.box = h(
      'div',
      { class: 'box wide' },
      h('h3', null, 'Export video'),
      e.settings,
      e.panel,
      h(
        'div',
        { class: 'actions' },
        e.btnBack,
        e.btnCancel,
        btnLibrary,
        h('div', { class: 'spacer' }),
        e.btnClose,
        e.btnExport,
      ),
    );
    this.overlay = h('div', { class: 'modal export', id: 'exportModal' }, this.box);
    this.overlay.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !this.running) this.close();
    });
    parent.appendChild(this.overlay);
  }

  /** The settings, or the running / finished export. */
  private setView(view: 'settings' | 'progress'): void {
    this.view = view;
    const e = this.els;
    e.settings.hidden = view !== 'settings';
    e.panel.hidden = view !== 'progress';
    e.btnExport.hidden = view !== 'settings';
    e.btnBack.hidden = view !== 'progress' || this.running !== null;
    this.box.classList.toggle('narrow', view === 'progress');
    if (view === 'settings') this.refresh();
  }

  get currentView(): 'settings' | 'progress' {
    return this.view;
  }

  get isOpen(): boolean {
    return this.overlay.classList.contains('on');
  }

  open(): void {
    if (!this.opened) {
      this.opened = true;
      this.request = this.deps.initialRequest();
    }
    // the switch is remembered per browser, not per project, so the preference wins on every opening
    this.request.performance.hardware = this.deps.hardwarePreference();
    this.syncInputs();
    if (this.request.fileName === 'lecture' || !this.request.fileName)
      this.request.fileName = sanitizeFileName(this.deps.suggestedName());
    this.els.fileName.value = this.request.fileName;
    if (!this.running) {
      this.els.result.hidden = true;
      replaceChildren(this.els.result);
      this.setView('settings');
    }
    this.overlay.classList.add('on');
    this.refresh();
    void this.deps.refreshServer().then((caps) => {
      if (caps && this.request.destination.kind === 'server' && !this.request.destination.directory)
        this.request.destination.directory = caps.defaultDirectory;
      this.refresh();
    });
    this.els.fileName.focus();
  }

  close(): void {
    if (this.running) return;
    this.overlay.classList.remove('on');
  }

  /** Copies request values into the controls whose value is not rebuilt by refresh(). */
  private syncInputs(): void {
    const e = this.els;
    const r = this.request;
    e.fileName.value = r.fileName;
    const size = resolveResolution(r.resolution);
    e.width.value = String(size.width);
    e.height.value = String(size.height);
    e.customFps.value = String(r.fps);
    e.customKbps.value = String(r.video.quality.kind === 'bitrate' ? r.video.quality.kbps : 5000);
    e.keyInt.value = String(r.video.keyFrameIntervalSec);
    e.audioBitrate.value = String(r.audio.bitrateKbps);
    e.segmentSeconds.value = String(r.streaming.segmentSeconds);
    e.hlsType.value = r.streaming.hlsSegmentType;
    e.ladder.checked = r.streaming.ladder;
    e.compEnabled.checked = r.compression.enabled;
    e.preset.value = r.compression.preset;
    e.tune.checked = r.compression.tune === 'stillimage';
    e.outFps.value = r.compression.outputFps === null ? '' : String(r.compression.outputFps);
    e.outHeight.value = r.compression.height === null ? '' : String(r.compression.height);
    e.maxBitrate.value = r.compression.maxBitrateKbps === null ? '' : String(r.compression.maxBitrateKbps);
    e.hardware.checked = r.performance.hardware;
    e.order.value = r.order;
    for (const mode of PERFORMANCE_MODES) e.modeInputs[mode].checked = r.performance.mode === mode;
  }

  /** One or two lines about the machine on each side of the export. */
  private systemLine(
    server: ServerCapabilities | null,
    browser: BrowserCapabilities,
  ): (HTMLElement | string)[] {
    const parts: (HTMLElement | string)[] = [];
    const system = server?.system ?? null;
    if (system) {
      parts.push(h('b', null, 'Server: '), describeSystem(system), '.');
      if (system.notes.length > 0) parts.push(' ', system.notes.join(' '));
    } else if (server) {
      parts.push(h('b', null, 'Server: '), 'running, machine details unknown.');
    } else {
      parts.push(h('b', null, 'Server: '), 'offline; exports stay in the browser.');
    }
    parts.push(h('br'));
    const hw = hardwareCodecLabels(browser);
    const bench = browser.benchmark?.avc ?? null;
    const measured = bench
      ? `H.264 measured at ${bench.hardwareFps !== null ? `${bench.hardwareFps} fps on the GPU` : 'no GPU'}${bench.softwareFps !== null ? `${bench.hardwareFps !== null ? ' and ' : ''}${bench.softwareFps} fps in software` : ''}`
      : null;
    const threads = browser.hardwareConcurrency !== null ? `${browser.hardwareConcurrency} threads` : null;
    const memory = browser.deviceMemoryGb !== null ? `about ${browser.deviceMemoryGb} GB RAM visible` : null;
    parts.push(
      h('b', null, `${browser.browser ?? 'This browser'}: `),
      browser.videoCodecs.length === 0
        ? 'no WebCodecs; only the real-time fallback works.'
        : `GPU encoding ${hw.length ? `for ${hw.join(', ')}` : 'not available (software encoders only)'}; ${[measured, threads, memory, browser.gpu ? `GPU ${browser.gpu}` : null].filter((p) => p !== null).join(', ')}.`,
    );
    return parts;
  }

  /**
   * What the switch stands for on this machine: the hardware encoders found on each side, what the
   * current position means, and the measured speeds when they argue for the other position.
   */
  private hardwareNote(
    server: ServerCapabilities | null,
    browser: BrowserCapabilities,
    on: boolean,
  ): { text: string; available: boolean } {
    const serverEncoders = server?.system?.ffmpeg?.encoders ?? [];
    const browserCodecs = hardwareCodecLabels(browser);
    const available = serverEncoders.length > 0 || browserCodecs.length > 0;
    if (!available) {
      return {
        available,
        text: `No hardware video encoder was found${browser.videoCodecs.length ? ` in ${browser.browser ?? 'this browser'}` : ''}${server ? ' or in ffmpeg' : ''}, so everything is encoded on the CPU.`,
      };
    }
    const found = [
      browserCodecs.length
        ? `${browserCodecs.join(' and ')} in ${browser.browser ?? 'this browser'}`
        : `none in ${browser.browser ?? 'this browser'}`,
      server
        ? serverEncoders.length
          ? `${serverEncoders.join(', ')} in ffmpeg`
          : server.ffmpeg
            ? 'none in ffmpeg'
            : 'no ffmpeg'
        : 'server offline',
    ];
    const parts = [`Found: ${found.join('; ')}.`];
    parts.push(
      on
        ? 'It does the encoding and leaves the CPU free. Untick to encode on the CPU instead.'
        : 'Off: the browser and ffmpeg encode on the CPU.',
    );
    // measured speeds, when they say the CPU would be quicker on slide video
    const measured: string[] = [];
    const bench = browser.benchmark?.avc;
    if (bench && softwareBeatsHardware(browser) && bench.hardwareFps !== null && bench.softwareFps !== null) {
      measured.push(`${bench.softwareFps} against ${bench.hardwareFps} fps in the browser`);
    }
    const race = server?.system?.ffmpeg?.benchmark ?? null;
    const fastest = server?.system?.ffmpeg?.fastestEncoder ?? null;
    if (race && fastest === 'libx264') {
      const hw = Object.entries(race).find(([e]) => e !== 'libx264');
      if (hw) measured.push(`libx264 ${race.libx264 ?? 0} against ${hw[0]} ${hw[1]} fps in ffmpeg`);
    }
    if (measured.length) {
      parts.push(
        `Measured on this machine, the CPU encoder was quicker on slide video (${measured.join('; ')}), because it skips unchanged blocks; ${on ? 'untick for the quickest export' : 'that is what runs now'}.`,
      );
    }
    return { available, text: parts.join(' ') };
  }

  private renderResources(lines: readonly ResourceLine[]): void {
    const e = this.els;
    const total = totalSeconds(lines);
    const peak = peakMemoryBytes(lines);
    replaceChildren(
      e.resources,
      ...lines.flatMap((l) => [
        h('span', { class: `tag chip-tag ${l.unit}` }, l.unit),
        h('span', { class: 'stage' }, l.stage),
        h(
          'span',
          { class: 'detail' },
          `${l.detail} · ${formatBytes(l.memoryBytes)} RAM${l.seconds !== null ? ` · about ${formatSeconds(l.seconds)}` : ''}`,
        ),
      ]),
      h(
        'div',
        { class: 'total' },
        `Roughly ${total !== null ? formatSeconds(total) : 'unknown time'} in total, ${formatBytes(peak)} of memory at the peak. Figures are estimates.`,
      ),
    );
  }

  private update(mutate: (request: ExportRequest) => void): void {
    mutate(this.request);
    this.deps.onRequestChange(this.request);
    this.refresh();
  }

  private setDestination(kind: 'server' | 'browser'): void {
    this.update((q) => {
      if (kind === 'browser') q.destination = { kind: 'browser' };
      else {
        const dir =
          q.destination.kind === 'server'
            ? q.destination.directory
            : (this.deps.serverCaps()?.defaultDirectory ?? '');
        q.destination = {
          kind: 'server',
          directory: dir,
          overwrite: q.destination.kind === 'server' ? q.destination.overwrite : false,
        };
      }
    });
  }

  private async browse(): Promise<void> {
    const caps = this.deps.serverCaps();
    if (!caps) return;
    const current =
      this.request.destination.kind === 'server' ? this.request.destination.directory : caps.defaultDirectory;
    const chosen = await this.deps.folderPicker.pick(current, caps);
    if (chosen)
      this.update((q) => {
        q.destination = {
          kind: 'server',
          directory: chosen,
          overwrite: q.destination.kind === 'server' ? q.destination.overwrite : false,
        };
      });
  }

  /** Recomputes the plan and syncs every control's options, visibility and enabled state. */
  refresh(): void {
    const e = this.els;
    const r = this.request;
    const server = this.deps.serverCaps();
    const browser = this.deps.browserCaps();
    const ffmpeg = server?.ffmpeg ?? null;
    const tl = this.deps.timeline(r.order);
    e.sumTime.textContent = formatDuration(tl.total);
    e.sumSegs.textContent = String(tl.items.length);
    e.sumSlides.textContent = String(new Set(tl.items.map((i) => i.seg.slide)).size);

    // Destination
    const serverOk = server !== null;
    e.destServer.disabled = !serverOk;
    e.destServer.checked = r.destination.kind === 'server';
    e.destBrowser.checked = r.destination.kind === 'browser';
    e.serverNote.textContent = serverOk
      ? ffmpeg
        ? `(ffmpeg ${ffmpeg.version} found)`
        : '(ffmpeg not found: no HLS, DASH or compression)'
      : '(server not running: npm start)';
    e.folderRow.hidden = r.destination.kind !== 'server';
    e.folderPath.textContent =
      r.destination.kind === 'server' ? r.destination.directory || '(choose a folder)' : '';
    e.overwrite.checked = r.destination.kind === 'server' && r.destination.overwrite;

    // Container
    setOptions(
      e.container,
      CONTAINERS.map((c) => {
        const info = CONTAINER_INFO[c];
        const needsServer = info.needsServer && (r.destination.kind !== 'server' || !ffmpeg);
        return {
          value: c,
          label: `${info.label}${needsServer ? ' (needs server + ffmpeg)' : ''}`,
          disabled: needsServer,
        };
      }),
      r.container,
    );
    if (e.container.value !== r.container) r.container = e.container.value as Container;
    const info = CONTAINER_INFO[r.container];
    e.containerNote.textContent = info.description;
    e.streaming.hidden = !info.isDirectory;
    e.hlsTypeRow.hidden = r.container !== 'hls';

    // Video
    setOptions(
      e.resolution,
      [
        ...RESOLUTION_PRESETS.map((p) => ({ value: p, label: RESOLUTION_SIZES[p].label })),
        { value: 'custom', label: 'Custom size…' },
      ],
      'preset' in r.resolution ? r.resolution.preset : 'custom',
    );
    e.customSize.hidden = 'preset' in r.resolution;
    const fpsIsPreset = (FPS_OPTIONS as readonly number[]).includes(r.fps);
    setOptions(
      e.fps,
      [
        ...FPS_OPTIONS.map((f) => ({ value: String(f), label: `${f} fps` })),
        { value: 'custom', label: 'Custom…' },
      ],
      fpsIsPreset ? String(r.fps) : 'custom',
    );
    e.customFpsWrap.hidden = fpsIsPreset;
    if (!fpsIsPreset) e.customFps.value = String(r.fps);
    setOptions(
      e.quality,
      [
        ...QUALITY_LEVELS.map((l) => ({ value: l, label: QUALITY_LABELS[l] })),
        { value: 'custom', label: 'Custom bitrate…' },
      ],
      r.video.quality.kind === 'level' ? r.video.quality.level : 'custom',
    );
    e.customKbpsWrap.hidden = r.video.quality.kind !== 'bitrate';
    const codecOptions = [
      { value: 'auto', label: 'Automatic (best for the container)' },
      ...VIDEO_CODECS.map((c) => {
        const can = browser.videoCodecs.includes(c);
        return {
          value: c,
          label: `${VIDEO_CODEC_INFO[c].label}${can ? '' : ' (not in this browser)'}`,
          disabled: !can,
        };
      }),
    ];
    setOptions(e.videoCodec, codecOptions, r.video.codec);
    setOptions(
      e.audioCodec,
      [
        { value: 'auto', label: 'Automatic' },
        ...(['aac', 'opus'] as const).map((c) => ({
          value: c,
          label: `${AUDIO_CODEC_INFO[c].label}${browser.audioCodecs.includes(c) ? '' : ' (not in this browser)'}`,
          disabled: !browser.audioCodecs.includes(c),
        })),
      ],
      r.audio.codec,
    );

    // Compression
    const compressionPossible = r.destination.kind === 'server' && ffmpeg !== null;
    e.compression.classList.toggle('disabled', !compressionPossible);
    e.compEnabled.disabled = !compressionPossible;
    e.compEnabled.checked = r.compression.enabled;
    e.compBody.hidden = !r.compression.enabled || !compressionPossible;
    const serverHardware = serverUsesHardware(r.performance);
    setOptions(
      e.compCodec,
      SERVER_VIDEO_CODECS.map((c) => {
        const encoder = pickServerVideoEncoder(server, c, serverHardware);
        const okContainer = CONTAINER_INFO[r.container].video.includes(
          c === 'h264' ? 'avc' : c === 'h265' ? 'hevc' : c,
        );
        return {
          value: c,
          label: `${c.toUpperCase()}${encoder ? ` · ${encoder}` : ' (no encoder on server)'}${okContainer ? '' : ' (not for this container)'}`,
          disabled: !encoder || !okContainer,
        };
      }),
      r.compression.codec,
    );
    if (e.compCodec.value !== r.compression.codec) {
      r.compression.codec = e.compCodec.value as ExportRequest['compression']['codec'];
      r.compression.crf = CRF_RANGES[r.compression.codec].default;
    }
    const range = CRF_RANGES[r.compression.codec];
    e.crf.min = String(range.min);
    e.crf.max = String(range.max);
    e.crf.value = String(r.compression.crf);
    e.crfV.textContent = String(r.compression.crf);
    syncRangeFill(e.crf);
    e.tuneRow.hidden = r.compression.codec !== 'h264';
    e.compNote.textContent = compressionPossible
      ? ''
      : r.destination.kind !== 'server'
        ? 'Choose "a folder on this computer" to compress with ffmpeg.'
        : 'Install ffmpeg on this computer to enable compression.';

    // System line, the hardware switch and the mode
    replaceChildren(e.sysLine, ...this.systemLine(server, browser));
    const hw = this.hardwareNote(server, browser, r.performance.hardware);
    e.hardware.checked = r.performance.hardware;
    e.hardware.disabled = !hw.available;
    e.hardwareNote.textContent = hw.text;
    for (const mode of PERFORMANCE_MODES) e.modeInputs[mode].checked = r.performance.mode === mode;

    // Plan
    this.plan = planExport(r, server, browser);
    const plan = this.plan;
    const est = estimateExport(plan, tl.total);
    const b = plan.browser;
    const stage1 = `Browser encodes ${VIDEO_CODEC_INFO[b.videoCodec].label} + ${AUDIO_CODEC_INFO[b.audioCodec].label}, ${b.width}×${b.height} @ ${b.fps} fps, up to ${(b.videoBitrateKbps / 1000).toFixed(1)} Mbit/s, into ${CONTAINER_INFO[b.container].label}${b.mezzanine ? ' (mezzanine)' : ''}${b.hardware ? ' on the hardware encoder' : ' on the CPU'}.`;
    const p = plan.processing;
    const stage2 = p
      ? p.video.mode === 'copy'
        ? `Server repackages it as ${CONTAINER_INFO[p.container].label} without re-encoding${p.container === 'hls' || p.container === 'dash' ? `, ${p.segmentSeconds} s segments` : ''}.`
        : `Server re-encodes to ${p.video.codec.toUpperCase()} with ${pickServerVideoEncoder(server, p.video.codec, p.video.hardware) ?? 'ffmpeg'}, CRF ${p.video.crf} (${p.video.preset}${p.video.tune ? ', stillimage' : ''}${p.video.fps ? `, ${p.video.fps} fps` : ''}${p.video.height ? `, ${p.video.height}p` : ''})${p.ladder ? ` as an adaptive ladder (${p.ladder.map((x) => x.name).join(', ')})` : ''} and writes ${CONTAINER_INFO[p.container].label}.`
      : plan.destination === 'server'
        ? 'Server stores the file as is.'
        : 'The file is written by the browser.';
    replaceChildren(
      e.planBox,
      h('div', null, '1. ', stage1),
      h('div', null, '2. ', stage2),
      h(
        'div',
        { class: 'est' },
        `${est.frames.toLocaleString()} frames · browser output up to ${formatBytes(est.uploadBytes)}${p?.video.mode === 'encode' ? ` · final roughly ${formatBytes(est.finalBytes)}` : ''}${est.tempBytes ? ` · ${formatBytes(est.tempBytes)} temporary` : ''}`,
      ),
    );
    const slideList = this.deps.slides();
    const resourceInput = {
      plan,
      estimate: est,
      durationSec: tl.total,
      slides: {
        count: slideList.length,
        width: Math.max(1, ...slideList.map((s) => s.width)),
        height: Math.max(1, ...slideList.map((s) => s.height)),
      },
      audioBytes: tl.items.reduce((sum, it) => sum + it.seg.pcm.byteLength, 0),
      server,
      browser,
    };
    const lines = estimateResources(resourceInput);
    this.resourceLines = lines;
    this.renderResources(lines);
    replaceChildren(
      e.warnings,
      ...[...plan.warnings, ...performanceWarnings(resourceInput, lines)].map((w) => h('li', null, w)),
    );
    replaceChildren(e.blockers, ...plan.blockers.map((w) => h('li', null, w)));
    const noWebCodecs = browser.videoCodecs.length === 0;
    e.btnExport.disabled =
      plan.blockers.length > 0 || tl.items.length === 0 || this.running !== null || noWebCodecs;
    e.fallback.hidden = !noWebCodecs;
    if (noWebCodecs && e.fallback.childElementCount === 0) {
      replaceChildren(
        e.fallback,
        h(
          'p',
          null,
          'This browser has no WebCodecs, so the fast export is unavailable. Chrome or Edge can export any format above. Here the lecture can be recorded in real time as WebM instead.',
        ),
        canRecordRealtime()
          ? h('button', { on: { click: () => void this.startRealtime() } }, 'Record in real time (WebM)')
          : null,
      );
    }
  }

  /** A progress record for the panel when there is no runner behind it (cancel, failure, real time). */
  private simpleProgress(
    stage: ExportProgress['stage'],
    percent: number | null,
    message: string,
  ): ExportProgress {
    const last = this.lastProgress;
    return {
      stage,
      percent,
      message,
      detail: '',
      encode: null,
      job: null,
      elapsedSec: last?.elapsedSec ?? 0,
      remainingSec: stage === 'done' ? 0 : null,
      basis: null,
      overall: stage === 'done' && percent === 100 ? 1 : (last?.overall ?? 0),
      steps: (last?.steps ?? []).map((s) =>
        stage === 'done' && percent === 100 ? { ...s, state: 'done' } : s,
      ),
      metrics: last?.metrics ?? {
        encodeFps: null,
        encodeSpeed: null,
        bytesWritten: 0,
        writeRate: null,
        heapBytes: null,
        ffmpeg: null,
      },
    };
  }

  /** Draws one progress record: the hero figure, the bar, the steps and the live facts. */
  private renderProgress(p: ExportProgress, outcome: 'running' | 'done' | 'stopped' = 'running'): void {
    const e = this.els;
    this.lastProgress = p;
    const done = outcome === 'done';
    e.heroEta.textContent = done
      ? 'Done'
      : outcome === 'stopped'
        ? '—'
        : p.remainingSec === null
          ? 'Estimating…'
          : formatEta(p.remainingSec);
    e.heroEta.classList.toggle('small', !done && p.remainingSec === null);
    e.heroBasis.textContent = outcome === 'running' ? basisText(p) : '';
    e.kElapsed.textContent = formatElapsed(p.elapsedSec);
    e.kOverall.textContent = `${Math.round((done ? 1 : p.overall) * 100)} %`;
    e.kWritten.textContent = formatBytes(p.metrics.bytesWritten);
    const indeterminate = outcome === 'running' && p.overall === 0 && p.stage !== 'encoding';
    e.bigBar.classList.toggle('indeterminate', indeterminate);
    e.bigBar.style.width = `${(done ? 1 : p.overall) * 100}%`;
    replaceChildren(
      e.steps,
      ...p.steps.map((s) => {
        const state = done ? 'done' : s.state;
        const mark =
          state === 'done'
            ? icon('check', 16)
            : state === 'active' && outcome === 'running'
              ? h('span', { class: 'spinner' })
              : h('span', { class: 'dot' });
        const right =
          state === 'active' && s.fraction !== null && outcome === 'running'
            ? `${Math.round(s.fraction * 100)} %`
            : state === 'pending'
              ? 'waiting'
              : '';
        const time = done && s.state !== 'done' ? '' : stepTimeLeft({ ...s, state });
        return h(
          'li',
          { class: state, dataset: { step: s.id } },
          h('span', { class: 'mark' }, mark),
          h('span', { class: 'name' }, s.label),
          h('span', { class: 'right' }, [right, time].filter((x) => x).join(' · ')),
          h('span', { class: 'detail' }, s.detail),
        );
      }),
    );
    e.status.textContent = p.message;
    e.status.classList.toggle('error', p.message.startsWith('Export failed'));
    this.renderFacts(p, outcome);
  }

  /** The live figures under the meters: the encoder, ffmpeg, and the disk. */
  private renderFacts(p: ExportProgress, outcome: 'running' | 'done' | 'stopped'): void {
    const e = this.els;
    const m = p.metrics;
    const b = this.plan?.browser;
    const encoder = b
      ? `${VIDEO_CODEC_INFO[b.videoCodec].label.split(' / ')[0] ?? b.videoCodec} on the ${b.hardware ? 'hardware encoder' : 'CPU'}`
      : 'encoder';
    const encodeStep = p.steps.find((s) => s.id === 'encode');
    const encodeParts = [
      m.encodeFps !== null ? `${Math.round(m.encodeFps)} fps` : null,
      m.encodeSpeed !== null ? `${m.encodeSpeed.toFixed(1)}× real time` : null,
      m.heapBytes !== null ? `${formatBytes(m.heapBytes)} heap` : null,
    ].filter((x) => x !== null);
    replaceChildren(
      e.factBrowser,
      h('b', null, 'Browser: '),
      encodeStep?.state === 'active' && outcome === 'running'
        ? `encoding ${encoder}${encodeParts.length ? `, ${encodeParts.join(' · ')}` : ''}`
        : encodeStep?.state === 'done'
          ? `encoded ${encoder}${encodeStep.elapsedSec !== null ? ` in ${formatElapsed(encodeStep.elapsedSec)}` : ''}${m.heapBytes !== null ? ` · ${formatBytes(m.heapBytes)} heap` : ''}`
          : `${encoder}, starting…`,
    );
    const f = m.ffmpeg;
    const processStep = p.steps.find((s) => s.id === 'process');
    const ffmpegParts = f
      ? [
          f.fps !== null && f.fps > 0 ? `${Math.round(f.fps)} fps` : null,
          f.speed !== null ? `${f.speed.toFixed(1)}× real time` : null,
          f.cpuPercent !== null ? `${Math.round(f.cpuPercent)} % of one core` : null,
          f.rssBytes !== null ? `${formatBytes(f.rssBytes)} memory` : null,
          f.outputBytes !== null && f.outputBytes >= FFMPEG_BYTES_SHOWN_FROM
            ? `${formatBytes(f.outputBytes)} written`
            : null,
        ].filter((x) => x !== null)
      : [];
    replaceChildren(
      e.factFfmpeg,
      h('b', null, 'ffmpeg: '),
      !processStep
        ? 'not needed for this export'
        : processStep.state === 'pending'
          ? 'waits for the upload'
          : processStep.state === 'done'
            ? `finished${processStep.elapsedSec !== null ? ` in ${formatElapsed(processStep.elapsedSec)}` : ''}`
            : ffmpegParts.length
              ? ffmpegParts.join(' · ')
              : 'starting…',
    );
    e.factFfmpeg.hidden = !processStep;
    replaceChildren(
      e.factDisk,
      h('b', null, this.request.destination.kind === 'server' ? 'Sent to the server: ' : 'Written: '),
      `${formatBytes(m.bytesWritten)}${m.writeRate !== null && outcome === 'running' && encodeStep?.state === 'active' ? ` · ${formatBytes(m.writeRate)}/s` : ''}`,
    );
  }

  /** The CPU and memory meters from the last load sample. */
  private renderLoad(): void {
    const e = this.els;
    const load = this.load;
    if (!load) {
      e.cpuText.textContent = '…';
      e.memText.textContent = '…';
      e.cpuBar.style.width = '0%';
      e.memBar.style.width = '0%';
      e.loadNote.textContent = this.deps.serverCaps()
        ? this.loadFailed
          ? 'The server did not answer the load check.'
          : ''
        : 'Live CPU and memory figures need the local server (npm start).';
      return;
    }
    const cpu = load.cpu.percent;
    e.cpuText.textContent = cpu === null ? 'measuring…' : `${Math.round(cpu)} % of ${load.cpu.cores} cores`;
    e.cpuBar.style.width = `${cpu ?? 0}%`;
    const total = load.memory.totalBytes;
    const available = load.memory.availableBytes;
    const used = available === null ? null : Math.max(0, total - available);
    const share = used === null ? 0 : used / Math.max(1, total);
    e.memText.textContent =
      used === null ? `${formatGb(total)} total` : `${formatGb(used)} of ${formatGb(total)}`;
    e.memBar.style.width = `${share * 100}%`;
    e.memMeter.classList.toggle('warn', share > 0.85 && share <= 0.95);
    e.memMeter.classList.toggle('hot', share > 0.95);
    e.loadNote.textContent = '';
  }

  private startLoadPolling(): void {
    this.stopLoadPolling();
    this.load = null;
    this.loadFailed = false;
    this.renderLoad();
    if (!this.deps.serverCaps()) return;
    let busy = false;
    const tick = () => {
      if (busy) return;
      busy = true;
      this.deps.api
        .systemLoad()
        .then((load) => {
          this.load = load;
          this.loadFailed = false;
        })
        .catch(() => {
          this.loadFailed = true;
        })
        .finally(() => {
          busy = false;
          this.renderLoad();
        });
    };
    tick();
    this.loadTimer = window.setInterval(tick, 1000);
  }

  private stopLoadPolling(): void {
    if (this.loadTimer !== null) window.clearInterval(this.loadTimer);
    this.loadTimer = null;
  }

  /** What the plan expected each stage to take, for the time left before anything is measured. */
  private estimates(): ExportEstimates {
    const find = (...stages: string[]) =>
      this.resourceLines.find((l) => stages.includes(l.stage))?.seconds ?? null;
    return {
      encodeSec: find('Browser encodes'),
      processSec: find('Server re-encodes', 'Server packages'),
    };
  }

  private async start(): Promise<void> {
    if (this.running || !this.plan) return;
    const plan = this.plan;
    const controller = new AbortController();
    this.running = controller;
    this.deps.onBeforeExport();
    this.deps.onExportingChange(true);
    const e = this.els;
    e.btnExport.disabled = true;
    e.btnClose.disabled = true;
    e.btnCancel.hidden = false;
    e.result.hidden = true;
    replaceChildren(e.result);
    this.lastProgress = null;
    const ext = CONTAINER_INFO[plan.processing?.container ?? plan.browser.container].extension;
    const name = sanitizeFileName(this.request.fileName);
    e.panelTitle.textContent = `Exporting ${name}${ext ? `.${ext}` : ''}`;
    const b = plan.browser;
    e.panelSub.textContent = `${this.request.destination.kind === 'server' ? `to ${this.request.destination.directory}` : 'to a file in this browser'} · ${b.width}×${b.height} @ ${b.fps} fps · ${CONTAINER_INFO[plan.processing?.container ?? b.container].label}`;
    this.setView('progress');
    this.renderProgress(this.simpleProgress('preparing', null, 'Preparing…'));
    this.startLoadPolling();
    try {
      const result = await runExport({
        request: this.request,
        plan,
        timeline: this.deps.timeline(this.request.order),
        slides: this.deps.slides(),
        api: this.deps.serverCaps() ? this.deps.api : null,
        signal: controller.signal,
        estimates: this.estimates(),
        onProgress: (p) => this.renderProgress(p),
      });
      this.showResult(result);
    } catch (error) {
      if (
        error instanceof ExportCancelledError ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) {
        this.renderProgress(this.simpleProgress('done', null, 'Export cancelled.'), 'stopped');
      } else {
        console.error(error);
        this.renderProgress(
          this.simpleProgress('done', null, `Export failed: ${(error as Error).message}`),
          'stopped',
        );
      }
    } finally {
      this.running = null;
      this.stopLoadPolling();
      this.deps.onExportingChange(false);
      e.btnCancel.hidden = true;
      e.btnClose.disabled = false;
      e.btnBack.hidden = false;
      this.refresh();
    }
  }

  private cancel(): void {
    this.running?.abort();
  }

  private showResult(result: ExportResult): void {
    const e = this.els;
    e.result.hidden = false;
    this.renderProgress(this.simpleProgress('done', 100, 'Done'), 'done');
    const took = this.lastProgress ? ` · took ${formatElapsed(this.lastProgress.elapsedSec)}` : '';
    if (result.kind === 'server') {
      const out = result.job.outputs[0];
      this.lastJobId = result.job.id;
      const id = result.job.id;
      replaceChildren(
        e.result,
        h(
          'div',
          null,
          'Saved ',
          h('b', null, out?.path ?? result.job.fileName),
          out ? ` (${formatBytes(out.bytes)})` : '',
          took,
        ),
        h(
          'div',
          { class: 'actions inline' },
          h(
            'button',
            { on: { click: () => void this.deps.api.revealExport(id).catch(() => undefined) } },
            'Show in folder',
          ),
          h(
            'button',
            { class: 'ghost', on: { click: () => this.deps.onOpenLibrary() } },
            'All exported videos',
          ),
        ),
        result.encoder
          ? h(
              'div',
              { class: 'hint' },
              `Browser encoder: ${
                result.encoder.hardwareAcceleration === 'prefer-hardware'
                  ? 'the hardware encoder'
                  : result.encoder.hardwareAcceleration === 'prefer-software'
                    ? 'the CPU'
                    : 'the browser default'
              }, ${result.encoder.latencyMode} mode.`,
            )
          : null,
        result.job.command
          ? h(
              'details',
              null,
              h('summary', null, 'ffmpeg command'),
              h('code', { class: 'cmd' }, result.job.command),
            )
          : null,
      );
    } else if (result.kind === 'file') {
      replaceChildren(
        e.result,
        h('div', null, 'Saved ', h('b', null, result.name), ` (${formatBytes(result.bytes)})`, took),
      );
    } else {
      const size = formatBytes(result.blob.size);
      downloadBlob(result.blob, result.name);
      replaceChildren(
        e.result,
        h(
          'div',
          null,
          'Ready: ',
          h(
            'button',
            { on: { click: () => downloadBlob(result.blob, result.name) } },
            `Download ${result.name}`,
          ),
          ` (${size})`,
          took,
        ),
      );
    }
  }

  private async startRealtime(): Promise<void> {
    if (this.running || !this.plan) return;
    const controller = new AbortController();
    this.running = controller;
    this.deps.onBeforeExport();
    this.deps.onExportingChange(true);
    const e = this.els;
    e.btnClose.disabled = true;
    e.btnCancel.hidden = false;
    e.result.hidden = true;
    replaceChildren(e.result);
    this.lastProgress = null;
    e.panelTitle.textContent = `Recording ${sanitizeFileName(this.request.fileName)}.webm in real time`;
    e.panelSub.textContent = 'This browser has no WebCodecs, so the lecture plays once while it is recorded.';
    this.setView('progress');
    this.startLoadPolling();
    const startedAt = performance.now();
    try {
      const b = this.plan.browser;
      const blob = await recordRealtime({
        timeline: this.deps.timeline(this.request.order),
        slides: this.deps.slides(),
        width: b.width,
        height: b.height,
        fps: b.fps,
        videoBitrateKbps: b.videoBitrateKbps,
        signal: controller.signal,
        onProgress: (f, now, total) =>
          this.renderProgress({
            ...this.simpleProgress(
              'encoding',
              Math.round(f * 100),
              `Recording in real time… ${formatDuration(now)} / ${formatDuration(total)}`,
            ),
            elapsedSec: (performance.now() - startedAt) / 1000,
            remainingSec: Math.max(0, total - now),
            basis: 'measured',
            overall: f,
          }),
      });
      this.showResult({
        kind: 'blob',
        name: `${sanitizeFileName(this.request.fileName)}.webm`,
        blob,
        encoder: null,
      });
    } catch (error) {
      this.renderProgress(
        this.simpleProgress(
          'done',
          null,
          error instanceof ExportCancelledError
            ? 'Export cancelled.'
            : `Export failed: ${(error as Error).message}`,
        ),
        'stopped',
      );
    } finally {
      this.running = null;
      this.stopLoadPolling();
      this.deps.onExportingChange(false);
      e.btnCancel.hidden = true;
      e.btnClose.disabled = false;
      e.btnBack.hidden = false;
    }
  }

  /** The last progress record drawn, for the end-to-end tests. */
  get progress(): ExportProgress | null {
    return this.lastProgress;
  }

  get currentRequest(): ExportRequest {
    return this.request;
  }

  get lastJob(): string | null {
    return this.lastJobId;
  }
}
