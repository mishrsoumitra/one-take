/** The controller: wires microphone, detector, slides, persistence, preview and export to the views. */
import {
  defaultExportRequest,
  planExport,
  stripExtension,
  type BrowserCapabilities,
  type ExportRequest,
  type ServerCapabilities,
} from '@one-take/shared';

import { ApiClient } from '../api/client.js';
import { MicCapture } from '../audio/mic.js';
import { PreviewPlayer } from '../audio/preview.js';
import { fmtSec, fmtTime } from '../core/format.js';
import { floatBlocksToInt16 } from '../core/pcm.js';
import {
  buildTimeline,
  durationPerSlide,
  segmentDuration,
  totalDuration,
  type PhraseOrder,
  type Segment,
  type Timeline,
} from '../core/timeline.js';
import { VoiceActivityDetector } from '../core/vad.js';
import { detectBrowserCapabilities } from '../export/capabilities.js';
import { runExport } from '../export/runner.js';
import { loadSlides, releaseSlides, slideSourceFromFiles } from '../slides/loader.js';
import { ProjectStore } from '../storage/db.js';
import { ExportDialog } from '../ui/export-dialog.js';
import { Filmstrip } from '../ui/filmstrip.js';
import { FolderPicker } from '../ui/folder-picker.js';
import { installKeyboard } from '../ui/keyboard.js';
import { buildLayout, type LayoutRefs } from '../ui/layout.js';
import { LevelMeter } from '../ui/meter.js';
import { TimelineList } from '../ui/timeline-list.js';
import { Toast } from '../ui/toast.js';

import { Store } from './store.js';
import { DEFAULT_SETTINGS, type ProjectMeta, type SlideSource } from './types.js';

const BLOCK_MS = 10;
const CONFIRM_WINDOW_MS = 5000;

export class App {
  readonly store = new Store();
  readonly api = new ApiClient();
  private readonly db = new ProjectStore();
  private readonly mic = new MicCapture();
  private readonly preview: PreviewPlayer;
  private readonly refs: LayoutRefs;
  private readonly toast: Toast;
  private readonly meter: LevelMeter;
  private readonly film: Filmstrip;
  private readonly list: TimelineList;
  private readonly exportDialog: ExportDialog;
  private readonly folderPicker: FolderPicker;
  private vad: VoiceActivityDetector | null = null;
  private sampleRate = 48000;
  private segmentCounter = 0;
  private metaTimer = 0;
  private meterRaf = 0;
  private replaceArmedAt = 0;
  private newArmedAt = 0;
  private continuationPrevId: string | null = null;
  private serverCaps: ServerCapabilities | null = null;
  private browserCaps: BrowserCapabilities = { videoCodecs: [], audioCodecs: [], fileSystemAccess: false };
  private exportRequest: ExportRequest | null = null;

  constructor(root: HTMLElement) {
    this.refs = buildLayout(root);
    this.toast = new Toast(document.body);
    this.meter = new LevelMeter(this.refs.meter, this.refs.meterNote);
    this.film = new Filmstrip(this.refs.film, this.refs.filmInfo, (i) => this.goTo(i));
    this.list = new TimelineList(this.refs.segs, this.refs.segInfo, {
      onPlay: (i) => void this.startPreview(i),
      onDelete: (i) => this.deleteSegment(i),
      onSelect: (i) => {
        const seg = this.store.state.segments[i];
        if (seg && !this.store.state.previewing) this.goTo(seg.slide);
      },
      onMove: (from, to) => this.moveSegment(from, to),
    });
    this.preview = new PreviewPlayer({
      onTick: (index, now, total) => this.onPreviewTick(index, now, total),
      onEnd: () => this.stopPreview(),
    });
    this.folderPicker = new FolderPicker(document.body, this.api);
    this.exportDialog = new ExportDialog(document.body, {
      api: this.api,
      folderPicker: this.folderPicker,
      browserCaps: () => this.browserCaps,
      serverCaps: () => this.serverCaps,
      refreshServer: () => this.refreshServer(),
      timeline: (order) => this.timeline(order),
      slides: () => this.store.state.slides,
      suggestedName: () => stripExtension(this.store.state.slideSource?.files[0]?.name ?? '') || 'lecture',
      initialRequest: () => this.exportRequest ?? defaultExportRequest(null),
      onRequestChange: (request) => {
        this.exportRequest = request;
        this.saveMeta();
      },
      onExportingChange: (exporting) => {
        this.store.state.exporting = exporting;
        if (this.vad) this.vad.gate = this.gateOpen();
        this.updateButtons();
      },
      onBeforeExport: () => {
        if (this.store.state.previewing) this.stopPreview();
        this.vad?.end();
      },
    });
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  async init(): Promise<void> {
    this.wire();
    this.syncSliders();
    this.drawMeter();
    void this.listMics();
    if (!('mediaDevices' in navigator)) {
      this.toast.show('This browser cannot use the microphone here. Open the app in Chrome.');
    }
    void detectBrowserCapabilities().then((caps) => {
      this.browserCaps = caps;
    });
    void this.refreshServer();
    const [meta, files, segments] = await Promise.all([
      this.db.getMeta(),
      this.db.getSlideSource(),
      this.db.getSegments(),
    ]);
    if (meta?.exportRequest) this.exportRequest = meta.exportRequest;
    if (files || segments.length > 0) {
      const dur = segments.reduce((a, s) => a + s.pcm.length / s.sampleRate, 0);
      this.refs.restoreText.textContent = `Previous session found: ${segments.length} phrases, ${fmtTime(dur)} recorded.`;
      this.refs.restore.classList.add('on');
      this.refs.btnRestore.onclick = () => {
        this.refs.restore.classList.remove('on');
        void this.restore(meta, files, segments);
      };
      this.refs.btnDiscard.onclick = () => {
        this.refs.restore.classList.remove('on');
        void this.db.clear();
      };
    }
  }

  async refreshServer(): Promise<ServerCapabilities | null> {
    try {
      this.serverCaps = await this.api.capabilities();
    } catch {
      this.serverCaps = null;
    }
    const pill = this.refs.serverPill;
    pill.classList.toggle('ok', this.serverCaps !== null);
    pill.classList.toggle('warn', this.serverCaps !== null && this.serverCaps.ffmpeg === null);
    this.refs.serverText.textContent = this.serverCaps
      ? this.serverCaps.ffmpeg
        ? 'Server + ffmpeg'
        : 'Server (no ffmpeg)'
      : 'Server offline';
    pill.title = this.serverCaps
      ? `Saves to ${this.serverCaps.defaultDirectory}${this.serverCaps.ffmpeg ? `\nffmpeg ${this.serverCaps.ffmpeg.version} at ${this.serverCaps.ffmpeg.path}` : '\nInstall ffmpeg for HLS, DASH and compression'}`
      : 'Start the local server with "npm start" to save into any folder, or export in the browser.';
    if (this.serverCaps) {
      if (this.exportRequest === null)
        this.exportRequest = defaultExportRequest(this.serverCaps.defaultDirectory);
      else if (
        this.exportRequest.destination.kind === 'server' &&
        !this.exportRequest.destination.directory
      ) {
        this.exportRequest.destination.directory = this.serverCaps.defaultDirectory;
      }
    }
    return this.serverCaps;
  }

  private wire(): void {
    const r = this.refs;
    r.btnLoad.onclick = () => r.fileInput.click();
    r.fileInput.onchange = () => {
      void this.filesChosen(r.fileInput.files ?? []);
      r.fileInput.value = '';
    };
    r.stage.addEventListener('dragover', (e) => {
      e.preventDefault();
      r.drop.classList.add('over');
    });
    r.stage.addEventListener('dragleave', () => r.drop.classList.remove('over'));
    r.stage.addEventListener('drop', (e) => {
      e.preventDefault();
      r.drop.classList.remove('over');
      if (e.dataTransfer?.files.length) void this.filesChosen(e.dataTransfer.files);
    });
    r.btnArm.onclick = () => (this.store.state.armed ? this.stopMic() : void this.startMic());
    r.btnMute.onclick = () => this.toggleMute();
    r.navPrev.onclick = () => this.goTo(this.store.state.current - 1);
    r.navNext.onclick = () => this.goTo(this.store.state.current + 1);
    r.btnPreview.onclick = () =>
      this.store.state.previewing ? this.stopPreview() : void this.startPreview(0);
    r.btnStopPreview.onclick = () => this.stopPreview();
    r.btnExport.onclick = () => this.openExport();
    r.btnNew.onclick = () => void this.newProject();
    r.micSelect.onchange = () => {
      if (this.store.state.armed) {
        this.stopMic();
        void this.startMic();
      }
    };
    r.thr.oninput = () => {
      this.store.settings.threshold = Number(r.thr.value);
      this.syncSliders();
      this.saveMeta();
      this.drawMeter();
    };
    r.gap.oninput = () => {
      this.store.settings.gapMs = Number(r.gap.value);
      this.syncSliders();
      this.saveMeta();
    };
    r.hang.oninput = () => {
      this.store.settings.hangoverMs = Number(r.hang.value);
      this.syncSliders();
      this.saveMeta();
    };
    window.addEventListener('resize', () => this.drawMeter());
    if ('mediaDevices' in navigator)
      navigator.mediaDevices.addEventListener('devicechange', () => void this.listMics());
    installKeyboard(
      {
        next: () => this.goTo(this.store.state.current + 1),
        prev: () => this.goTo(this.store.state.current - 1),
        first: () => this.goTo(0),
        last: () => this.goTo(this.store.state.slides.length - 1),
        deleteLast: () => this.deleteLast(),
        undo: () => this.undoDelete(),
        toggleMute: () => this.toggleMute(),
        toggleMic: () => (this.store.state.armed ? this.stopMic() : void this.startMic()),
        escape: () => {
          if (this.store.state.previewing) this.stopPreview();
        },
      },
      () => this.exportDialog.isOpen || this.folderPicker.isOpen,
    );
    window.addEventListener('beforeunload', (e) => {
      if (this.store.state.armed || this.store.state.exporting) {
        e.preventDefault();
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Slides                                                              */
  /* ------------------------------------------------------------------ */

  async filesChosen(fileList: Iterable<File>): Promise<void> {
    const source = slideSourceFromFiles(fileList);
    if (!source) {
      this.toast.show('Please choose a PDF or image files');
      return;
    }
    if (this.store.state.segments.length > 0 && !this.confirmTwice('replace')) return;
    await this.loadSlideSource(source);
    await this.db.putSlideSource(source);
    this.saveMeta();
  }

  async loadSlideSource(source: SlideSource): Promise<void> {
    this.showLoading('Rendering slides…');
    try {
      const slides = await loadSlides(source, (i, n) => {
        this.refs.loadingText.textContent = `Rendering slide ${i} of ${n}…`;
      });
      releaseSlides(this.store.state.slides);
      this.store.state.slides = slides;
      this.store.state.slideSource = source;
      this.film.render(slides);
      this.showSlide(Math.min(this.store.state.current, slides.length - 1));
      this.refs.empty.style.display = 'none';
      this.refs.slideImg.style.display = 'block';
      this.refs.btnArm.disabled = false;
      this.list.render(this.store.state.segments, slides, false);
      this.updateButtons();
    } catch (error) {
      console.error(error);
      this.toast.show(`Could not load slides: ${(error as Error).message}`);
    } finally {
      this.hideLoading();
    }
  }

  private confirmTwice(kind: 'replace' | 'new'): boolean {
    const now = Date.now();
    if (kind === 'replace') {
      if (now - this.replaceArmedAt < CONFIRM_WINDOW_MS) return true;
      this.replaceArmedAt = now;
      this.toast.show(
        'You already have recordings. Phrase numbers stay tied to slide numbers. Load again to confirm.',
      );
      return false;
    }
    if (now - this.newArmedAt < CONFIRM_WINDOW_MS) {
      this.newArmedAt = 0;
      return true;
    }
    this.newArmedAt = now;
    this.toast.show('This deletes all recordings and slides. Click New again to confirm.');
    return false;
  }

  showSlide(index: number): void {
    const s = this.store.state;
    if (s.slides.length === 0) return;
    s.current = Math.max(0, Math.min(s.slides.length - 1, index));
    const slide = s.slides[s.current];
    if (slide) this.refs.slideImg.src = slide.url;
    this.refs.slideNo.textContent = `${s.current + 1} / ${s.slides.length}`;
    this.updateSlideStats();
  }

  goTo(index: number): void {
    const s = this.store.state;
    if (s.previewing) return;
    if (index === s.current || index < 0 || index >= s.slides.length) return;
    if (s.speaking && this.vad) {
      const blocks = this.vad.split();
      if (blocks) {
        const seg = this.addSegment(
          blocks,
          s.current,
          this.continuationPrevId !== null,
          this.continuationPrevId,
          true,
        );
        this.continuationPrevId = seg.id;
      }
    }
    this.showSlide(index);
    this.saveMeta();
  }

  private updateSlideStats(): void {
    const s = this.store.state;
    const per = durationPerSlide(s.segments, s.slides.length);
    this.film.update(s.current, per);
    const here = per[s.current] ?? 0;
    this.refs.slideTime.textContent = here > 0 ? `${fmtSec(here)} recorded on this slide` : '';
    this.refs.totalTime.textContent = fmtTime(totalDuration(s.segments));
    this.refs.segCount.textContent = String(s.segments.length);
  }

  private updateButtons(): void {
    const s = this.store.state;
    const has = s.segments.length > 0;
    this.refs.btnPreview.disabled = !has || s.exporting;
    this.refs.btnExport.disabled = !has || s.exporting;
    this.refs.btnMute.disabled = !s.armed;
  }

  /* ------------------------------------------------------------------ */
  /* Microphone                                                          */
  /* ------------------------------------------------------------------ */

  private async listMics(): Promise<void> {
    const devices = await MicCapture.listDevices();
    const sel = this.refs.micSelect;
    const current = sel.value;
    while (sel.options.length > 1) sel.remove(1);
    for (const d of devices) {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || 'Microphone';
      sel.appendChild(o);
    }
    sel.value = current;
  }

  private gateOpen(): boolean {
    const s = this.store.state;
    return s.armed && !s.muted && !s.previewing && !s.exporting;
  }

  async startMic(): Promise<void> {
    const s = this.store.state;
    if (s.slides.length === 0) {
      this.toast.show('Load your slides first');
      return;
    }
    const vad = new VoiceActivityDetector(BLOCK_MS, this.store.settings, {
      onSpeechStart: () => {
        this.store.state.speaking = true;
        this.continuationPrevId = null;
        this.refs.capFlagText.textContent = 'RECORDING';
        this.updateStatus();
      },
      onSpeechEnd: (phrase) => {
        this.store.state.speaking = false;
        if (phrase)
          this.addSegment(
            phrase.blocks,
            this.store.state.current,
            phrase.continuation,
            phrase.continuation ? this.continuationPrevId : null,
            true,
          );
        this.continuationPrevId = null;
        this.updateStatus();
      },
    });
    try {
      const info = await this.mic.start({
        deviceId: this.refs.micSelect.value || undefined,
        blockMs: BLOCK_MS,
        onBlock: (block) => this.onBlock(block),
      });
      this.sampleRate = info.sampleRate;
    } catch (error) {
      this.toast.show(`Microphone not available: ${(error as Error).message}`);
      return;
    }
    void this.listMics();
    this.vad = vad;
    s.armed = true;
    s.muted = false;
    s.speaking = false;
    vad.gate = this.gateOpen();
    this.updateStatus();
    this.updateButtons();
    this.meterLoop();
    this.toast.show('Listening. Speak whenever you are ready; silence is skipped automatically.');
  }

  stopMic(): void {
    this.vad?.end();
    this.mic.stop();
    this.vad = null;
    const s = this.store.state;
    s.armed = false;
    s.muted = false;
    s.speaking = false;
    this.updateStatus();
    this.updateButtons();
    this.drawMeter();
  }

  toggleMute(): void {
    const s = this.store.state;
    if (!s.armed) return;
    this.vad?.end();
    s.muted = !s.muted;
    if (this.vad) this.vad.gate = this.gateOpen();
    this.updateStatus();
  }

  private onBlock(block: Float32Array): void {
    const vad = this.vad;
    if (!vad) return;
    vad.process(block);
    if (vad.speaking && Math.round(vad.currentMs / BLOCK_MS) % 20 === 0) {
      this.refs.capFlagText.textContent = `RECORDING ${fmtSec(vad.currentMs / 1000)}`;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Segments                                                            */
  /* ------------------------------------------------------------------ */

  private addSegment(
    blocks: Float32Array[],
    slide: number,
    joined: boolean,
    prevId: string | null,
    scroll: boolean,
  ): Segment {
    const seg: Segment = {
      id: `${Date.now()}-${++this.segmentCounter}`,
      slide,
      sampleRate: this.sampleRate,
      pcm: floatBlocksToInt16(blocks),
      joined,
      prevId,
      createdAt: Date.now(),
    };
    this.store.state.segments.push(seg);
    void this.db.putSegment(seg);
    this.saveMeta();
    this.list.render(this.store.state.segments, this.store.state.slides, scroll);
    this.updateSlideStats();
    this.updateButtons();
    return seg;
  }

  deleteSegment(index: number): void {
    const s = this.store.state;
    const seg = s.segments[index];
    if (!seg) return;
    s.segments.splice(index, 1);
    void this.db.deleteSegment(seg.id);
    s.deleted.push({ seg, index });
    this.saveMeta();
    this.list.render(s.segments, s.slides, false);
    this.updateSlideStats();
    this.updateButtons();
    this.toast.show(`Removed phrase ${index + 1} (${fmtSec(segmentDuration(seg))}, slide ${seg.slide + 1})`, {
      label: 'Undo',
      run: () => this.undoDelete(),
    });
  }

  deleteLast(): void {
    const s = this.store.state;
    if (s.speaking && this.vad) {
      this.vad.discard();
      this.toast.show('Dropped the phrase you were just saying. Go again.');
      return;
    }
    if (s.segments.length === 0) {
      this.toast.show('Nothing to remove');
      return;
    }
    this.deleteSegment(s.segments.length - 1);
  }

  undoDelete(): void {
    const s = this.store.state;
    const d = s.deleted.pop();
    if (!d) return;
    s.segments.splice(Math.min(d.index, s.segments.length), 0, d.seg);
    void this.db.putSegment(d.seg);
    this.saveMeta();
    this.list.render(s.segments, s.slides, false);
    this.updateSlideStats();
    this.updateButtons();
  }

  moveSegment(from: number, to: number): void {
    const s = this.store.state;
    const [seg] = s.segments.splice(from, 1);
    if (!seg) return;
    s.segments.splice(to, 0, seg);
    this.saveMeta();
    this.list.render(s.segments, s.slides, false);
  }

  timeline(order: PhraseOrder): Timeline {
    return buildTimeline(this.store.state.segments, order, this.store.settings);
  }

  /* ------------------------------------------------------------------ */
  /* Status & meter                                                      */
  /* ------------------------------------------------------------------ */

  private updateStatus(): void {
    const s = this.store.state;
    const pill = this.refs.statusPill;
    pill.className = 'pill';
    let text: string;
    if (s.previewing) {
      pill.classList.add('preview');
      text = 'Preview';
    } else if (!s.armed) text = 'Mic off';
    else if (s.muted) {
      pill.classList.add('muted');
      text = 'Muted';
    } else if (s.speaking) {
      pill.classList.add('rec');
      text = 'Recording';
    } else {
      pill.classList.add('listen');
      text = 'Listening';
    }
    this.refs.statusText.textContent = text;
    this.refs.capFlag.classList.toggle('on', s.armed && s.speaking && !s.muted && !s.previewing);
    this.refs.btnArm.textContent = s.armed ? 'Stop mic' : 'Start mic';
    this.refs.btnArm.classList.toggle('rec', s.armed);
    this.refs.btnArm.classList.toggle('primary', !s.armed);
    this.refs.btnMute.textContent = s.muted ? 'Unmute' : 'Mute';
  }

  private meterLoop(): void {
    cancelAnimationFrame(this.meterRaf);
    const loop = () => {
      this.drawMeter();
      if (this.store.state.armed) this.meterRaf = requestAnimationFrame(loop);
    };
    loop();
  }

  private drawMeter(): void {
    const s = this.store.state;
    this.meter.draw({
      armed: s.armed,
      muted: s.muted,
      speaking: s.speaking,
      level: this.vad?.level ?? -90,
      threshold: this.vad?.threshold ?? this.store.settings.threshold,
      noise: this.vad?.noise ?? -60,
      settingThreshold: this.store.settings.threshold,
    });
  }

  private syncSliders(): void {
    const r = this.refs;
    const st = this.store.settings;
    r.thr.value = String(st.threshold);
    r.thrV.textContent = `${st.threshold} dB`;
    r.gap.value = String(st.gapMs);
    r.gapV.textContent = `${(st.gapMs / 1000).toFixed(2)} s`;
    r.hang.value = String(st.hangoverMs);
    r.hangV.textContent = `${(st.hangoverMs / 1000).toFixed(2)} s`;
  }

  private showLoading(text: string): void {
    this.refs.loadingText.textContent = text;
    this.refs.loading.classList.add('on');
  }

  private hideLoading(): void {
    this.refs.loading.classList.remove('on');
  }

  /* ------------------------------------------------------------------ */
  /* Preview                                                             */
  /* ------------------------------------------------------------------ */

  async startPreview(fromIndex: number): Promise<void> {
    const s = this.store.state;
    if (s.segments.length === 0) return;
    if (s.previewing) this.stopPreview();
    this.vad?.end();
    const tl = this.timeline('recorded');
    s.previewing = true;
    if (this.vad) this.vad.gate = this.gateOpen();
    this.updateStatus();
    this.refs.previewFlag.classList.add('on');
    this.refs.btnPreview.textContent = 'Stop preview';
    await this.preview.start(tl, fromIndex);
  }

  private onPreviewTick(index: number, now: number, total: number): void {
    const items = this.timeline('recorded').items;
    const it = items[index];
    if (!it) return;
    if (this.store.state.current !== it.seg.slide) this.showSlide(it.seg.slide);
    this.list.setPlaying(this.store.state.segments.indexOf(it.seg));
    this.refs.previewTime.textContent = `${fmtTime(now)} / ${fmtTime(total)}`;
  }

  stopPreview(): void {
    const s = this.store.state;
    s.previewing = false;
    this.preview.stop();
    this.list.setPlaying(null);
    this.refs.previewFlag.classList.remove('on');
    this.refs.btnPreview.textContent = 'Preview';
    if (this.vad) this.vad.gate = this.gateOpen();
    this.updateStatus();
  }

  /* ------------------------------------------------------------------ */
  /* Export                                                              */
  /* ------------------------------------------------------------------ */

  openExport(): void {
    if (this.store.state.segments.length === 0) return;
    if (this.store.state.previewing) this.stopPreview();
    this.exportDialog.open();
  }

  /* ------------------------------------------------------------------ */
  /* Persistence                                                         */
  /* ------------------------------------------------------------------ */

  private saveMeta(): void {
    clearTimeout(this.metaTimer);
    this.metaTimer = window.setTimeout(() => {
      const meta: ProjectMeta = {
        order: this.store.state.segments.map((s) => s.id),
        current: this.store.state.current,
        settings: { ...this.store.settings },
        savedAt: Date.now(),
        segmentCounter: this.segmentCounter,
        exportRequest: this.exportRequest,
      };
      void this.db.putMeta(meta);
    }, 300);
  }

  private async restore(
    meta: ProjectMeta | undefined,
    files: SlideSource | undefined,
    segments: Segment[],
  ): Promise<void> {
    if (meta?.settings) {
      const { threshold, gapMs, hangoverMs } = meta.settings;
      Object.assign(this.store.settings, {
        threshold: threshold ?? DEFAULT_SETTINGS.threshold,
        gapMs: gapMs ?? DEFAULT_SETTINGS.gapMs,
        hangoverMs: hangoverMs ?? DEFAULT_SETTINGS.hangoverMs,
      });
      this.syncSliders();
    }
    if (meta?.segmentCounter) this.segmentCounter = meta.segmentCounter;
    if (files) await this.loadSlideSource(files);
    if (segments.length > 0) {
      const order = meta?.order ?? [];
      const byId = new Map(segments.map((s) => [s.id, s]));
      const ordered = order.map((id) => byId.get(id)).filter((s): s is Segment => s !== undefined);
      for (const s of segments) if (!order.includes(s.id)) ordered.push(s);
      this.store.state.segments = ordered.map((s) => ({
        ...s,
        pcm: s.pcm instanceof Int16Array ? s.pcm : new Int16Array(s.pcm as ArrayLike<number>),
      }));
    }
    if (this.store.state.slides.length > 0) this.showSlide(meta?.current ?? 0);
    this.list.render(this.store.state.segments, this.store.state.slides, true);
    this.updateSlideStats();
    this.updateButtons();
    this.toast.show(
      `Restored ${this.store.state.segments.length} phrases (${fmtTime(totalDuration(this.store.state.segments))})`,
    );
  }

  async newProject(): Promise<void> {
    if (!this.confirmTwice('new')) return;
    if (this.store.state.armed) this.stopMic();
    if (this.store.state.previewing) this.stopPreview();
    await this.db.clear();
    const s = this.store.state;
    s.segments = [];
    s.deleted = [];
    s.current = 0;
    releaseSlides(s.slides);
    s.slides = [];
    s.slideSource = null;
    this.film.render([]);
    this.refs.slideImg.style.display = 'none';
    this.refs.empty.style.display = '';
    this.refs.slideNo.textContent = '–';
    this.refs.slideTime.textContent = '';
    this.refs.btnArm.disabled = true;
    this.list.render([], [], false);
    this.updateSlideStats();
    this.updateButtons();
  }

  /** Internals exposed for the end-to-end test runner. */
  testHooks(): Record<string, unknown> {
    return {
      state: this.store.state,
      settings: this.store.settings,
      vad: () => this.vad,
      api: this.api,
      startMic: () => this.startMic(),
      stopMic: () => this.stopMic(),
      goTo: (i: number) => this.goTo(i),
      timeline: (order: PhraseOrder) => this.timeline(order),
      deleteLast: () => this.deleteLast(),
      undoDelete: () => this.undoDelete(),
      loadSlideSource: (src: SlideSource) => this.loadSlideSource(src),
      filesChosen: (files: Iterable<File>) => this.filesChosen(files),
      openExport: () => this.openExport(),
      exportDialog: this.exportDialog,
      serverCaps: () => this.serverCaps,
      browserCaps: () => this.browserCaps,
      refreshServer: () => this.refreshServer(),
      slides: () => this.store.state.slides,
      exportWith: (overrides: Partial<ExportRequest>, inMemory = false) =>
        this.exportWith(overrides, inMemory),
    };
  }

  /** Programmatic export used by the end-to-end tests; returns a JSON-friendly summary. */
  private async exportWith(
    overrides: Partial<ExportRequest>,
    inMemory: boolean,
  ): Promise<Record<string, unknown>> {
    const base = this.exportRequest ?? defaultExportRequest(this.serverCaps?.defaultDirectory ?? null);
    const request: ExportRequest = structuredClone({ ...base, ...overrides });
    const plan = planExport(request, this.serverCaps, this.browserCaps);
    const result = await runExport({
      request,
      plan,
      timeline: this.timeline(request.order),
      slides: this.store.state.slides,
      api: this.serverCaps ? this.api : null,
      signal: new AbortController().signal,
      onProgress: () => undefined,
      forceInMemory: inMemory,
    });
    if (result.kind === 'blob') {
      const bytes = new Uint8Array(await result.blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000)
        s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { kind: 'blob', name: result.name, base64: btoa(s), plan };
    }
    return { ...result, plan };
  }
}
