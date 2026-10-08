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
  hardwareCodecLabels,
  peakMemoryBytes,
  performanceWarnings,
  pickServerVideoEncoder,
  planExport,
  resolveResolution,
  sanitizeFileName,
  totalSeconds,
  type BrowserCapabilities,
  type Container,
  type ExportPlan,
  type ExportRequest,
  type PerformanceMode,
  type ResourceLine,
  type ServerCapabilities,
} from '@one-take/shared';

import { type ApiClient } from '../api/client.js';
import { type Slide } from '../app/types.js';
import { type PhraseOrder, type Timeline } from '../core/timeline.js';
import { canRecordRealtime, recordRealtime } from '../export/fallback.js';
import {
  downloadBlob,
  ExportCancelledError,
  runExport,
  type ExportProgress,
  type ExportResult,
} from '../export/runner.js';

import { clear, h, replaceChildren } from './dom.js';
import { type FolderPicker } from './folder-picker.js';

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
  private request: ExportRequest;
  private opened = false;
  private plan: ExportPlan | null = null;
  private running: AbortController | null = null;
  private lastJobId: string | null = null;
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
    hardware: HTMLInputElement;
    compNote: HTMLElement;
    order: HTMLSelectElement;
    sysLine: HTMLElement;
    modes: HTMLElement;
    modeInputs: Record<PerformanceMode, HTMLInputElement>;
    resources: HTMLElement;
    planBox: HTMLElement;
    warnings: HTMLElement;
    blockers: HTMLElement;
    prog: HTMLElement;
    bar: HTMLElement;
    progLabel: HTMLElement;
    progPct: HTMLElement;
    progDetail: HTMLElement;
    result: HTMLElement;
    btnExport: HTMLButtonElement;
    btnCancel: HTMLButtonElement;
    btnClose: HTMLButtonElement;
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
    e.folderRow = h(
      'div',
      { class: 'folderrow' },
      e.folderPath,
      h('button', { on: { click: () => void this.browse() } }, 'Browse…'),
      h('label', { class: 'inline' }, e.overwrite, ' replace an existing file of the same name'),
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
        h(
          'label',
          { class: 'inline' },
          e.ladder,
          ' several renditions (1080p/720p/480p/360p) so the player can switch quality',
        ),
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
    e.customSize = h('span', { class: 'inline' }, e.width, ' × ', e.height, ' px');

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
    e.customFpsWrap = h('span', { class: 'inline' }, e.customFps, ' fps');

    e.quality = h('select');
    e.quality.onchange = () =>
      this.update((q) => {
        const v = e.quality.value;
        q.video.quality =
          v === 'custom'
            ? { kind: 'bitrate', kbps: Number(e.customKbps.value) || 5000 }
            : { kind: 'level', level: v as (typeof QUALITY_LEVELS)[number] };
      });
    e.customKbpsWrap = h('span', { class: 'inline' });
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
    e.customKbpsWrap.append(e.customKbps, ' kbit/s');

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
      h('label', { class: 'inline' }, e.tune, ' optimise for still images (slides)'),
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
    e.hardware = h('input', { type: 'checkbox', checked: r.compression.hardware });
    e.hardware.onchange = () =>
      this.update((q) => {
        q.compression.hardware = e.hardware.checked;
      });
    e.compNote = h('div', { class: 'hint' });
    e.compBody = h(
      'div',
      { class: 'sub' },
      row('Codec', e.compCodec),
      row(
        'Quality (CRF)',
        h('span', { class: 'inline' }, e.crf, e.crfV),
        'Lower is better quality and a bigger file. 18 is near lossless, 23 is the x264 default, 28 is small.',
      ),
      row('Speed preset', e.preset, 'Slower presets squeeze out a smaller file for the same quality.'),
      e.tuneRow,
      row(
        'Output frame rate',
        h('span', { class: 'inline' }, e.outFps, ' fps'),
        'Leave empty to keep the recorded rate.',
      ),
      row(
        'Scale to height',
        h('span', { class: 'inline' }, e.outHeight, ' px'),
        'Leave empty to keep the recorded size.',
      ),
      row(
        'Max bitrate',
        h('span', { class: 'inline' }, e.maxBitrate, ' kbit/s'),
        'Caps peaks for streaming; leave empty for pure CRF.',
      ),
      row(
        'Hardware encoder',
        h('label', { class: 'inline' }, e.hardware, ' prefer the GPU encoder when the server has one'),
        'Faster, but larger files than x264/x265 at the same quality.',
      ),
      e.compNote,
    );
    e.compression = section(
      'Compression (server, ffmpeg)',
      row(
        'Compress',
        h('label', { class: 'inline' }, e.compEnabled, ' re-encode on the server with a CRF quality target'),
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

    // System check and performance mode.
    e.sysLine = h('div', { class: 'sys', id: 'sysLine' });
    e.modeInputs = {} as Record<PerformanceMode, HTMLInputElement>;
    e.modes = h(
      'div',
      { class: 'modes', id: 'perfModes' },
      ...PERFORMANCE_MODES.map((mode) => {
        const input = h('input', { type: 'radio', name: 'perfMode', value: mode });
        input.onchange = () => {
          if (!input.checked) return;
          this.update((q) => {
            applyPerformanceMode(q, mode, this.deps.serverCaps());
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

    e.bar = h('i');
    e.progLabel = h('span', null, 'Preparing…');
    e.progPct = h('span', null, '0%');
    e.progDetail = h('div', { class: 'hint' });
    e.prog = h(
      'div',
      { id: 'prog' },
      h('div', { id: 'bar' }, e.bar),
      h('div', { id: 'progText' }, e.progLabel, e.progPct),
      e.progDetail,
    );
    e.result = h('div', { id: 'result' });
    e.fallback = h('div', { class: 'fallback', hidden: true });

    e.btnExport = h('button', { class: 'primary', on: { click: () => void this.start() } }, 'Export');
    e.btnCancel = h(
      'button',
      { class: 'danger', hidden: true, on: { click: () => this.cancel() } },
      'Cancel export',
    );
    e.btnClose = h('button', { on: { click: () => this.close() } }, 'Close');

    this.els = e;
    this.overlay = h(
      'div',
      { class: 'modal export', id: 'exportModal' },
      h(
        'div',
        { class: 'box wide' },
        h('h3', null, 'Export video'),
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
                  { class: 'stack' },
                  h('label', { class: 'inline' }, e.destServer, ' a folder on this computer ', e.serverNote),
                  h('label', { class: 'inline' }, e.destBrowser, ' the browser (save dialog or download)'),
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
                h('span', { class: 'inline' }, e.fps, e.customFpsWrap),
                'Slides are still images: 10–15 fps looks identical to 30 and exports faster.',
              ),
              row(
                'Quality',
                h('div', { class: 'stack' }, e.quality, e.customKbpsWrap),
                'An upper bound; still slides compress far below it.',
              ),
              row('Video codec', e.videoCodec),
              row(
                'Key frame every',
                h('span', { class: 'inline' }, e.keyInt, ' s'),
                'Smaller values seek faster and make bigger files.',
              ),
            ),
            section('Audio', row('Codec', e.audioCodec), row('Bitrate', e.audioBitrate)),
          ),
          h(
            'div',
            { class: 'col' },
            section('This computer', e.sysLine, e.modes),
            e.compression,
            section('Order', row('Phrases', e.order)),
            section('Plan', e.planBox, e.resources, e.warnings, e.blockers),
          ),
        ),
        e.fallback,
        e.prog,
        e.result,
        h('div', { class: 'actions' }, e.btnCancel, h('div', { class: 'spacer' }), e.btnClose, e.btnExport),
      ),
    );
    this.overlay.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !this.running) this.close();
    });
    parent.appendChild(this.overlay);
  }

  get isOpen(): boolean {
    return this.overlay.classList.contains('on');
  }

  open(): void {
    if (!this.opened) {
      this.opened = true;
      this.request = this.deps.initialRequest();
      this.syncInputs();
    }
    if (this.request.fileName === 'lecture' || !this.request.fileName)
      this.request.fileName = sanitizeFileName(this.deps.suggestedName());
    this.els.fileName.value = this.request.fileName;
    this.els.prog.classList.remove('on');
    this.els.result.classList.remove('on');
    replaceChildren(this.els.result);
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
    e.hardware.checked = r.compression.hardware;
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

  private renderResources(lines: readonly ResourceLine[]): void {
    const e = this.els;
    const total = totalSeconds(lines);
    const peak = peakMemoryBytes(lines);
    replaceChildren(
      e.resources,
      ...lines.flatMap((l) => [
        h('span', { class: `tag ${l.unit}` }, l.unit),
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
    setOptions(
      e.compCodec,
      SERVER_VIDEO_CODECS.map((c) => {
        const encoder = pickServerVideoEncoder(server, c, r.compression.hardware);
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
    e.tuneRow.hidden = r.compression.codec !== 'h264';
    e.compNote.textContent = compressionPossible
      ? ''
      : r.destination.kind !== 'server'
        ? 'Choose "a folder on this computer" to compress with ffmpeg.'
        : 'Install ffmpeg on this computer to enable compression.';

    // System line and mode
    replaceChildren(e.sysLine, ...this.systemLine(server, browser));
    for (const mode of PERFORMANCE_MODES) e.modeInputs[mode].checked = r.performance.mode === mode;

    // Plan
    this.plan = planExport(r, server, browser);
    const plan = this.plan;
    const est = estimateExport(plan, tl.total);
    const b = plan.browser;
    const stage1 = `Browser encodes ${VIDEO_CODEC_INFO[b.videoCodec].label} + ${AUDIO_CODEC_INFO[b.audioCodec].label}, ${b.width}×${b.height} @ ${b.fps} fps, up to ${(b.videoBitrateKbps / 1000).toFixed(1)} Mbit/s, into ${CONTAINER_INFO[b.container].label}${b.mezzanine ? ' (mezzanine)' : ''}${b.hardware ? ' on the GPU' : ' on the CPU'}.`;
    const p = plan.processing;
    const stage2 = p
      ? p.video.mode === 'copy'
        ? `Server repackages it as ${CONTAINER_INFO[p.container].label} without re-encoding${p.container === 'hls' || p.container === 'dash' ? `, ${p.segmentSeconds} s segments` : ''}.`
        : `Server re-encodes to ${p.video.codec.toUpperCase()} CRF ${p.video.crf} (${p.video.preset}${p.video.tune ? ', stillimage' : ''}${p.video.fps ? `, ${p.video.fps} fps` : ''}${p.video.height ? `, ${p.video.height}p` : ''})${p.ladder ? ` as an adaptive ladder (${p.ladder.map((x) => x.name).join(', ')})` : ''} and writes ${CONTAINER_INFO[p.container].label}.`
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

  private setProgress(p: ExportProgress): void {
    const e = this.els;
    e.prog.classList.add('on');
    e.progLabel.textContent = p.message;
    e.progPct.textContent = p.percent === null ? '' : `${p.percent}%`;
    e.bar.style.width = `${p.percent ?? 0}%`;
    e.bar.classList.toggle('indeterminate', p.percent === null);
    e.progDetail.textContent = p.detail;
  }

  private async start(): Promise<void> {
    if (this.running || !this.plan) return;
    const plan = this.plan;
    const controller = new AbortController();
    this.running = controller;
    this.deps.onBeforeExport();
    this.deps.onExportingChange(true);
    this.els.btnExport.disabled = true;
    this.els.btnClose.disabled = true;
    this.els.btnCancel.hidden = false;
    this.els.result.classList.remove('on');
    replaceChildren(this.els.result);
    this.setProgress({
      stage: 'preparing',
      percent: 0,
      message: 'Preparing…',
      detail: '',
      encode: null,
      job: null,
    });
    try {
      const result = await runExport({
        request: this.request,
        plan,
        timeline: this.deps.timeline(this.request.order),
        slides: this.deps.slides(),
        api: this.deps.serverCaps() ? this.deps.api : null,
        signal: controller.signal,
        onProgress: (p) => this.setProgress(p),
      });
      this.showResult(result);
    } catch (error) {
      if (
        error instanceof ExportCancelledError ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) {
        this.setProgress({
          stage: 'done',
          percent: null,
          message: 'Export cancelled.',
          detail: '',
          encode: null,
          job: null,
        });
      } else {
        console.error(error);
        this.setProgress({
          stage: 'done',
          percent: null,
          message: `Export failed: ${(error as Error).message}`,
          detail: '',
          encode: null,
          job: null,
        });
      }
    } finally {
      this.running = null;
      this.deps.onExportingChange(false);
      this.els.btnCancel.hidden = true;
      this.els.btnClose.disabled = false;
      this.refresh();
    }
  }

  private cancel(): void {
    this.running?.abort();
  }

  private showResult(result: ExportResult): void {
    const e = this.els;
    e.result.classList.add('on');
    this.setProgress({ stage: 'done', percent: 100, message: 'Done', detail: '', encode: null, job: null });
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
        ),
        h(
          'div',
          { class: 'actions inline' },
          h(
            'button',
            { on: { click: () => void this.deps.api.revealExport(id).catch(() => undefined) } },
            'Show in folder',
          ),
        ),
        result.encoder
          ? h(
              'div',
              { class: 'hint' },
              `Browser encoder: ${result.encoder.hardwareAcceleration === 'prefer-hardware' ? 'GPU' : 'browser default'}, ${result.encoder.latencyMode} mode.`,
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
        h('div', null, 'Saved ', h('b', null, result.name), ` (${formatBytes(result.bytes)})`),
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
    this.els.btnClose.disabled = true;
    this.els.btnCancel.hidden = false;
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
          this.setProgress({
            stage: 'encoding',
            percent: Math.round(f * 100),
            message: `Recording in real time… ${formatDuration(now)} / ${formatDuration(total)}`,
            detail: '',
            encode: null,
            job: null,
          }),
      });
      this.showResult({
        kind: 'blob',
        name: `${sanitizeFileName(this.request.fileName)}.webm`,
        blob,
        encoder: null,
      });
    } catch (error) {
      this.setProgress({
        stage: 'done',
        percent: null,
        message:
          error instanceof ExportCancelledError
            ? 'Export cancelled.'
            : `Export failed: ${(error as Error).message}`,
        detail: '',
        encode: null,
        job: null,
      });
    } finally {
      this.running = null;
      this.deps.onExportingChange(false);
      this.els.btnCancel.hidden = true;
      this.els.btnClose.disabled = false;
    }
  }

  get currentRequest(): ExportRequest {
    return this.request;
  }

  get lastJob(): string | null {
    return this.lastJobId;
  }
}
