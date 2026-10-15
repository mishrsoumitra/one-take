/** The controller: wires microphone, detector, slides, persistence, preview and export to the views. */
import {
  defaultExportRequest,
  NO_HARDWARE,
  NO_SOFTWARE,
  normalizeExportRequest,
  planExport,
  stripExtension,
  type BrowserCapabilities,
  type ExportRequest,
  type ServerCapabilities,
} from '@one-take/shared';

import { ApiClient } from '../api/client.js';
import { MicCapture, type NoiseFilterMode } from '../audio/mic.js';
import { PreviewPlayer } from '../audio/preview.js';
import { fmtSec, fmtTime } from '../core/format.js';
import { judgeSpeaker } from '../core/identity.js';
import { floatBlocksToInt16 } from '../core/pcm.js';
import { Recorder, type BlockRange, type CaptureMode } from '../core/recorder.js';
import { cutPhrase } from '../core/silence.js';
import { ENROLL_SEC, SPEAKER_MODEL, type VoiceProfile } from '../core/speaker.js';
import { LIVE_KEEP, MicScorer } from '../core/speech.js';
import {
  buildTimeline,
  durationPerSlide,
  segmentDuration,
  totalDuration,
  type PhraseOrder,
  type Segment,
  type Timeline,
} from '../core/timeline.js';
import { VoiceDetector } from '../core/voice.js';
import { detectBrowserCapabilities } from '../export/capabilities.js';
import { runExport } from '../export/runner.js';
import { type FetchProgress } from '../models/fetch.js';
import { loadSlides, releaseSlides, slideSourceFromFiles } from '../slides/loader.js';
import { VoiceCheck, type VoiceResult } from '../speaker/voice-check.js';
import { ProjectStore } from '../storage/db.js';
import { loadPrefs, savePrefs, type Prefs, type Theme } from '../storage/prefs.js';
import { loadProfile, saveProfile } from '../storage/profile.js';
import { Confirm } from '../ui/confirm.js';
import { h, setLabel, syncRangeFill } from '../ui/dom.js';
import { Editor } from '../ui/editor.js';
import { Enroll, type EnrollClip } from '../ui/enroll.js';
import { ExportDialog } from '../ui/export-dialog.js';
import { Filmstrip } from '../ui/filmstrip.js';
import { FolderPicker } from '../ui/folder-picker.js';
import { setButtonIcon } from '../ui/icon.js';
import { installKeyboard } from '../ui/keyboard.js';
import { buildLayout, type LayoutRefs } from '../ui/layout.js';
import { Library } from '../ui/library.js';
import { LevelMeter } from '../ui/meter.js';
import { TimelineList } from '../ui/timeline-list.js';
import { Toast } from '../ui/toast.js';
import { Welcome } from '../ui/welcome.js';
import { LipWatcher } from '../vision/lips.js';

import { Store } from './store.js';
import { DEFAULT_SETTINGS, type PresentationPick, type ProjectMeta, type SlideSource } from './types.js';

const BLOCK_MS = 10;
const CONFIRM_WINDOW_MS = 5000;
/**
 * A phrase's audio goes to the voice check while a voice is going on, and through this much of the
 * quiet after it; the rest of the live hold (two seconds of nothing) would only dilute the vector.
 */
const FEED_QUIET_MS = 300;
/**
 * How far behind the microphone a block reaches the page: the deep filter (30 ms), its reframing
 * (11 ms), the capture worklet and the message. Used to place a phrase against the camera's clock.
 */
const PIPELINE_DELAY_MS = 60;
/** Verdicts are kept for this many live phrases back, for pieces stored after their phrase ended. */
const JUDGING_KEPT = 50;

/** A verdict in the making for one live phrase: what the voice check will say, once the phrase ends. */
interface Judging {
  voice: Promise<VoiceResult | null>;
  resolve: (result: VoiceResult | null) => void;
}

function asFilterMode(value: string): NoiseFilterMode {
  return value === 'classic' || value === 'off' ? value : 'deep';
}

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
  /** The exported videos: list, play, show in folder, delete. */
  private readonly library: Library;
  private readonly editor: Editor;
  private readonly folderPicker: FolderPicker;
  private readonly welcome: Welcome;
  /** The question asked before the slides close with phrases still on them. */
  private readonly confirm: Confirm;
  private prefs: Prefs = loadPrefs();
  /** The detector and the mode driving it; exists while the mic is on. */
  private recorder: Recorder | null = null;
  /** Resolves once every phrase finished so far has been through the second listen and stored. */
  private settling: Promise<void> = Promise.resolve();
  /** Tells a voice from the rest of what the microphone hears. */
  private readonly voice = new VoiceDetector();
  /** Scores the microphone for the detector; exists while the mic is on. */
  private scorer: MicScorer | null = null;
  /** The voice check: the speaker model in its worker, compared with the enrolled profile. */
  private readonly voiceCheck: VoiceCheck;
  private profile: VoiceProfile | null = loadProfile();
  /** The lip check: the camera, watched by the face model in its worker. */
  private readonly lips: LipWatcher;
  private readonly enroll: Enroll;
  /** The enrollment has been offered once this session; a skip is not asked about again. */
  private enrollOffered = false;
  /** Models announced as being fetched, so each is mentioned once. */
  private readonly fetching = new Set<string>();
  /** The verdicts in the making, by live-phrase key (see `Phrase.key`). */
  private readonly judging = new Map<number, Judging>();
  /** The live phrase whose audio is going to the voice check right now. */
  private feeding: number | null = null;
  /** When the latest block reached the page (absolute ms) and the stream's count then: places a phrase in time. */
  private clock: { at: number; seen: number } | null = null;
  /** The engines the user has been told about falling back, so each is said once per session. */
  private fallbackTold = false;
  private selfNoteShown = '';
  /** The start in progress, so a second Start (a double press, a held R key) joins it instead of racing it. */
  private micStarting: Promise<void> | null = null;
  /** The microphone has been opened once: the browser now tells the microphones apart by name. */
  private micOpened = false;
  private sampleRate = 48000;
  private segmentCounter = 0;
  private metaTimer = 0;
  private meterRaf = 0;
  private replaceArmedAt = 0;
  private serverCaps: ServerCapabilities | null = null;
  private browserCaps: BrowserCapabilities = {
    videoCodecs: [],
    audioCodecs: [],
    fileSystemAccess: false,
    hardware: { ...NO_HARDWARE },
    software: { ...NO_SOFTWARE },
    benchmark: null,
    hardwareConcurrency: null,
    deviceMemoryGb: null,
    gpu: null,
    browser: null,
  };
  private exportRequest: ExportRequest | null = null;
  /** The timeline being previewed; built once per preview instead of once per animation frame. */
  private previewTimeline: Timeline | null = null;

  constructor(root: HTMLElement) {
    this.refs = buildLayout(root);
    this.applyTheme(this.prefs.theme);
    this.toast = new Toast(document.body);
    this.confirm = new Confirm(document.body);
    this.voiceCheck = new VoiceCheck(
      () => this.profile,
      (p) => this.onModelProgress('voice', p),
    );
    this.lips = new LipWatcher((p) => this.onModelProgress('face', p));
    this.enroll = new Enroll(document.body, {
      listen: (onTick, signal) => this.listenForEnrollment(onTick, signal),
      enroll: (clip) => this.makeProfile(clip),
    });
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
    this.welcome = new Welcome(document.body, {
      onChooseSlides: () => this.refs.fileInput.click(),
      onTipsChange: (on) => {
        this.prefs = savePrefs({ tips: on });
        this.updateCoach();
      },
      onClose: () => {
        this.prefs = savePrefs({ welcomeSeen: true });
      },
    });
    this.exportDialog = new ExportDialog(document.body, {
      api: this.api,
      folderPicker: this.folderPicker,
      browserCaps: () => this.browserCaps,
      serverCaps: () => this.serverCaps,
      refreshServer: () => this.refreshServer(),
      timeline: (order) => this.timeline(order),
      segments: () => this.store.state.segments,
      timelineSettings: () => this.store.settings,
      slides: () => this.store.state.slides,
      suggestedName: () => {
        const source = this.store.state.slideSource;
        return stripExtension(source?.origin?.name ?? source?.files[0]?.name ?? '') || 'lecture';
      },
      initialRequest: () => this.exportRequest ?? defaultExportRequest(null),
      onRequestChange: (request) => {
        this.exportRequest = request;
        this.saveMeta();
      },
      hardwarePreference: () => this.prefs.hardwareEncoding,
      onHardwarePreferenceChange: (on) => {
        this.prefs = savePrefs({ hardwareEncoding: on });
      },
      onOpenLibrary: () => this.library.open(),
      onExportingChange: (exporting) => {
        this.store.state.exporting = exporting;
        this.syncPaused();
        this.updateButtons();
      },
      onBeforeExport: () => {
        if (this.store.state.previewing) this.stopPreview();
        this.recorder?.end();
      },
    });
    this.library = new Library(document.body, {
      api: this.api,
      serverCaps: () => this.serverCaps,
      confirm: this.confirm,
      toast: this.toast,
    });
    this.editor = new Editor(document.body, {
      slides: () => this.store.state.slides,
      segments: () => this.store.state.segments,
      settings: () => this.store.settings,
      mode: () => this.store.state.mode,
      mic: this.mic,
      micDeviceId: () => this.refs.micSelect.value || undefined,
      noiseFilter: () => this.prefs.noiseFilter,
      nextId: () => this.nextSegmentId(),
      speech: () => this.voice,
      onChange: (segments) => this.applyEdit(segments),
      onClose: () => {
        // the editor may have moved the playhead to another slide; show the one the user left on
        this.showSlide(this.store.state.current);
        this.updateButtons();
        this.updateStatus();
      },
      toast: this.toast,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  async init(): Promise<void> {
    this.store.state.mode = this.prefs.captureMode;
    this.refs.noiseFilter.value = this.prefs.noiseFilter;
    this.refs.camSelect.value = this.prefs.lipCheck ? this.prefs.cameraDeviceId : 'off';
    this.updateVoiceButton();
    this.wire();
    this.syncSliders();
    this.updateModeSwitch();
    this.drawMeter();
    // both side panels show their placeholder from the first paint
    this.film.render([]);
    this.list.render([], [], false);
    void this.listMics();
    void this.listCameras();
    if (!('mediaDevices' in navigator)) {
      this.toast.show('This browser cannot use the microphone here. Open the app in Chrome.');
    }
    void detectBrowserCapabilities().then((caps) => {
      this.browserCaps = caps;
      if (this.exportDialog.isOpen) this.exportDialog.refresh();
    });
    void this.refreshServer();
    const [meta, files, segments] = await Promise.all([
      this.db.getMeta(),
      this.db.getSlideSource(),
      this.db.getSegments(),
    ]);
    if (meta?.exportRequest) this.exportRequest = normalizeExportRequest(meta.exportRequest, null);
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
    } else if (!this.prefs.welcomeSeen) {
      // First visit with nothing to resume: explain the three steps before anything else.
      this.openWelcome();
    }
    this.updateSteps();
    this.updateCoach();
  }

  private openWelcome(): void {
    this.welcome.open({ tips: this.prefs.tips });
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
        ? 'Saves to this computer'
        : 'Saves to this computer · no ffmpeg'
      : 'Local server off · browser download only';
    pill.title = this.serverCaps
      ? `The local server is running. Exports are saved into ${this.serverCaps.defaultDirectory} (you can pick another folder when exporting).${this.serverCaps.ffmpeg ? `\nffmpeg ${this.serverCaps.ffmpeg.version} at ${this.serverCaps.ffmpeg.path}` : '\nInstall ffmpeg for HLS, DASH and compression.'}\nPowerPoint files are converted with ${this.serverCaps.presentations.renderer}.`
      : 'The local server is not running, so exports download through the browser and PowerPoint files cannot be converted. Start it with "npm start".';
    this.refs.dropHint.textContent = this.convertHint();
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

  /** One line under the drop zone saying which deck formats can be loaded directly right now. */
  private convertHint(): string {
    const caps = this.serverCaps;
    if (!caps) {
      return 'PowerPoint files are converted by the local server; start it with "npm start". Keynote or Google Slides: export as PDF or .pptx first.';
    }
    const exts = caps.presentations.extensions.map((e) => `.${e}`).join(', ');
    return `${exts} files are converted to PDF by the local server. Keynote or Google Slides: export as PDF or .pptx first.`;
  }

  private wire(): void {
    const r = this.refs;
    r.btnLoad.onclick = () => r.fileInput.click();
    r.btnChoose.onclick = () => r.fileInput.click();
    r.fileInput.onchange = () => {
      void this.filesChosen(r.fileInput.files ?? []);
      r.fileInput.value = '';
    };
    r.btnHelp.onclick = () => this.openWelcome();
    r.btnLibrary.onclick = () => this.library.open();
    r.btnTheme.onclick = () => {
      this.prefs = savePrefs({ theme: this.prefs.theme === 'dark' ? 'light' : 'dark' });
      this.applyTheme(this.prefs.theme);
      this.drawMeter();
    };
    r.btnEmptyHelp.onclick = () => this.openWelcome();
    r.btnCoachClose.onclick = () => {
      this.prefs = savePrefs({ tips: false });
      this.updateCoach();
      this.toast.show('Tips hidden. Help in the top bar turns them back on.');
    };
    // Files can be dropped anywhere on the page, not only on the drop zone.
    const dragging = (on: boolean) => {
      document.body.classList.toggle('dragging', on);
      r.drop.classList.toggle('over', on);
    };
    document.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files') || this.dialogOpen()) return;
      e.preventDefault();
      dragging(true);
    });
    document.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null) dragging(false);
    });
    document.addEventListener('drop', (e) => {
      if (this.dialogOpen()) return;
      e.preventDefault();
      dragging(false);
      if (e.dataTransfer?.files.length) void this.filesChosen(e.dataTransfer.files);
    });
    r.btnArm.onclick = () => (this.store.state.armed ? this.stopMic() : void this.startMic());
    r.btnMute.onclick = () => this.toggleMute();
    r.btnModeAuto.onclick = () => this.setMode('auto');
    r.btnModeHold.onclick = () => this.setMode('hold');
    // The hold button follows the pointer, not clicks: down starts, up (anywhere) or a cancel ends.
    r.btnHold.onpointerdown = (e) => {
      e.preventDefault(); // keeps focus where it was and stops touch from scrolling or selecting
      r.btnHold.setPointerCapture(e.pointerId);
      this.hold(true);
    };
    const holdUp = (e: PointerEvent) => {
      if (r.btnHold.hasPointerCapture(e.pointerId)) r.btnHold.releasePointerCapture(e.pointerId);
      this.hold(false);
    };
    r.btnHold.onpointerup = holdUp;
    r.btnHold.onpointercancel = holdUp;
    r.btnHold.oncontextmenu = (e) => e.preventDefault();
    r.navPrev.onclick = () => this.goTo(this.store.state.current - 1);
    r.navNext.onclick = () => this.goTo(this.store.state.current + 1);
    r.btnPreview.onclick = () =>
      this.store.state.previewing ? this.stopPreview() : void this.startPreview(0);
    r.btnStopPreview.onclick = () => this.stopPreview();
    r.btnEdit.onclick = () => this.openEditor();
    r.btnExport.onclick = () => this.openExport();
    r.btnClose.onclick = () => void this.closeSlides();
    // both controls give the keyboard back once a choice is made: a focused select or checkbox would
    // swallow Space and the arrow keys, which belong to the talk key and the slides
    r.micSelect.onchange = () => {
      this.prefs = savePrefs({ micDeviceId: r.micSelect.value });
      r.micSelect.blur();
      if (this.store.state.armed) {
        this.stopMic();
        void this.startMic();
      }
    };
    r.noiseFilter.onchange = () => {
      this.setNoiseFilter(asFilterMode(r.noiseFilter.value));
      r.noiseFilter.blur();
    };
    r.camSelect.onchange = () => {
      this.setCamera(r.camSelect.value);
      r.camSelect.blur();
    };
    r.btnVoice.onclick = () => void this.enrollVoice();
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
    if ('mediaDevices' in navigator) {
      navigator.mediaDevices.addEventListener('devicechange', () => {
        void this.listMics();
        void this.listCameras();
      });
    }
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
        holdStart: () => this.hold(true),
        holdEnd: () => void this.hold(false),
      },
      () => this.dialogOpen(),
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

  /** True while a modal (export, folder picker, welcome, editor, a question) owns the keyboard and drops. */
  private dialogOpen(): boolean {
    return (
      this.exportDialog.isOpen ||
      this.folderPicker.isOpen ||
      this.welcome.isOpen ||
      this.editor.isOpen ||
      this.library.isOpen ||
      this.confirm.isOpen ||
      this.enroll.isOpen
    );
  }

  async filesChosen(fileList: Iterable<File>): Promise<void> {
    const picked = slideSourceFromFiles(fileList);
    if (!picked) {
      this.toast.show('Please choose a PDF, a PowerPoint file or slide images');
      return;
    }
    this.welcome.close();
    if (this.store.state.segments.length > 0 && !this.confirmReplace()) return;
    const source = picked.kind === 'presentation' ? await this.convertPresentation(picked) : picked;
    if (!source) return;
    await this.loadSlideSource(source);
    await this.db.putSlideSource(source);
    this.saveMeta();
  }

  /**
   * Sends a PowerPoint file to the local server, whose JavaScript renderer turns it into a PDF, and
   * returns that PDF as a slide source that remembers the original file name. Explains what is missing
   * (the server, or support for this file type) instead of returning a source.
   */
  private async convertPresentation(pick: PresentationPick): Promise<SlideSource | null> {
    const caps = this.serverCaps ?? (await this.refreshServer());
    if (!caps) {
      this.toast.show(
        `${pick.file.name} needs the local server to be converted. Start it with "npm start", or export the deck as PDF.`,
      );
      return null;
    }
    if (!caps.presentations.extensions.includes(pick.extension)) {
      this.toast.show(
        `This server cannot read .${pick.extension} files (it takes ${caps.presentations.extensions.map((e) => `.${e}`).join(', ')}). Export the deck as PDF or .pptx.`,
      );
      return null;
    }
    this.showLoading(`Converting ${pick.file.name} to PDF…`);
    try {
      const result = await this.api.convertToPdf(pick.file);
      if (result.warnings.length > 0) {
        console.warn(`Converting ${pick.file.name}:`, result.warnings);
        this.toast.show(
          `${pick.file.name}: ${result.warnings.length} ${result.warnings.length === 1 ? 'thing' : 'things'} could not be drawn exactly (details in the browser console)`,
        );
      }
      return {
        kind: 'pdf',
        files: [
          { name: `${stripExtension(pick.file.name)}.pdf`, type: 'application/pdf', blob: result.blob },
        ],
        origin: { name: pick.file.name, type: pick.file.type, warnings: result.warnings },
      };
    } catch (error) {
      console.error(error);
      this.toast.show(`Could not convert ${pick.file.name}: ${(error as Error).message}`);
      return null;
    } finally {
      this.hideLoading();
    }
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
      this.refs.overlay.hidden = false;
      this.refs.btnArm.disabled = false;
      this.refs.btnArm.title = 'Start listening (R)';
      setLabel(this.refs.btnLoad, 'Change slides');
      this.refs.deckName.textContent = this.deckLabel(source, slides.length);
      this.refs.deckName.title = this.refs.deckName.textContent;
      this.refs.deckName.hidden = false;
      this.list.render(this.store.state.segments, slides, false);
      this.updateButtons();
      if (!this.prefs.tips) {
        this.toast.show(
          `${slides.length} slide${slides.length === 1 ? '' : 's'} loaded. Next: click Start mic and talk.`,
        );
      }
    } catch (error) {
      console.error(error);
      this.toast.show(`Could not load slides: ${(error as Error).message}`);
    } finally {
      this.hideLoading();
    }
  }

  /** What to call the loaded deck in the top bar: the file name, or a count for loose images. */
  private deckLabel(source: SlideSource, count: number): string {
    if (source.origin?.name) return source.origin.name;
    if (source.kind === 'pdf') return source.files[0]?.name ?? 'slides.pdf';
    return `${count} image${count === 1 ? '' : 's'}`;
  }

  /** Swapping the deck under existing phrases goes ahead only when the file is loaded twice in a row. */
  private confirmReplace(): boolean {
    const now = Date.now();
    if (now - this.replaceArmedAt < CONFIRM_WINDOW_MS) return true;
    this.replaceArmedAt = now;
    this.toast.show(
      'You already have recordings. Phrase numbers stay tied to slide numbers. Load again to confirm.',
    );
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
    // A sentence in progress is split here: the part so far goes on the slide being left.
    this.recorder?.setSlide(index);
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
    this.refs.btnEdit.disabled = !has || s.exporting;
    this.refs.btnExport.disabled = !has || s.exporting;
    this.refs.btnPreview.title = has ? 'Play back what you have recorded so far' : 'Record something first';
    this.refs.btnEdit.title = has ? 'Re-record, cut, add or remove clips' : 'Record something first';
    this.refs.btnExport.title = has ? 'Save the finished video' : 'Record something first';
    // In press to speak, letting go of the key is the mute: the button would only add noise.
    this.refs.btnMute.hidden = !s.armed || s.mode === 'hold';
    // The × after the deck name: there is nothing to close until slides or phrases exist.
    this.refs.btnClose.hidden = s.slides.length === 0 && !has;
    this.refs.btnClose.disabled = s.exporting;
    this.updateSteps();
    this.updateCoach();
  }

  /* ------------------------------------------------------------------ */
  /* Guidance: step badges in the top bar and the tip on the stage       */
  /* ------------------------------------------------------------------ */

  private setStep(badge: HTMLElement, state: 'todo' | 'active' | 'done'): void {
    badge.classList.toggle('active', state === 'active');
    badge.classList.toggle('done', state === 'done');
  }

  /** 1 → 2 → 3 in the top bar: which step is done, which one is next. */
  private updateSteps(): void {
    const s = this.store.state;
    const slides = s.slides.length > 0;
    const recorded = s.segments.length > 0;
    this.setStep(this.refs.stepSlides, slides ? 'done' : 'active');
    this.setStep(this.refs.stepMic, !slides ? 'todo' : recorded && !s.armed ? 'done' : 'active');
    this.setStep(this.refs.stepExport, recorded && !s.armed ? 'active' : 'todo');
  }

  /** One sentence for the current moment, or null when there is nothing worth saying. */
  private coachMessage(): string | null {
    const s = this.store.state;
    if (s.slides.length === 0 || s.previewing || s.exporting) return null;
    const n = s.segments.length;
    const hold = s.mode === 'hold';
    if (!s.armed) {
      if (n > 0) {
        return 'Step 3 · Preview to check it, or Export video when you are done. Start mic again to keep recording.';
      }
      return hold
        ? 'Step 2 · Click Start mic (or press R). Then hold Space, or the button on the stage, while you talk.'
        : 'Step 2 · Click Start mic (or press R), then just talk. Pauses are cut out automatically.';
    }
    if (s.muted) return 'Muted. Press M or click Unmute to continue recording.';
    if (hold && s.held) {
      return s.speaking
        ? 'Recording. Let go when you finish the thought; what you held is kept, the dead air is not.'
        : 'Go ahead and talk. Let go of Space (or the button) when you are done.';
    }
    if (n >= 3) return null;
    if (hold) {
      return n === 0
        ? 'Hold Space (or the button below) while you speak and let go while you think. Nothing is recorded in between.'
        : 'Hold again for the next phrase. → ← change slides, even mid-sentence; Backspace removes the last phrase.';
    }
    if (s.speaking) {
      return 'Recording. Pause whenever you like: the phrase is kept, the pause is not.';
    }
    if (n === 0) {
      return 'Listening. Speak whenever you are ready. Your voice should push the meter below past the white line.';
    }
    return 'Recording works. Use → ← to change slides as you talk; Backspace removes the last phrase.';
  }

  private updateCoach(): void {
    const message = this.prefs.tips ? this.coachMessage() : null;
    this.refs.coach.hidden = message === null;
    if (message !== null) this.refs.coachText.textContent = message;
  }

  /* ------------------------------------------------------------------ */
  /* Microphone                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Fills the microphone picker. The browser only names the microphones once the mic has been
   * allowed, so until the first start the list says so; the remembered choice is picked whenever it
   * is plugged in, and the default otherwise.
   */
  private async listMics(): Promise<void> {
    const devices = await MicCapture.listDevices();
    const sel = this.refs.micSelect;
    while (sel.options.length > 1) sel.remove(1);
    for (const d of devices) {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || 'Microphone';
      sel.appendChild(o);
    }
    if (devices.length === 0 && !this.micOpened) {
      const o = document.createElement('option');
      o.value = '';
      o.disabled = true;
      o.textContent = 'Start the mic once to list the others';
      sel.appendChild(o);
    }
    const wanted = this.prefs.micDeviceId;
    sel.value = devices.some((d) => d.deviceId === wanted) ? wanted : '';
  }

  /** Fills the camera picker the same way; "Camera off" stays whatever is plugged in. */
  private async listCameras(): Promise<void> {
    const devices = await LipWatcher.listDevices();
    const sel = this.refs.camSelect;
    while (sel.options.length > 2) sel.remove(2);
    for (const d of devices) {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || 'Camera';
      sel.appendChild(o);
    }
    const wanted = this.prefs.cameraDeviceId;
    sel.value = !this.prefs.lipCheck ? 'off' : devices.some((d) => d.deviceId === wanted) ? wanted : '';
  }

  /** Chooses the noise filter: at once while the mic is on, and for every mic from now on. */
  setNoiseFilter(mode: NoiseFilterMode): void {
    this.prefs = savePrefs({ noiseFilter: mode });
    this.refs.noiseFilter.value = mode;
    this.mic.setNoiseFilter(mode);
    this.drawMeter();
  }

  /** The filter that is really running, for the meter's note. */
  private filterLabel(): string | null {
    if (!this.store.state.armed) return null;
    switch (this.mic.engine) {
      case 'deep':
        return 'deep filter';
      case 'classic':
        return this.mic.wantedFilter === 'deep' && !this.mic.deepNote
          ? 'classic filter while the deep one loads'
          : 'classic filter';
      case 'off':
        return 'no filter';
    }
  }

  /** The filter running over the microphone changed (the deep one came up, or gave way). */
  private onEngineChange(engine: NoiseFilterMode): void {
    this.drawMeter();
    const note = this.mic.deepNote;
    if (engine === 'classic' && this.mic.wantedFilter === 'deep' && note && !this.fallbackTold) {
      this.fallbackTold = true;
      this.toast.show(`The deep noise filter is ${note}. The classic filter is on instead.`);
    }
  }

  /** Picks the camera for the lip check, or turns it off; takes effect at once while the mic is on. */
  setCamera(value: string): void {
    const on = value !== 'off';
    this.prefs = savePrefs({ lipCheck: on, cameraDeviceId: on ? value : this.prefs.cameraDeviceId });
    this.refs.camSelect.value = value;
    if (!this.store.state.armed) return;
    if (on) void this.watchLips();
    else {
      this.lips.stop();
      this.updateSelfView();
    }
  }

  /** Opens the camera and starts the lip check; says why when it cannot. */
  private async watchLips(): Promise<void> {
    const ok = await this.lips.start(this.prefs.cameraDeviceId || undefined);
    if (!this.store.state.armed) {
      this.lips.stop();
    } else if (!ok && this.lips.note) {
      this.toast.show(`The lip check is off: ${this.lips.note}`);
    }
    this.updateSelfView();
  }

  /** Shows the camera in the corner of the stage while it is watched, and what it sees under it. */
  private updateSelfView(): void {
    const video = this.store.state.armed ? this.lips.video : null;
    this.refs.selfBox.hidden = video === null;
    if (this.refs.selfView.srcObject !== video) this.refs.selfView.srcObject = video;
    this.selfNoteShown = '';
    this.updateSelfNote();
  }

  /** One line under the self-view: whether a face is in view and whether the lips are moving. */
  private updateSelfNote(): void {
    if (this.refs.selfBox.hidden) return;
    let text: string;
    let kind = '';
    if (this.lips.state === 'watching') {
      const now = performance.timeOrigin + performance.now();
      const latest = this.lips.latest;
      if (!latest || now - latest.t > 1500) text = 'Camera: waiting for a picture';
      else if (latest.open === null) {
        text = 'No face in view';
        kind = 'warn';
      } else {
        const recent = this.lips.activity(now - 1000, now);
        const moving = recent.swing >= 0.05 || recent.motion >= 0.02;
        text = moving ? 'Lips moving' : 'Face in view';
        kind = moving ? 'moving' : 'face';
      }
    } else if (this.lips.state === 'failed') {
      text = `Lip check off: ${this.lips.note ?? 'camera unavailable'}`;
      kind = 'warn';
    } else {
      text = 'Camera starting…';
    }
    const shown = `${kind}|${text}`;
    if (shown === this.selfNoteShown) return;
    this.selfNoteShown = shown;
    this.refs.selfNote.textContent = text;
    this.refs.selfNote.className = `note${kind ? ` ${kind}` : ''}`;
  }

  /** A model is being fetched from its publisher: said once per model, since it takes a moment. */
  private onModelProgress(what: 'voice' | 'face', p: FetchProgress): void {
    if (p.source !== 'remote' || this.fetching.has(what)) return;
    this.fetching.add(what);
    this.toast.show(
      `Fetching the ${what} model (${Math.round(p.total / 1_048_576)} MB) once; it is kept on this computer from now on.`,
    );
  }

  /** The "Learn my voice" button says whether a profile exists. */
  private updateVoiceButton(): void {
    const has = this.profile !== null;
    setLabel(this.refs.btnVoice, has ? 'Voice learned' : 'Learn my voice');
    this.refs.btnVoice.classList.toggle('has', has);
    this.refs.btnVoice.title = has
      ? `Your voice was learned on ${new Date(this.profile?.createdAt ?? 0).toLocaleDateString()} from ${Math.round(this.profile?.seconds ?? 0)} s of speech. Every phrase is compared with it; one in another voice is marked in the timeline. Click to learn it again.`
      : 'The voice check: read for twenty seconds once, and every phrase is compared with how your voice sounds. A phrase in another voice is marked in the timeline.';
  }

  /**
   * The enrollment: the speaker reads for twenty seconds and the voice heard becomes the profile.
   * The microphone is the enrollment's for the duration, so a recording in progress is stopped
   * first and started again after.
   */
  async enrollVoice(): Promise<void> {
    if (this.enroll.isOpen) return;
    const wasArmed = this.store.state.armed;
    if (wasArmed) this.stopMic();
    if (this.store.state.previewing) this.stopPreview();
    const profile = await this.enroll.open({ hasProfile: this.profile !== null });
    if (profile) {
      this.profile = profile;
      saveProfile(profile);
      this.prefs = savePrefs({ voiceCheck: true });
      this.toast.show('Your voice is learned. A phrase in another voice will be marked in the timeline.');
    } else if (!this.profile) {
      // skipped with nothing learned: not asked again; "Learn my voice" in the bottom bar is the way back
      this.prefs = savePrefs({ voiceCheck: false });
      this.toast.show(
        'The voice check stays off. Click "Learn my voice" under the level meter when you want it.',
      );
    }
    this.updateVoiceButton();
    if (wasArmed) void this.startMic();
  }

  /** Listens for the enrollment: the stretches with a voice in them, through the chosen filter. */
  private async listenForEnrollment(
    onTick: (voiceSec: number, elapsedSec: number) => void,
    signal: AbortSignal,
  ): Promise<EnrollClip | null> {
    const ready = this.voiceCheck.start(); // the model loads while the speaker reads
    const scorer = new MicScorer(this.voice);
    const heard: Float32Array[] = [];
    let voiceSamples = 0;
    let started: number | null = null;
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const info = await this.mic.start({
      deviceId: this.refs.micSelect.value || undefined,
      noiseFilter: this.prefs.noiseFilter,
      blockMs: BLOCK_MS,
      onBlock: (block) => {
        started ??= performance.now();
        scorer.push(block, this.mic.sampleRate);
        if (scorer.prob >= LIVE_KEEP) {
          heard.push(Float32Array.from(block));
          voiceSamples += block.length;
        }
        const elapsed = (performance.now() - started) / 1000;
        onTick(voiceSamples / this.mic.sampleRate, elapsed);
        if (elapsed >= ENROLL_SEC) finish();
      },
    });
    if (!info) return null;
    this.micOpened = true;
    void this.listMics();
    signal.addEventListener('abort', () => finish());
    await done;
    this.mic.stop();
    if (signal.aborted) return null;
    if (!(await ready)) throw new Error(this.voiceCheck.note ?? 'the voice model could not be loaded');
    const samples = new Float32Array(voiceSamples);
    let at = 0;
    for (const block of heard) {
      samples.set(block, at);
      at += block.length;
    }
    return { samples, rate: info.sampleRate };
  }

  /** The profile out of what the enrollment heard; null when the model could not make one. */
  private async makeProfile(clip: EnrollClip): Promise<VoiceProfile | null> {
    if (!(await this.voiceCheck.start())) {
      throw new Error(this.voiceCheck.note ?? 'the voice model is not available');
    }
    const { embedding, seconds } = await this.voiceCheck.embed(clip.samples, clip.rate);
    if (!embedding) return null;
    return { model: SPEAKER_MODEL.name, embedding: Array.from(embedding), seconds, createdAt: Date.now() };
  }

  /* ------------------------------------------------------------------ */
  /* Who is speaking: the checks on each live phrase                     */
  /* ------------------------------------------------------------------ */

  /** A live phrase started: its audio goes to the voice check from here until it ends. */
  private phraseStarted(key: number): void {
    let resolve: (result: VoiceResult | null) => void = () => undefined;
    const voice = new Promise<VoiceResult | null>((r) => {
      resolve = r;
    });
    this.judging.set(key, { voice, resolve });
    for (const old of this.judging.keys()) if (old < key - JUDGING_KEPT) this.judging.delete(old);
    if (this.prefs.voiceCheck && this.profile && this.voiceCheck.state === 'ready') {
      this.voiceCheck.begin(key, this.sampleRate);
      this.feeding = key;
    } else {
      resolve(null);
    }
  }

  /** The live phrase ended (kept, too short, or discarded): the voice check finishes its tail. */
  private phraseEnded(key: number): void {
    const judging = this.judging.get(key);
    if (this.feeding === key) {
      this.feeding = null;
      this.voiceCheck.end(key).then(
        (result) => judging?.resolve(result),
        () => judging?.resolve(null),
      );
    } else {
      judging?.resolve(null);
    }
  }

  /** When a stretch of the stream reached the microphone, in absolute ms, from the block clock. */
  private spanOf(at: BlockRange): { from: number; to: number } | null {
    const clock = this.clock;
    if (!clock) return null;
    const time = (block: number) => clock.at - (clock.seen - block) * BLOCK_MS - PIPELINE_DELAY_MS;
    return { from: time(at.from), to: time(at.to) };
  }

  /**
   * A piece of a live phrase was stored: once the voice check has spoken, it is judged together with
   * what the camera saw over the piece's own span, and the verdict goes on the segment.
   */
  private judgePiece(seg: Segment, key: number, at: BlockRange): void {
    const span = this.spanOf(at);
    const lipsOn = this.prefs.lipCheck && this.lips.state === 'watching';
    const voice = this.judging.get(key)?.voice ?? Promise.resolve(null);
    void voice.then((result) => {
      const lips = lipsOn && span ? this.lips.activity(span.from, span.to) : null;
      const verdict = judgeSpeaker({ similarity: result?.similarity ?? null, lips });
      if (!verdict) return;
      seg.speaker = verdict;
      if (!this.store.state.segments.includes(seg)) return; // deleted meanwhile
      void this.db.putSegment(seg);
      this.list.render(this.store.state.segments, this.store.state.slides, false);
    });
  }

  /** Preview and export pause the recorder; it stops listening until they end. */
  private syncPaused(): void {
    const s = this.store.state;
    this.recorder?.setPaused(s.previewing || s.exporting);
  }

  /* ------------------------------------------------------------------ */
  /* Recording mode: auto, or press to speak                            */
  /* ------------------------------------------------------------------ */

  /** Auto: the detector decides. Press to speak: only while Space or the stage button is held. */
  setMode(mode: CaptureMode): void {
    const s = this.store.state;
    if (s.mode === mode) return;
    s.mode = mode;
    s.held = false;
    if (mode === 'hold' && s.muted) {
      // letting go of the key is the mute in this mode; a stale mute would silence every press
      s.muted = false;
      this.recorder?.setMuted(false);
    }
    this.recorder?.setMode(mode);
    this.prefs = savePrefs({ captureMode: mode });
    this.updateModeSwitch();
    this.updateStatus();
    this.updateButtons();
    if (!this.prefs.tips) {
      this.toast.show(
        mode === 'hold'
          ? 'Press to speak: hold Space or the button on the stage while you talk; let go while you think.'
          : 'Auto: the mic listens the whole time and pauses are cut out.',
      );
    }
  }

  /**
   * The talk key or button went down or up. Returns true when press to speak owns the key, so
   * Space never changes slides in that mode, even while the mic is off.
   */
  hold(down: boolean): boolean {
    const s = this.store.state;
    if (s.mode !== 'hold') return false;
    if (!s.armed) {
      if (down && s.slides.length > 0) this.toast.show('Start the mic first (R), then hold Space to speak.');
      return true;
    }
    if (s.previewing || s.exporting) return true;
    const changed = this.recorder?.hold(down) ?? false;
    s.held = this.recorder?.held ?? false;
    if (changed) this.updateStatus();
    return true;
  }

  private updateModeSwitch(): void {
    const mode = this.store.state.mode;
    this.refs.btnModeAuto.setAttribute('aria-checked', String(mode === 'auto'));
    this.refs.btnModeHold.setAttribute('aria-checked', String(mode === 'hold'));
    this.refs.keyHold.hidden = mode !== 'hold';
    this.refs.keyMute.hidden = mode === 'hold';
  }

  startMic(): Promise<void> {
    if (this.store.state.armed) return Promise.resolve();
    this.micStarting ??= this.openMic().finally(() => {
      this.micStarting = null;
    });
    return this.micStarting;
  }

  private async openMic(): Promise<void> {
    const s = this.store.state;
    if (s.slides.length === 0) {
      this.toast.show('Load your slides first');
      return;
    }
    // the first time, with the voice check on and no voice learned yet: learn it now
    if (this.prefs.voiceCheck && !this.profile && !this.enrollOffered) {
      this.enrollOffered = true;
      await this.enrollVoice();
    }
    const recorder = new Recorder(
      BLOCK_MS,
      this.store.settings,
      {
        mode: s.mode,
        slide: s.current,
        // the second listen: each finished phrase is gone over whole before it is stored
        review: (blocks) => cutPhrase(blocks, this.sampleRate, this.store.settings),
      },
      {
        onPhrase: (phrase) => {
          const seg = this.addSegment(phrase.blocks, phrase.slide, phrase.joined, phrase.prevId, true);
          this.judgePiece(seg, phrase.key, phrase.at);
          return seg.id;
        },
        onSpeakingChange: (speaking, key) => {
          this.store.state.speaking = speaking;
          if (speaking) {
            this.refs.capFlagText.textContent = 'RECORDING';
            this.phraseStarted(key);
          } else {
            this.phraseEnded(key);
          }
          this.updateStatus();
        },
      },
    );
    try {
      const info = await this.mic.start({
        deviceId: this.refs.micSelect.value || undefined,
        noiseFilter: this.prefs.noiseFilter,
        blockMs: BLOCK_MS,
        onBlock: (block) => this.onBlock(block),
        onEngineChange: (engine) => this.onEngineChange(engine),
      });
      this.micOpened = true;
      if (!info) return; // stopped again before it had opened
      this.sampleRate = info.sampleRate;
    } catch (error) {
      this.toast.show(`Microphone not available: ${(error as Error).message}`);
      return;
    }
    void this.listMics();
    void this.listCameras();
    this.recorder = recorder;
    this.settling = this.settling.then(() => recorder.settled());
    this.scorer = new MicScorer(this.voice);
    this.clock = null;
    this.feeding = null;
    s.armed = true;
    s.muted = false;
    s.held = false;
    s.speaking = false;
    this.syncPaused();
    this.updateStatus();
    this.updateButtons();
    this.meterLoop();
    // the checks come up alongside: the voice model into its worker, the camera into the lip worker
    if (this.prefs.voiceCheck && this.profile) {
      void this.voiceCheck.start().then((ok) => {
        if (!ok && this.voiceCheck.note) this.toast.show(`The voice check is off: ${this.voiceCheck.note}`);
      });
    }
    if (this.prefs.lipCheck) void this.watchLips();
    this.updateSelfView();
    if (!this.prefs.tips) {
      this.toast.show(
        s.mode === 'hold'
          ? 'Mic on. Hold Space or the button on the stage while you speak.'
          : 'Listening. Speak whenever you are ready; silence is skipped automatically.',
      );
    }
  }

  stopMic(): void {
    const recorder = this.recorder;
    recorder?.end();
    this.mic.stop();
    // phrases still being reviewed are stored as the reviews come back
    if (recorder) this.settling = this.settling.then(() => recorder.settled());
    this.recorder = null;
    this.scorer = null;
    const s = this.store.state;
    s.armed = false;
    s.muted = false;
    s.held = false;
    s.speaking = false;
    this.lips.stop();
    this.updateSelfView();
    this.updateStatus();
    this.updateButtons();
    this.drawMeter();
  }

  toggleMute(): void {
    const s = this.store.state;
    if (!s.armed) return;
    if (s.mode === 'hold') {
      this.toast.show('Press to speak only records while you hold Space, so there is nothing to mute.');
      return;
    }
    s.muted = !s.muted;
    this.recorder?.setMuted(s.muted);
    this.updateStatus();
  }

  private onBlock(block: Float32Array): void {
    const recorder = this.recorder;
    if (!recorder) return;
    const scorer = this.scorer;
    scorer?.push(block, this.sampleRate);
    recorder.process(block, scorer?.prob ?? null);
    const { vad } = recorder;
    this.clock = { at: performance.timeOrigin + performance.now(), seen: vad.seen };
    // the phrase's audio goes to the voice check while a voice is going on, not through the hold
    if (this.feeding !== null && vad.speaking && vad.quietMs <= FEED_QUIET_MS) {
      this.voiceCheck.push(this.feeding, block);
    }
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
      id: this.nextSegmentId(),
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
    // the phrase being spoken, or one just finished and still being gone over, is not stored yet
    if (this.recorder?.discard()) {
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

  private nextSegmentId(): string {
    return `${Date.now()}-${++this.segmentCounter}`;
  }

  /* ------------------------------------------------------------------ */
  /* Editor                                                              */
  /* ------------------------------------------------------------------ */

  openEditor(): void {
    const s = this.store.state;
    if (s.segments.length === 0 || s.exporting) return;
    if (s.previewing) this.stopPreview();
    // the editor records its own takes, so the main microphone is turned off while it is open
    if (s.armed) this.stopMic();
    this.editor.open();
  }

  /**
   * The editor changed the list of phrases. Phrases are never changed in place, so a phrase that is
   * the same object as before needs no write; anything new or changed is saved, anything gone is deleted.
   */
  private applyEdit(next: Segment[]): void {
    const s = this.store.state;
    const before = new Map(s.segments.map((seg) => [seg.id, seg]));
    const after = new Map(next.map((seg) => [seg.id, seg]));
    for (const id of before.keys()) if (!after.has(id)) void this.db.deleteSegment(id);
    for (const [id, seg] of after) if (before.get(id) !== seg) void this.db.putSegment(seg);
    s.segments = next.slice();
    this.saveMeta();
    this.list.render(s.segments, s.slides, false);
    this.updateSlideStats();
    this.updateButtons();
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
    } else if (s.mode === 'hold') {
      pill.classList.add(s.held ? 'listen' : 'hold');
      text = s.held ? 'Speak now' : 'Hold Space';
    } else {
      pill.classList.add('listen');
      text = 'Listening';
    }
    this.refs.statusText.textContent = text;
    // the rest of the sentence leaves on narrow windows so the top bar stays one row
    if (text === 'Hold Space') this.refs.statusText.append(h('span', { class: 'long' }, ' to speak'));
    this.refs.capFlag.classList.toggle('on', s.armed && s.speaking && !s.muted && !s.previewing);
    // the hold button lives on the stage only in press to speak with the mic on
    const holdShown = s.armed && s.mode === 'hold' && !s.previewing && !s.exporting;
    this.refs.btnHold.hidden = !holdShown;
    this.refs.btnHold.classList.toggle('held', holdShown && s.held);
    this.refs.btnHoldText.textContent = s.held ? (s.speaking ? 'Recording' : 'Speak now') : 'Hold to speak';
    this.refs.stage.classList.toggle('hold-on', holdShown);
    setLabel(this.refs.btnArm, s.armed ? 'Stop mic' : 'Start mic');
    setButtonIcon(this.refs.btnArm, s.armed ? 'square-filled' : 'mic');
    this.refs.btnArm.classList.toggle('rec', s.armed);
    this.refs.btnArm.classList.toggle('primary', !s.armed);
    if (s.slides.length > 0) {
      this.refs.btnArm.title = s.armed
        ? 'Stop the mic (R)'
        : s.mode === 'hold'
          ? 'Start the mic (R); then hold Space to speak'
          : 'Start listening (R)';
    }
    setLabel(this.refs.btnMute, s.muted ? 'Unmute' : 'Mute');
    setButtonIcon(this.refs.btnMute, s.muted ? 'mic' : 'micmute');
    this.refs.btnMute.title = s.muted ? 'Unmute (M)' : 'Mute (M)';
    this.updateSteps();
    this.updateCoach();
  }

  private meterLoop(): void {
    cancelAnimationFrame(this.meterRaf);
    const loop = () => {
      this.drawMeter();
      this.updateSelfNote();
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
      level: this.recorder?.vad.level ?? -90,
      threshold: this.recorder?.vad.threshold ?? this.store.settings.threshold,
      noise: this.recorder?.vad.noise ?? -60,
      settingThreshold: this.store.settings.threshold,
      voice: this.recorder?.vad.voice ?? null,
      filter: this.filterLabel(),
    });
  }

  /** grauity's dark or light theme: the class on <html> scopes every token, the button shows the other one. */
  private applyTheme(theme: Theme): void {
    const html = document.documentElement;
    html.classList.toggle('grauity-theme-dark', theme === 'dark');
    html.classList.toggle('grauity-theme-light', theme === 'light');
    const other = theme === 'dark' ? 'light' : 'dark';
    this.refs.btnTheme.title = `Switch to the ${other} theme`;
    this.refs.btnTheme.setAttribute('aria-label', this.refs.btnTheme.title);
    setButtonIcon(this.refs.btnTheme, theme === 'dark' ? 'sun' : 'moon');
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
    for (const slider of [r.thr, r.gap, r.hang]) syncRangeFill(slider);
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
    const tl = this.timeline('recorded');
    this.previewTimeline = tl;
    s.previewing = true;
    this.syncPaused();
    this.updateStatus();
    this.refs.previewFlag.classList.add('on');
    setLabel(this.refs.btnPreview, 'Stop preview');
    setButtonIcon(this.refs.btnPreview, 'square-filled');
    await this.preview.start(tl, fromIndex);
  }

  private onPreviewTick(index: number, now: number, total: number): void {
    const items = (this.previewTimeline ?? this.timeline('recorded')).items;
    const it = items[index];
    if (!it) return;
    if (this.store.state.current !== it.seg.slide) this.showSlide(it.seg.slide);
    this.list.setPlaying(this.store.state.segments.indexOf(it.seg));
    this.refs.previewTime.textContent = `${fmtTime(now)} / ${fmtTime(total)}`;
  }

  stopPreview(): void {
    const s = this.store.state;
    s.previewing = false;
    this.previewTimeline = null;
    this.preview.stop();
    this.list.setPlaying(null);
    this.refs.previewFlag.classList.remove('on');
    setLabel(this.refs.btnPreview, 'Preview');
    setButtonIcon(this.refs.btnPreview, 'play');
    this.syncPaused();
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

  /**
   * Closes the slides and abandons the session: the deck, every phrase and the saved copy all go, and
   * the stage is back to "Load your slides". Slides with nothing recorded on them close at once;
   * otherwise the user is asked first, because the phrases cannot be brought back.
   */
  async closeSlides(): Promise<void> {
    const s = this.store.state;
    if (s.slides.length === 0 && s.segments.length === 0) return;
    if (s.exporting) return;
    // Nothing said from here on is recorded: the phrase in progress ends now, so the count below is
    // right, and the mic goes back to listening if the user keeps working.
    this.recorder?.setPaused(true);
    const n = s.segments.length;
    if (n > 0) {
      const ok = await this.confirm.ask({
        title: 'Close these slides?',
        message: `The ${n === 1 ? 'phrase' : `${n} phrases`} recorded on them (${fmtTime(totalDuration(s.segments))}) will be deleted. This cannot be undone.`,
        confirm: 'Close and delete',
        cancel: 'Keep working',
      });
      if (!ok) {
        this.syncPaused();
        return;
      }
    }
    if (s.armed) this.stopMic();
    if (s.previewing) this.stopPreview();
    await this.db.clear();
    s.segments = [];
    s.deleted = [];
    s.current = 0;
    releaseSlides(s.slides);
    s.slides = [];
    s.slideSource = null;
    this.film.render([]);
    this.refs.slideImg.style.display = 'none';
    this.refs.empty.style.display = '';
    this.refs.overlay.hidden = true;
    this.refs.slideNo.textContent = '–';
    this.refs.slideTime.textContent = '';
    this.refs.btnArm.disabled = true;
    this.refs.btnArm.title = 'Load your slides first';
    setLabel(this.refs.btnLoad, 'Load slides');
    this.refs.deckName.hidden = true;
    this.refs.deckName.textContent = '';
    this.list.render([], [], false);
    this.updateSlideStats();
    this.updateButtons();
    this.toast.show(
      n > 0
        ? `Slides closed. ${n === 1 ? 'The phrase was' : `${n} phrases were`} deleted.`
        : 'Slides closed.',
    );
  }

  /** Internals exposed for the end-to-end test runner. */
  testHooks(): Record<string, unknown> {
    return {
      state: this.store.state,
      settings: this.store.settings,
      vad: () => this.recorder?.vad ?? null,
      recorder: () => this.recorder,
      scorer: () => this.scorer,
      api: this.api,
      startMic: () => this.startMic(),
      stopMic: () => this.stopMic(),
      settled: () => this.settling,
      setMode: (mode: CaptureMode) => this.setMode(mode),
      setNoiseFilter: (mode: NoiseFilterMode | boolean) =>
        this.setNoiseFilter(typeof mode === 'boolean' ? (mode ? 'deep' : 'off') : mode),
      setCamera: (value: string) => this.setCamera(value),
      prefs: () => this.prefs,
      mic: this.mic,
      voiceCheck: this.voiceCheck,
      lips: this.lips,
      enroll: this.enroll,
      enrollVoice: () => this.enrollVoice(),
      profile: () => this.profile,
      /** Puts a profile in place without the enrollment (the tests make one from a fixture). */
      setProfile: (profile: VoiceProfile | null) => {
        this.profile = profile;
        if (profile) saveProfile(profile);
        this.updateVoiceButton();
      },
      /** Makes a profile out of a clip of floats, through the voice worker. */
      makeProfile: (samples: Float32Array, rate: number) => this.makeProfile({ samples, rate }),
      judging: () => this.judging.size,
      hold: (down: boolean) => this.hold(down),
      toggleMute: () => this.toggleMute(),
      goTo: (i: number) => this.goTo(i),
      timeline: (order: PhraseOrder) => this.timeline(order),
      deleteLast: () => this.deleteLast(),
      undoDelete: () => this.undoDelete(),
      loadSlideSource: (src: SlideSource) => this.loadSlideSource(src),
      filesChosen: (files: Iterable<File>) => this.filesChosen(files),
      closeSlides: () => this.closeSlides(),
      openExport: () => this.openExport(),
      exportDialog: this.exportDialog,
      openLibrary: () => this.library.open(),
      library: this.library,
      openEditor: () => this.openEditor(),
      editor: this.editor,
      serverCaps: () => this.serverCaps,
      browserCaps: () => this.browserCaps,
      system: () => this.serverCaps?.system ?? null,
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
    const stored = this.exportRequest ?? defaultExportRequest(this.serverCaps?.defaultDirectory ?? null);
    // the hardware switch is a browser preference, applied the same way the dialog applies it on opening
    const base = { ...stored, performance: { ...stored.performance, hardware: this.prefs.hardwareEncoding } };
    const request: ExportRequest = structuredClone(
      normalizeExportRequest({ ...base, ...overrides }, this.serverCaps?.defaultDirectory ?? null),
    );
    const plan = planExport(request, this.serverCaps, this.browserCaps);
    const started = performance.now();
    let encodeMs = 0;
    // what the time left said along the way, so the tests can judge it against the real time
    const eta = {
      first: null as number | null,
      max: null as number | null,
      samples: 0,
      bases: [] as string[],
    };
    const result = await runExport({
      request,
      plan,
      segments: this.store.state.segments,
      order: request.order,
      timelineSettings: this.store.settings,
      slides: this.store.state.slides,
      api: this.serverCaps ? this.api : null,
      signal: new AbortController().signal,
      onProgress: (p) => {
        if (p.stage === 'encoding') encodeMs = performance.now() - started;
        if (p.remainingSec !== null && p.stage !== 'done') {
          eta.first ??= p.remainingSec;
          eta.max = Math.max(eta.max ?? 0, p.remainingSec);
          eta.samples++;
          if (p.basis && eta.bases[eta.bases.length - 1] !== p.basis) eta.bases.push(p.basis);
        }
      },
      forceInMemory: inMemory,
    });
    const elapsedMs = Math.round(performance.now() - started);
    const timing = {
      elapsedMs,
      encodeMs: Math.round(encodeMs),
      videoSeconds: this.timeline(request.order).total,
      eta,
    };
    if (result.kind === 'blob') {
      const bytes = new Uint8Array(await result.blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000)
        s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { kind: 'blob', name: result.name, base64: btoa(s), plan, encoder: result.encoder, timing };
    }
    return { ...result, plan, timing };
  }
}
