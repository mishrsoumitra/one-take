/** The controller: wires microphone, detector, slides, persistence, preview and export to the views. */
import {
  defaultExportRequest,
  NO_HARDWARE,
  NO_SOFTWARE,
  normalizeExportRequest,
  planExport,
  stripExtension,
  type BrowserCapabilities,
  type CreateRecording,
  type ExportRequest,
  type RecordingSitting,
  type RecordingSummary,
  type ServerCapabilities,
  type StudioClipResult,
} from '@one-take/shared';

import { ApiClient, ApiRequestError } from '../api/client.js';
import { MicCapture, type NoiseFilterMode } from '../audio/mic.js';
import { PreviewPlayer } from '../audio/preview.js';
import { RAW_MAX_SHIFT } from '../audio/take.js';
import { faceTrack } from '../core/faces.js';
import { fmtSec, fmtTime } from '../core/format.js';
import { hashFiles, sha256Hex } from '../core/hash.js';
import { judgeSpeaker, type SpeakerVerdict } from '../core/identity.js';
import {
  boardBefore,
  InkSession,
  WIPE_MS,
  type ClipInk,
  type InkStroke,
  type PenSettings,
} from '../core/ink.js';
import {
  clampSize,
  cornerOf,
  CORNERS,
  describeLayout,
  type CameraLayout,
  type Corner,
} from '../core/overlay.js';
import { floatBlocksToInt16, int16ToFloat } from '../core/pcm.js';
import { Recorder, type BlockRange, type CaptureMode } from '../core/recorder.js';
import { cutPhrase } from '../core/silence.js';
import { ENROLL_SEC, SPEAKER_MODEL, type VoiceProfile } from '../core/speaker.js';
import { LIVE_KEEP, MicScorer } from '../core/speech.js';
import { bestLag, takeRaw, Tape } from '../core/tape.js';
import {
  buildTimeline,
  durationPerSlide,
  segmentDuration,
  totalDuration,
  type PhraseOrder,
  type Segment,
  type Timeline,
} from '../core/timeline.js';
import { withVersion, type Voicing } from '../core/versions.js';
import { VoiceDetector } from '../core/voice.js';
import { detectBrowserCapabilities } from '../export/capabilities.js';
import { InkTrack } from '../export/ink-track.js';
import { OverlayTrack } from '../export/overlay.js';
import { runExport } from '../export/runner.js';
import { planStudio, runStudio } from '../export/studio.js';
import { type FetchProgress } from '../models/fetch.js';
import { loadSlides, releaseSlides, slideSourceFromFiles } from '../slides/loader.js';
import { VoiceCheck, type VoiceResult } from '../speaker/voice-check.js';
import { ProjectStore } from '../storage/db.js';
import { unpackSegment } from '../storage/pack.js';
import {
  loadPrefs,
  recordsCamera,
  savePrefs,
  type Prefs,
  type RecordMode,
  type Theme,
} from '../storage/prefs.js';
import { loadProfile, saveProfile } from '../storage/profile.js';
import { RecordingSync, type SyncState } from '../storage/remote.js';
import { CamStage } from '../ui/cam-stage.js';
import { Choice } from '../ui/choice.js';
import { Confirm } from '../ui/confirm.js';
import { h, replaceChildren, setLabel, syncRangeFill } from '../ui/dom.js';
import { Editor } from '../ui/editor.js';
import { Enroll, type EnrollClip } from '../ui/enroll.js';
import { ExportDialog } from '../ui/export-dialog.js';
import { Filmstrip } from '../ui/filmstrip.js';
import { FolderPicker } from '../ui/folder-picker.js';
import { setButtonIcon } from '../ui/icon.js';
import { InkStage } from '../ui/ink-stage.js';
import { installKeyboard } from '../ui/keyboard.js';
import { buildLayout, type LayoutRefs } from '../ui/layout.js';
import { Library, type LibraryTab } from '../ui/library.js';
import { LevelMeter } from '../ui/meter.js';
import { PenBar } from '../ui/pen-bar.js';
import { ago, describeRecording, RecordingsPanel, savedRecordingRow } from '../ui/recordings.js';
import { TimelineList } from '../ui/timeline-list.js';
import { Toast } from '../ui/toast.js';
import { Welcome } from '../ui/welcome.js';
import { CameraCapture, type CameraState } from '../video/camera.js';
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
  /** The camera: live on the stage while it is on, recorded alongside the mic. */
  private readonly camera: CameraCapture;
  /** The camera picture over the slide on the stage, live or played back. */
  private readonly camStage: CamStage;
  /** The pen's drawings over the slide on the stage: the board while recording, the recorded strokes while playing. */
  private readonly inkStage: InkStage;
  /** The pen's toolbar on the stage, in the pen mode. */
  private readonly penBar: PenBar;
  /** The drawing being made right now, from the first pen-down until the pen has rested (see `core/ink.ts`). */
  private ink: InkSession | null = null;
  /** Fires when the pen has rested long enough to end the drawing. */
  private inkTimer = 0;
  /** Drawings finished but not yet stored (they wait their turn behind phrases under review), so the stage keeps showing them. */
  private pendingInk: { slide: number; ink: ClipInk }[] = [];
  /** Why the camera is off, when it failed to open. */
  private cameraError: string | null = null;
  /** The recorded pictures being played during a preview. */
  private previewOverlay: OverlayTrack | null = null;
  private previewPainting = false;
  private previewSerial = -1;
  /** The recorded drawings being played during a preview. */
  private previewInk: InkTrack | null = null;
  private previewInkSerial = -1;
  private readonly preview: PreviewPlayer;
  private readonly refs: LayoutRefs;
  private readonly toast: Toast;
  private readonly meter: LevelMeter;
  private readonly film: Filmstrip;
  private readonly list: TimelineList;
  private readonly exportDialog: ExportDialog;
  /** The Library: the recordings saved on this computer, and the exported videos. */
  private readonly library: Library;
  /** The Recordings tab: continue, start again, show, delete. */
  private readonly recordings: RecordingsPanel;
  /** The mirror of the project on this computer (see `storage/remote.ts`). */
  private readonly sync: RecordingSync;
  /** A question with more than one way forward (continue a recording, or start again). */
  private readonly choice: Choice;
  /** The recording on this computer this project is mirrored to, once there is one. */
  private recordingId: string | null = null;
  /**
   * The sitting the project is in: 1 when a deck is first opened, one more each time the recording
   * is opened again. Each phrase is tagged with it; `sittings` lists the ones that recorded something.
   */
  private sitting = 1;
  private sittings: RecordingSitting[] = [];
  private syncState: SyncState = { kind: 'off', reason: null };
  /** The recordings on this computer, as last listed for the empty stage. */
  private savedRecordings: RecordingSummary[] = [];
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
  /** The microphone before the filter (see `core/tape.ts`), while the mic is on and phrases may still want it. */
  private tape: Tape | null = null;
  /** The engines the user has been told about falling back, so each is said once per session. */
  private fallbackTold = false;
  private selfNoteShown = '';
  /** The start in progress, so a second Start (a double press, a held R key) joins it instead of racing it. */
  private micStarting: Promise<void> | null = null;
  /** The microphone has been opened once: the browser now tells the microphones apart by name. */
  private micOpened = false;
  /**
   * The last block came through a filter, so the tape's copy differs from the phrase and is worth
   * keeping. Read when a phrase is stored, which may be after the mic has stopped (its review was
   * still running): the mic's own engine says `off` by then, the tape is still there.
   */
  private filteredBlocks = false;
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
    this.choice = new Choice(document.body);
    this.sync = new RecordingSync(this.api, {
      onState: (state) => {
        this.syncState = state;
        this.updateSyncPill();
      },
      onLost: (id) => this.onRecordingLost(id),
    });
    this.camera = new CameraCapture({ onState: (state, error) => this.onCameraState(state, error) });
    // the drawings go under the camera picture, as in the video
    this.inkStage = new InkStage({
      stage: this.refs.stage,
      img: this.refs.slideImg,
      onStrokeStart: (x, y) => this.penDown(x, y),
      onPoint: (x, y) => this.penMove(x, y),
      onStrokeEnd: () => this.penUp(),
    });
    this.penBar = new PenBar({
      stage: this.refs.stage,
      pen: () => this.prefs.pen,
      onPen: (pen) => this.setPen(pen),
      onUndo: () => this.undoStroke(),
      onClear: () => this.clearSlide(),
    });
    this.camStage = new CamStage({
      stage: this.refs.stage,
      img: this.refs.slideImg,
      layout: () => this.prefs.cameraLayout,
      onLayout: (layout, final) => this.setCameraLayout(layout, final),
    });
    this.voiceCheck = new VoiceCheck(
      () => this.profile,
      (p) => this.onModelProgress('voice', p),
    );
    this.lips = new LipWatcher((p) => this.onModelProgress('face', p));
    // the mouth crops for the studio's voice extraction come with the lip check, a frame at a time
    this.lips.wantCrops = true;
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
      cameraLayout: () => this.prefs.cameraLayout,
      profile: () => this.profile,
      onVersion: (seg, kind, pcm) => this.keepVersion(seg.id, kind, pcm),
      onTwoVoices: (seg, result) => this.flagTwoVoices(seg.id, result),
      onOpenLibrary: () => this.library.open('exports'),
      onExportingChange: (exporting) => {
        this.store.state.exporting = exporting;
        this.syncPaused();
        this.updateButtons();
        this.syncInk();
      },
      onBeforeExport: () => {
        if (this.store.state.previewing) this.stopPreview();
        this.endInk();
        this.recorder?.end();
      },
    });
    this.recordings = new RecordingsPanel({
      api: this.api,
      serverCaps: () => this.serverCaps,
      confirm: this.confirm,
      toast: this.toast,
      currentId: () => this.recordingId,
      onContinue: (r) => void this.continueRecording(r.id),
      onStartAgain: (r) => void this.startAgain(r),
      onDeletedCurrent: (id) => this.forgetRecording(id),
    });
    this.library = new Library(document.body, {
      api: this.api,
      serverCaps: () => this.serverCaps,
      confirm: this.confirm,
      toast: this.toast,
      recordings: this.recordings,
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
      camera: () => (this.camera.on ? this.camera : null),
      cameraLayout: () => this.prefs.cameraLayout,
      onCameraLayout: (layout, final) => this.setCameraLayout(layout, final),
      studio: () => this.serverCaps?.studio ?? null,
      makeVersion: (seg, kind, onProgress) => this.makeVersion(seg, kind, onProgress),
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
    if (!CameraCapture.supported()) {
      // the option stays visible so the feature is known, with the reason it is off; the pen mode
      // still works, with the slides alone under the drawings
      this.refs.btnRecCamera.disabled = true;
      this.refs.btnRecCamera.title = 'Recording the camera needs WebCodecs: open the app in Chrome or Edge.';
      if (this.prefs.record === 'camera') this.prefs = savePrefs({ record: 'voice' });
    }
    // the mode is remembered, but the camera only opens on the user's say-so or with the mic
    this.updateRecordSwitch();
    this.syncCameraControls();
    this.syncInk();
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
      this.refs.restoreText.textContent = `Previous session found: ${segments.length} phrases, ${fmtTime(dur)} recorded${meta?.recordingId ? ', also saved on this computer' : ''}.`;
      this.refs.restore.classList.add('on');
      this.refs.saved.hidden = true;
      this.refs.btnRestore.onclick = () => {
        this.refs.restore.classList.remove('on');
        void this.restore(meta, files, segments);
      };
      this.refs.btnDiscard.onclick = () => {
        this.refs.restore.classList.remove('on');
        void this.db.clear().then(() => this.showSavedRecordings());
        if (meta?.recordingId) {
          this.toast.show('Dropped from this browser. The recording stays on this computer, under Library.');
        }
      };
    } else {
      void this.showSavedRecordings();
      // First visit with nothing to resume: explain the three steps before anything else.
      if (!this.prefs.welcomeSeen) this.openWelcome();
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
    this.updateSyncPill();
    void this.showSavedRecordings();
    return this.serverCaps;
  }

  /**
   * The server pill in the bottom bar also says how the recording on this computer stands: saved,
   * saving, or waiting for the server.
   */
  private updateSyncPill(): void {
    const pill = this.refs.serverPill;
    const caps = this.serverCaps;
    pill.classList.remove('saving', 'behind');
    if (!caps) return;
    const base = caps.ffmpeg ? 'Saves to this computer' : 'Saves to this computer · no ffmpeg';
    const state = this.syncState;
    let text = base;
    let note = '';
    if (this.recordingId) {
      switch (state.kind) {
        case 'saved':
          text = 'Recording saved on this computer';
          note = `Every phrase and the project state are mirrored to ${caps.recordingsDirectory}; this browser's copy can be dropped and the recording continued from the Library.`;
          break;
        case 'saving':
          text = `Saving to this computer (${state.pending})…`;
          pill.classList.add('saving');
          break;
        case 'waiting':
          text = `${state.pending} to save · server not answering`;
          note = `The last attempt failed (${state.reason}). The phrases wait in this browser and go up as soon as the server answers again.`;
          pill.classList.add('behind');
          break;
        case 'off':
          text = base;
          break;
      }
    } else if (state.kind === 'off' && state.reason) {
      text = `Recording not mirrored: ${state.reason}`;
      note = 'The project is kept in this browser alone; the local server could not take it.';
      pill.classList.add('behind');
    }
    this.refs.serverText.textContent = text;
    if (note) pill.title = note;
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
    r.btnSavedAll.onclick = () => this.library.open('recordings');
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
    r.btnRecVoice.onclick = () => void this.setRecordMode('voice');
    r.btnRecCamera.onclick = () => void this.setRecordMode('camera');
    r.btnRecInk.onclick = () => void this.setRecordMode('annotate');
    r.camSelect.onchange = () => {
      this.setCamera(r.camSelect.value);
      r.camSelect.blur();
    };
    r.btnVoice.onclick = () => void this.enrollVoice();
    for (const [corner, button] of Object.entries(r.camCorners) as [Corner, HTMLButtonElement][]) {
      button.onclick = () => {
        this.setCameraLayout({ ...this.prefs.cameraLayout, ...CORNERS[corner] }, true);
        button.blur();
      };
    }
    r.camSize.oninput = () => {
      this.setCameraLayout(
        { ...this.prefs.cameraLayout, size: clampSize(Number(r.camSize.value) / 100) },
        true,
      );
    };
    r.camSize.onchange = () => r.camSize.blur();
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
    window.addEventListener('pagehide', () => {
      this.flushMeta();
      this.camera.close();
    });
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
      // a phrase still on its way to the disk is kept in this browser, but the user may rather wait
      if (this.store.state.armed || this.store.state.exporting || this.sync.pending > 0) {
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
      this.choice.isOpen ||
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
    // the hash of what was picked names the deck across sittings
    const hash = await hashFiles(
      picked.kind === 'presentation' ? [picked.file] : picked.files.map((f) => f.blob),
    ).catch(() => null);
    // a recording of this deck is already on this computer: continue it, or start again on the deck
    if (hash && this.store.state.segments.length === 0 && this.serverCaps) {
      const match = await this.matchingRecording(hash);
      if (match) {
        const answer = await this.choice.ask({
          title: 'You have recorded this deck before',
          message: `${match.name}: ${describeRecording(match)}, saved ${ago(match.updatedAt)}. Continue where you left off, or start a new recording of the same deck? The earlier recording stays on this computer either way.`,
          options: [
            {
              id: 'continue',
              label: `Continue from slide ${Math.max(match.lastSlide, match.current) + 1}`,
              detail: 'The phrases so far come back and you go on from there.',
              kind: 'primary',
            },
            {
              id: 'again',
              label: 'Start a new recording',
              detail: 'From the first slide, with nothing recorded yet.',
            },
          ],
          cancel: 'Not now',
        });
        if (answer === null) return;
        if (answer === 'continue') {
          await this.continueRecording(match.id);
          return;
        }
      }
    }
    const source = picked.kind === 'presentation' ? await this.convertPresentation(picked) : picked;
    if (!source) return;
    if (hash) source.hash = hash;
    await this.loadSlideSource(source);
    await this.db.putSlideSource(source);
    this.saveMeta();
    // the mic is next: load what it will need now, after the gesture that chose the slides
    this.warmChecks();
    // and the recording on this computer begins: the deck now, the phrases as they come
    await this.openRecording(source, null);
  }

  /** The most recently worked-on recording of this deck on this computer, if any. */
  private async matchingRecording(hash: string): Promise<RecordingSummary | null> {
    try {
      const all = await this.api.listRecordings();
      this.savedRecordings = all;
      return all.find((r) => r.deckHash === hash && r.deckReady && r.id !== this.recordingId) ?? null;
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* The recording on this computer                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Mirrors the project to a new recording on this computer: the deck goes up now (or is copied
   * from `deckFrom`, another recording of the same deck), the phrases as they come. Without the
   * server the project stays in this browser alone, and the pill says so.
   */
  private async openRecording(source: SlideSource, deckFrom: string | null): Promise<void> {
    const previous = this.recordingId;
    this.sync.detach();
    this.recordingId = null;
    if (this.store.state.segments.length === 0) {
      this.sitting = 1;
      this.sittings = [];
      this.list.setSittings(this.sittings);
      // a recording with nothing in it, left behind for this one, is not worth a folder
      if (previous) void this.api.deleteRecording(previous).catch(() => undefined);
    }
    if (!this.serverCaps) {
      this.updateSyncPill();
      return;
    }
    try {
      const files = await Promise.all(
        source.files.map(async (f) => ({
          name: f.name,
          type: f.type,
          bytes: f.blob.size,
          sha256: await sha256Hex(f.blob),
        })),
      );
      const deck: CreateRecording['deck'] = {
        name: this.deckLabel(source, this.store.state.slides.length),
        kind: source.kind,
        slides: Math.max(1, this.store.state.slides.length),
        hash: source.hash ?? (await hashFiles(source.files.map((f) => f.blob))),
        files,
        origin: source.origin ?? null,
      };
      const settings = { ...this.store.settings };
      const sittings = this.sittings.length > 0 ? this.sittings : undefined;
      let rec;
      try {
        rec = await this.api.createRecording({ deck, deckFrom: deckFrom ?? undefined, settings, sittings });
      } catch (error) {
        // the other recording's deck is not this one after all: upload it instead
        if (!(error instanceof ApiRequestError && error.code === 'deck_differs')) throw error;
        rec = await this.api.createRecording({ deck, settings, sittings });
      }
      if (!rec.deckReady) {
        for (const [i, f] of source.files.entries()) {
          const sha = files[i]?.sha256;
          if (sha) await this.api.uploadRecordingDeck(rec.id, i, f.blob, sha);
        }
      }
      this.recordingId = rec.id;
      this.sync.attach(rec.id, []);
      // phrases recorded while the deck was going up, or carried over under a new deck, follow now
      for (const seg of this.store.state.segments) this.sync.putSegment(seg);
      this.saveMeta();
    } catch (error) {
      console.warn('the recording could not be started on this computer', error);
      this.sync.detach((error as Error).message);
      this.toast.show(
        `This recording is not being saved to this computer: ${(error as Error).message}. It is still kept in this browser.`,
      );
    }
    this.updateSyncPill();
  }

  /**
   * Picks the mirror up again after a reload (Resume): what the browser has that the disk lacks, or
   * holds differently, goes up; what the disk has that the browser dropped meanwhile is deleted.
   * A recording whose folder is gone, or a project from before recordings existed, gets a new one.
   */
  private async reattachRecording(id: string | null): Promise<void> {
    if (!this.serverCaps) {
      this.recordingId = id;
      this.updateSyncPill();
      return;
    }
    if (id) {
      try {
        const rec = await this.api.getRecording(id);
        this.recordingId = id;
        this.sync.attach(id, rec.phrases);
        const onDisk = new Map(rec.phrases.map((p) => [p.id, p]));
        for (const seg of this.store.state.segments) {
          const there = onDisk.get(seg.id);
          // the file's hash is only known once it is packed; the manifest's few facts catch most
          // changes made while the server was away (a cut, a move, a re-record), and a phrase that
          // changed in some other way goes up with its next change
          const same =
            there?.slide === seg.slide &&
            Math.abs(there.seconds - segmentDuration(seg)) < 1e-6 &&
            there.camera === Boolean(seg.video) &&
            there.kind === (seg.ink ? 'ink' : 'voice');
          if (!same) this.sync.putSegment(seg);
        }
        const here = new Set(this.store.state.segments.map((seg) => seg.id));
        for (const p of rec.phrases) if (!here.has(p.id)) this.sync.deleteSegment(p.id);
        this.saveMeta();
        this.updateSyncPill();
        return;
      } catch (error) {
        if (!(error instanceof ApiRequestError && error.status === 404)) {
          this.recordingId = id;
          this.sync.detach((error as Error).message);
          this.toast.show(`The recording on this computer could not be reached: ${(error as Error).message}`);
          return;
        }
        this.toast.show('The recording’s folder is gone from this computer; a new one is being made.');
      }
    }
    const source = this.store.state.slideSource;
    if (source) await this.openRecording(source, null);
  }

  /** The recording's folder was deleted on disk while this project was open: a new one takes over. */
  private onRecordingLost(id: string): void {
    if (this.recordingId !== id) return;
    this.recordingId = null;
    this.updateSyncPill();
    const source = this.store.state.slideSource;
    this.toast.show('The recording’s folder is gone from this computer; a new one is being made.');
    if (source) void this.openRecording(source, null);
  }

  /** The recording open in the app was deleted from the Library: this browser lets go of it too. */
  private forgetRecording(id: string): void {
    if (this.recordingId !== id) return;
    this.sync.detach();
    this.recordingId = null;
    void this.clearProject();
  }

  /** The first phrase of a sitting registers it, with the slide it began on. */
  private ensureSitting(slide: number): void {
    if (this.sittings.some((x) => x.n === this.sitting)) return;
    this.sittings.push({ n: this.sitting, startedAt: new Date().toISOString(), fromSlide: slide });
    this.list.setSittings(this.sittings);
  }

  /**
   * The recordings saved on this computer, on the empty stage, so one can be continued with a
   * click. Hidden while a deck is loaded, while the browser has its own session to resume, and
   * without the server.
   */
  private async showSavedRecordings(): Promise<void> {
    const r = this.refs;
    const busy = () => this.store.state.slides.length > 0 || r.restore.classList.contains('on');
    if (!this.serverCaps || busy()) {
      r.saved.hidden = true;
      return;
    }
    try {
      this.savedRecordings = await this.api.listRecordings();
    } catch {
      this.savedRecordings = [];
    }
    const ready = this.savedRecordings.filter((x) => x.deckReady && x.phrases > 0);
    r.saved.hidden = ready.length === 0 || busy();
    replaceChildren(
      r.savedList,
      ...ready.slice(0, 3).map((x) =>
        savedRecordingRow(x, {
          onContinue: (rec) => void this.continueRecording(rec.id),
          onStartAgain: (rec) => void this.startAgain(rec),
        }),
      ),
    );
  }

  /**
   * Continues a recording from this computer: the deck (unless the same one is loaded), every
   * phrase, and where it was left. The browser's copy, if any, is replaced; a new sitting begins.
   */
  async continueRecording(id: string): Promise<void> {
    const s = this.store.state;
    if (s.exporting) return;
    if (s.armed) this.stopMic();
    if (s.previewing) this.stopPreview();
    this.welcome.close();
    this.library.close();
    this.showLoading('Loading the recording…');
    try {
      // what this browser holds of another recording is on its way to the disk: let it land first
      this.flushMeta();
      if (this.recordingId && this.recordingId !== id && this.sync.pending > 0) {
        this.refs.loadingText.textContent = 'Saving the last phrases first…';
        await this.sync.flush();
      }
      const rec = await this.api.getRecording(id);
      if (!rec.deckReady) throw new Error('its deck did not finish uploading; load the deck file instead');
      let source = s.slideSource;
      if (source?.hash !== rec.deck.hash || source.files.length !== rec.deck.files.length) {
        const files: SlideSource['files'] = [];
        for (const [i, f] of rec.deck.files.entries()) {
          this.refs.loadingText.textContent = `Loading the deck (${i + 1} of ${rec.deck.files.length})…`;
          files.push({ name: f.name, type: f.type, blob: await this.api.fetchRecordingDeck(id, i) });
        }
        source = { kind: rec.deck.kind, files, hash: rec.deck.hash };
        if (rec.deck.origin) source.origin = rec.deck.origin;
      }
      const segments: Segment[] = [];
      for (const [i, p] of rec.phrases.entries()) {
        this.refs.loadingText.textContent = `Loading phrase ${i + 1} of ${rec.phrases.length}…`;
        const bytes = await this.api.fetchRecordingPhrase(id, p.id);
        if ((await sha256Hex(bytes)) !== p.sha256) {
          throw new Error(`phrase ${i + 1} on disk does not match its hash; the file may be damaged`);
        }
        const seg = unpackSegment(bytes);
        segments.push(seg.id === p.id ? seg : { ...seg, id: p.id });
      }
      // the browser's copy gives way to the one on disk
      this.sync.detach();
      this.recordingId = null;
      await this.db.clear();
      await this.db.putSlideSource(source);
      for (const seg of segments) await this.db.putSegment(seg);
      this.exportRequest = normalizeExportRequest(
        rec.exportRequest ?? this.exportRequest,
        this.serverCaps?.defaultDirectory ?? null,
      );
      const meta: ProjectMeta = {
        order: rec.phrases.map((p) => p.id),
        current: rec.current,
        settings: rec.settings,
        savedAt: Date.now(),
        segmentCounter: rec.counter,
        exportRequest: this.exportRequest,
        recordingId: id,
        sitting: rec.sitting,
        sittings: rec.sittings,
      };
      await this.db.putMeta(meta);
      s.segments = [];
      s.deleted = [];
      this.pendingInk = [];
      this.hideLoading();
      await this.restore(meta, source, segments);
    } catch (error) {
      console.error(error);
      this.toast.show(`Could not continue the recording: ${(error as Error).message}`);
    } finally {
      this.hideLoading();
    }
  }

  /**
   * A new recording of the same deck, from the first slide. What this browser holds stays on this
   * computer as the recording it was (its last phrases are sent first), then gives way.
   */
  async startAgain(r: RecordingSummary): Promise<void> {
    const s = this.store.state;
    if (s.exporting) return;
    if (s.segments.length > 0) {
      const ok = await this.confirm.ask({
        title: 'Start a new recording?',
        message: `The ${s.segments.length === 1 ? 'phrase' : `${s.segments.length} phrases`} in this browser (${fmtTime(totalDuration(s.segments))}) ${this.recordingId ? 'stay on this computer as the recording they belong to, and leave this browser' : 'leave this browser and cannot be brought back'}. The new recording starts on slide 1 of ${r.name}.`,
        confirm: 'Start again',
        cancel: 'Keep working',
      });
      if (!ok) return;
    }
    if (s.armed) this.stopMic();
    if (s.previewing) this.stopPreview();
    this.welcome.close();
    this.library.close();
    this.showLoading('Starting a new recording…');
    try {
      this.flushMeta();
      if (this.recordingId && this.sync.pending > 0) {
        this.refs.loadingText.textContent = 'Saving the last phrases first…';
        await this.sync.flush();
      }
      let source = s.slideSource;
      if (source?.hash !== r.deckHash) {
        const rec = await this.api.getRecording(r.id);
        const files: SlideSource['files'] = [];
        for (const [i, f] of rec.deck.files.entries()) {
          this.refs.loadingText.textContent = `Loading the deck (${i + 1} of ${rec.deck.files.length})…`;
          files.push({ name: f.name, type: f.type, blob: await this.api.fetchRecordingDeck(r.id, i) });
        }
        source = { kind: rec.deck.kind, files, hash: rec.deck.hash };
        if (rec.deck.origin) source.origin = rec.deck.origin;
      }
      this.sync.detach();
      this.recordingId = null;
      await this.db.clear();
      this.endInk();
      s.segments = [];
      s.deleted = [];
      s.current = 0;
      this.pendingInk = [];
      if (source !== s.slideSource) await this.loadSlideSource(source);
      else this.showSlide(0);
      await this.db.putSlideSource(source);
      this.list.render(s.segments, s.slides, false);
      this.updateSlideStats();
      this.updateButtons();
      this.syncInk();
      this.hideLoading();
      await this.openRecording(source, r.id);
      this.saveMeta();
      this.toast.show(`A new recording of ${r.name}. The earlier one stays under Library › Recordings.`);
    } catch (error) {
      console.error(error);
      this.toast.show(`Could not start again: ${(error as Error).message}`);
    } finally {
      this.hideLoading();
    }
  }

  /**
   * Loads what Start mic would otherwise load on the spot: the deep noise filter and, for a learned
   * voice, the voice model. Each takes about a second the first time; loaded here (when the slides
   * are chosen, the camera opens, or a session is resumed, all user gestures, so the audio context
   * may run), the first phrase gets the deep filter and the voice check from its first block instead
   * of the classic filter and no verdict for a second. Idempotent: each load happens once and is kept.
   */
  private warmChecks(): void {
    void this.mic.warm(this.prefs.noiseFilter);
    if (this.prefs.voiceCheck && this.profile) void this.voiceCheck.start();
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
    this.syncInk();
  }

  goTo(index: number): void {
    const s = this.store.state;
    if (s.previewing) return;
    if (index === s.current || index < 0 || index >= s.slides.length) return;
    // A drawing in progress ends here and stays on the slide being left.
    this.endInk();
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
      if (this.camera.on) {
        return 'Camera on. Drag the picture to where you want it on the slide, or pick a corner and a size below. Then Start mic.';
      }
      return hold
        ? 'Step 2 · Click Start mic (or press R). Then hold Space, or the button on the stage, while you talk.'
        : 'Step 2 · Click Start mic (or press R), then just talk. Pauses are cut out automatically.';
    }
    if (s.muted) return 'Muted. Press M or click Unmute to continue recording.';
    if (this.ink) {
      return 'Drawing. The mic hears nothing while the pen is on the slide. Rest the pen for a second, or speak, and the drawing is kept as a clip.';
    }
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
      return this.prefs.record === 'annotate'
        ? 'Listening. Speak whenever you are ready, or draw on the slide with the pen: the strokes go into the video just as you make them.'
        : 'Listening. Speak whenever you are ready. Your voice should push the meter below past the white line.';
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

  /** Fills the camera picker the same way; "Off" (no lip check) stays whatever is plugged in. */
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

  /**
   * Picks the camera, or turns the lip check off; takes effect at once while the mic is on. The
   * camera being recorded (the switch next to the picker) follows the chosen device and keeps
   * going when the lip check is turned off.
   */
  setCamera(value: string): void {
    const on = value !== 'off';
    const before = this.prefs.cameraDeviceId;
    this.prefs = savePrefs({ lipCheck: on, cameraDeviceId: on ? value : this.prefs.cameraDeviceId });
    this.refs.camSelect.value = value;
    const reopen = on && value !== before && this.camera.state !== 'off';
    if (reopen) void this.openCamera();
    if (!this.store.state.armed) return;
    if (!on) {
      this.lips.stop();
      this.updateSelfView();
    } else if (!reopen) {
      void this.watchLips(); // else the camera's state callback restarts the lip check on the new device
    }
  }

  /**
   * Opens the camera and starts the lip check; says why when it cannot. A camera already open to
   * be recorded lends the lip check its track, so the device is opened once for both.
   */
  private async watchLips(): Promise<void> {
    const shared = this.camera.on ? (this.camera.liveStream?.getVideoTracks()[0] ?? null) : null;
    const ok = await this.lips.start(this.prefs.cameraDeviceId || undefined, shared);
    if (!this.store.state.armed) {
      this.lips.stop();
    } else if (!ok && this.lips.note) {
      this.toast.show(`The lip check is off: ${this.lips.note}`);
    }
    this.updateSelfView();
  }

  /**
   * Shows the camera in the corner of the stage while it is watched, and what it sees under it; not
   * while the stage already shows the camera picture where it goes in the video (the lip check's
   * note moves to the camera row then).
   */
  private updateSelfView(): void {
    const video = this.store.state.armed && !this.camStage.shown ? this.lips.video : null;
    this.refs.selfBox.hidden = video === null;
    if (this.refs.selfView.srcObject !== video) this.refs.selfView.srcObject = video;
    this.selfNoteShown = '';
    this.updateSelfNote();
  }

  /**
   * One line on what the lip check sees (a face in view, the lips moving): under the self-view, or
   * in the camera row while the stage shows the camera picture instead.
   */
  private updateSelfNote(): void {
    const r = this.refs;
    const inRow = r.selfBox.hidden && this.store.state.armed && this.prefs.lipCheck && !r.camRow.hidden;
    if (r.camLips.hidden === inRow) r.camLips.hidden = !inRow;
    if (r.selfBox.hidden && !inRow) return;
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
    const shown = `${inRow}|${kind}|${text}`;
    if (shown === this.selfNoteShown) return;
    this.selfNoteShown = shown;
    const note = inRow ? r.camLips : r.selfNote;
    note.textContent = text;
    note.className = `note${kind ? ` ${kind}` : ''}`;
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
      // skipped with nothing learned: not asked again; "Learn my voice" in the bottom bar is the way back.
      // The model began loading when the dialog opened; it is not wanted now, so it stops rather than
      // going on loading under the recording that follows
      this.voiceCheck.stop();
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
      this.persistSegment(seg);
      this.list.render(this.store.state.segments, this.store.state.slides, false);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Camera                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * The record switch. With the camera: it opens at once, so the picture can be framed and placed
   * before recording, and is recorded whenever the mic is on. With the pen: the toolbar appears, and
   * the slide takes the pen while the mic is on. Voice alone: the camera closes. Phrases already
   * recorded keep their pictures and drawings whatever is chosen.
   */
  async setRecordMode(mode: RecordMode): Promise<void> {
    const before = this.prefs.record;
    if (mode === 'camera' && !CameraCapture.supported()) mode = 'voice';
    this.prefs = savePrefs({ record: mode });
    this.updateRecordSwitch();
    this.syncCameraControls();
    // a drawing in progress is kept as it is when the pen is put away
    if (before === 'annotate' && mode !== 'annotate') this.endInk();
    this.syncInk();
    this.updateCoach();
    if (recordsCamera(mode)) {
      if (this.camera.state === 'off' || this.camera.state === 'error') await this.openCamera();
    } else {
      this.camera.close();
    }
  }

  private updateRecordSwitch(): void {
    const mode = this.prefs.record;
    this.refs.btnRecVoice.setAttribute('aria-checked', String(mode === 'voice'));
    this.refs.btnRecCamera.setAttribute('aria-checked', String(mode === 'camera'));
    this.refs.btnRecInk.setAttribute('aria-checked', String(mode === 'annotate'));
  }

  /** Opens (or reopens, after a device change) the chosen camera; the state callback does the rest. */
  private async openCamera(): Promise<boolean> {
    if (!CameraCapture.supported()) return false;
    const ok = await this.camera.open(this.prefs.cameraDeviceId || undefined, this.camStage.video);
    void this.listCameras();
    return ok;
  }

  private onCameraState(state: CameraState, error?: string): void {
    this.cameraError = state === 'error' ? (error ?? 'The camera could not be opened.') : null;
    if (state === 'on') {
      // switched on while the mic is already running: phrases from here on get a picture
      if (this.store.state.armed && this.recorder) this.camera.record(BLOCK_MS);
      // the checks' one-time loads need not wait for Start mic
      this.warmChecks();
    } else if (state === 'error') {
      this.toast.show(error ?? 'The camera could not be opened.');
      // the camera mode falls back to the voice alone; the pen mode keeps the pen and goes on without a picture
      if (this.prefs.record === 'camera') {
        this.prefs = savePrefs({ record: 'voice' });
        this.updateRecordSwitch();
      }
    }
    // the lip check watches the same camera: a clone of its track once it is open, its own stream otherwise
    if (
      this.store.state.armed &&
      this.prefs.lipCheck &&
      (state === 'on' || state === 'error') &&
      this.lips.shared !== (state === 'on')
    ) {
      void this.watchLips();
    }
    this.syncCamStage();
    this.syncCameraControls();
    this.updateCoach();
  }

  /** The stage shows the live camera while it is on, unless a preview is playing recorded pictures. */
  private syncCamStage(): void {
    if (this.store.state.previewing && this.previewOverlay) return;
    const stream = this.camera.liveStream;
    if (this.camera.on && stream) this.camStage.showLive(stream, this.camera.aspect);
    else this.camStage.hide();
    this.updateSelfView();
  }

  /** Where the picture goes and how big it is; saved when the change is final (a drag that ended, a click). */
  setCameraLayout(layout: CameraLayout, final: boolean): void {
    const next = { x: layout.x, y: layout.y, size: clampSize(layout.size) };
    if (final) this.prefs = savePrefs({ cameraLayout: next });
    else this.prefs = { ...this.prefs, cameraLayout: next };
    this.syncCameraControls();
    this.camStage.relayout();
    this.editor.relayoutCamera();
  }

  /** The camera row: shown while the camera is recorded; the corner buttons, the slider and the note follow the state. */
  private syncCameraControls(): void {
    const r = this.refs;
    const layout = this.prefs.cameraLayout;
    r.camRow.hidden = !recordsCamera(this.prefs.record);
    const corner = cornerOf(layout);
    for (const [name, button] of Object.entries(r.camCorners) as [Corner, HTMLButtonElement][]) {
      button.setAttribute('aria-pressed', String(name === corner));
    }
    const pct = Math.round(layout.size * 100);
    if (Number(r.camSize.value) !== pct) r.camSize.value = String(pct);
    r.camSizeV.textContent = `${pct} %`;
    syncRangeFill(r.camSize);
    let note = '';
    switch (this.camera.state) {
      case 'opening':
        note = 'Opening the camera…';
        break;
      case 'on':
        note = `${this.camera.info?.label ?? 'Camera'} · ${describeLayout(layout)}`;
        break;
      case 'error':
        // in the pen mode the drawings go on without a picture; say why there is none
        note = this.cameraError ? `Camera off · ${this.cameraError}` : '';
        break;
      case 'off':
        break;
    }
    r.camNote.textContent = note;
    r.camNote.title = note;
    r.camNote.classList.toggle('err', this.camera.state === 'error');
  }

  /* ------------------------------------------------------------------ */
  /* The pen: drawings on the slide                                      */
  /* ------------------------------------------------------------------ */

  /**
   * The pen touched the slide at (x, y), fractions of the slide. In the pen mode with the mic on it
   * starts a stroke: the first stroke opens a drawing, and from here until the pen rests the mic
   * hears nothing (the phrase being spoken ends where it is). False refuses the stroke.
   */
  private penDown(x: number, y: number): boolean {
    const s = this.store.state;
    const recorder = this.recorder;
    if (!s.armed || s.previewing || s.exporting || this.prefs.record !== 'annotate' || !recorder)
      return false;
    const now = performance.now();
    if (!this.ink) {
      this.ink = new InkSession(now, s.current);
      s.inking = true;
      this.refs.capFlagText.textContent = 'DRAWING';
    }
    clearTimeout(this.inkTimer);
    recorder.setInking(true);
    this.ink.strokeStart(now, this.prefs.pen, x, y);
    this.syncInk();
    this.updateStatus();
    return true;
  }

  private penMove(x: number, y: number): void {
    if (this.ink?.point(performance.now(), x, y)) this.inkStage.show(this.liveBoard());
  }

  /** The pen left the slide: the stroke is done, the mic may listen again, and the rest begins. */
  private penUp(): void {
    const ink = this.ink;
    if (!ink?.down) return;
    ink.strokeEnd(performance.now());
    this.recorder?.setInking(false);
    this.syncInk();
    this.armInkRest();
  }

  /** Ends the drawing once the pen has rested for `INK_REST_MS`, unless a stroke or a voice comes first. */
  private armInkRest(): void {
    clearTimeout(this.inkTimer);
    const ink = this.ink;
    const at = ink?.restEndsAt ?? null;
    if (!ink || at === null) return;
    this.inkTimer = window.setTimeout(
      () => {
        if (this.ink === ink && ink.rested(performance.now())) this.endInk();
      },
      Math.max(0, at - performance.now()) + 5,
    );
  }

  /**
   * The drawing is over (the pen rested, a voice began, the slide changed, the mic stopped, the pen
   * was put away): it becomes a clip, stored in its turn behind any phrase still under review.
   */
  private endInk(): void {
    const ink = this.ink;
    if (!ink) return;
    clearTimeout(this.inkTimer);
    this.ink = null;
    this.store.state.inking = false;
    this.recorder?.setInking(false);
    const finished = ink.finish(performance.now());
    if (finished) this.storeInk(ink.slide, finished.ink, finished.durationMs);
    this.syncInk();
    this.updateStatus();
  }

  /** Drops the drawing being made (the speaker changed their mind); false when there is none. */
  private discardInk(): boolean {
    const ink = this.ink;
    if (!ink) return false;
    clearTimeout(this.inkTimer);
    this.ink = null;
    this.store.state.inking = false;
    this.recorder?.setInking(false);
    this.syncInk();
    this.updateStatus();
    return true;
  }

  /** Queues a drawing (or a wipe) as a clip on `slide`, after the phrases finished before it. */
  private storeInk(slide: number, ink: ClipInk, durationMs: number): void {
    const pending = { slide, ink };
    this.pendingInk.push(pending);
    const store = () => {
      const k = this.pendingInk.indexOf(pending);
      if (k >= 0) this.pendingInk.splice(k, 1);
      this.addInkSegment(slide, ink, durationMs);
    };
    if (this.recorder) void this.recorder.after(store);
    else store();
  }

  /** A drawing as a clip: silence for the time it took, with the strokes to draw over it. */
  private addInkSegment(slide: number, ink: ClipInk, durationMs: number): Segment {
    this.ensureSitting(slide);
    const seg: Segment = {
      id: this.nextSegmentId(),
      slide,
      sampleRate: this.sampleRate,
      pcm: new Int16Array(Math.max(1, Math.round((durationMs / 1000) * this.sampleRate))),
      joined: false,
      prevId: null,
      createdAt: Date.now(),
      sitting: this.sitting,
      video: null,
      ink,
    };
    this.store.state.segments.push(seg);
    this.persistSegment(seg);
    this.saveMeta();
    this.list.render(this.store.state.segments, this.store.state.slides, true);
    this.updateSlideStats();
    this.updateButtons();
    this.syncInk();
    return seg;
  }

  /** The strokes on the current slide as they stand: stored, waiting to be stored, and being drawn. */
  private liveBoard(): InkStroke[] {
    const s = this.store.state;
    const all: Pick<Segment, 'slide' | 'ink'>[] = [...s.segments, ...this.pendingInk];
    const board = boardBefore(all, all.length, s.current);
    return this.ink?.slide === s.current ? board.concat(this.ink.all) : board;
  }

  /**
   * The stage's drawing layer and the pen's toolbar: the board of the current slide with the drawing
   * in progress, drawable in the pen mode while the mic is on; the toolbar in the pen mode.
   */
  private syncInk(): void {
    const s = this.store.state;
    // the preview paints the recorded strokes itself
    if (s.previewing && this.previewInk) return;
    const pen = this.prefs.record === 'annotate' && s.slides.length > 0;
    const enabled = pen && s.armed && !s.exporting && !s.previewing;
    this.inkStage.setDrawable(enabled);
    const board = this.liveBoard();
    this.inkStage.show(board);
    this.penBar.show(pen);
    this.penBar.render({
      canUndo: (this.ink?.strokeCount ?? 0) > 0,
      canClear: board.length > 0,
      enabled,
    });
  }

  /** The pen's tool, colour or width changed; remembered for next time. */
  setPen(pen: PenSettings): void {
    this.prefs = savePrefs({ pen });
    this.syncInk();
  }

  /** Takes back the last stroke of the drawing being made. */
  undoStroke(): void {
    const ink = this.ink;
    if (!ink?.undoStroke(performance.now())) {
      this.toast.show('Nothing to take back: a stroke can be undone while the drawing is being made.');
      return;
    }
    // nothing left of the drawing: the mic may listen again at once
    if (ink.strokeCount === 0 && !ink.down) this.discardInk();
    else if (!ink.down) this.armInkRest();
    this.syncInk();
  }

  /**
   * Clears the slide as a step in the recording: the drawing in progress is kept, then a wipe takes
   * everything on the slide away. A sentence being spoken is split there, so its first part still
   * shows the drawings and the rest shows the clean slide.
   */
  clearSlide(): void {
    const s = this.store.state;
    if (!s.armed || this.prefs.record !== 'annotate' || !this.recorder) {
      this.toast.show('Start the mic to clear the slide as part of the recording.');
      return;
    }
    if (this.liveBoard().length === 0) {
      this.toast.show('Nothing to clear on this slide.');
      return;
    }
    this.endInk();
    this.recorder.splitPhrase();
    this.storeInk(s.current, { wipe: true, strokes: [] }, WIPE_MS);
    this.syncInk();
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
          const seg = this.addSegment(
            phrase.blocks,
            phrase.slide,
            phrase.joined,
            phrase.prevId,
            true,
            phrase.at,
          );
          this.judgePiece(seg, phrase.key, phrase.at);
          return seg.id;
        },
        onSpeakingChange: (speaking, key) => {
          this.store.state.speaking = speaking;
          if (speaking) {
            // a voice while the pen rests: the drawing is over and the phrase follows it
            this.endInk();
            this.refs.capFlagText.textContent = 'RECORDING';
            this.phraseStarted(key);
          } else {
            this.phraseEnded(key);
          }
          this.updateStatus();
        },
      },
    );
    // the camera first, so the first phrase has its picture too; a camera that fails is reported and left off
    if (recordsCamera(this.prefs.record) && this.camera.state === 'off') await this.openCamera();
    this.tape = null;
    try {
      const info = await this.mic.start({
        deviceId: this.refs.micSelect.value || undefined,
        noiseFilter: this.prefs.noiseFilter,
        blockMs: BLOCK_MS,
        onBlock: (block) => this.onBlock(block),
        // the same blocks before any filter: each phrase takes its stretch of the tape
        onRawBlock: (block) => {
          this.tape ??= new Tape(block.length);
          this.tape.push(block);
        },
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
    if (this.camera.on) this.camera.record(BLOCK_MS);
    this.clock = null;
    this.feeding = null;
    s.armed = true;
    s.muted = false;
    s.held = false;
    s.speaking = false;
    this.syncPaused();
    this.updateStatus();
    this.updateButtons();
    this.syncInk();
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
    // a drawing in progress is kept, in its turn behind the phrases still under review
    this.endInk();
    const recorder = this.recorder;
    recorder?.end();
    this.mic.stop();
    // the camera takes no more frames; what it holds stays until the last phrase has its picture
    this.camera.pause();
    // phrases still being reviewed are stored as the reviews come back, and take their raw stretch
    // off the tape, so the tape goes only once they are all in
    if (recorder) this.settling = this.settling.then(() => recorder.settled());
    const tape = this.tape;
    void this.settling.then(() => {
      if (!this.store.state.armed) this.camera.stopRecording();
      if (!this.store.state.armed && this.tape === tape) this.tape = null;
    });
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
    this.syncInk();
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
    this.filteredBlocks = this.mic.engine !== 'off';
    const scorer = this.scorer;
    scorer?.push(block, this.sampleRate);
    recorder.process(block, scorer?.prob ?? null);
    const { vad } = recorder;
    // the camera, the tape and the film run on the mic's clock: this many blocks so far, and nothing
    // before the earliest pending phrase (less the pre-roll a phrase about to start would reach back
    // for) is needed
    const keepFrom = recorder.heldFrom - this.store.settings.prerollMs / BLOCK_MS - 50;
    if (this.camera.recording) this.camera.tick(vad.seen, keepFrom);
    this.tape?.prune(keepFrom);
    this.clock = { at: performance.timeOrigin + performance.now(), seen: vad.seen };
    if (vad.seen % 100 === 0) {
      const span = this.spanOf({ from: keepFrom, to: keepFrom });
      if (span) this.lips.film.prune(span.from - 1000);
    }
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
    at: BlockRange,
  ): Segment {
    this.ensureSitting(slide);
    const seg: Segment = {
      id: this.nextSegmentId(),
      slide,
      sampleRate: this.sampleRate,
      pcm: floatBlocksToInt16(blocks),
      joined,
      prevId,
      createdAt: Date.now(),
      sitting: this.sitting,
      // the camera's picture for exactly these blocks, when it was on
      video: this.camera.recording ? this.camera.take(at.from * BLOCK_MS, at.to * BLOCK_MS) : null,
    };
    // the same blocks off the tape, as the microphone heard them, and the film of the mouth over them
    const raw = this.rawOf(blocks, at);
    if (raw) seg.raw = raw;
    const faces = this.facesOf(at);
    if (faces) seg.faces = faces;
    this.store.state.segments.push(seg);
    this.persistSegment(seg);
    this.saveMeta();
    this.list.render(this.store.state.segments, this.store.state.slides, scroll);
    this.updateSlideStats();
    this.updateButtons();
    this.syncInk();
    return seg;
  }

  /** The phrase as the microphone heard it, from the tape, lined up with the filtered blocks; null with no filter on. */
  private rawOf(blocks: readonly Float32Array[], at: BlockRange): Int16Array | null {
    const tape = this.tape;
    if (!tape || !this.filteredBlocks) return null;
    let n = 0;
    for (const b of blocks) n += b.length;
    const filtered = new Float32Array(n);
    let k = 0;
    for (const b of blocks) {
      filtered.set(b, k);
      k += b.length;
    }
    const { samples, lag } = takeRaw(
      tape,
      filtered,
      at,
      this.mic.delaySamples,
      RAW_MAX_SHIFT,
      this.sampleRate,
    );
    if (lag.peak < 0.3) {
      console.info(
        `raw tape: no clear match for this phrase (correlation ${lag.peak.toFixed(2)}); the nominal delay was used`,
      );
    }
    return floatBlocksToInt16([samples]);
  }

  /** The film of the speaker's mouth over the phrase, when the lip check saw it. */
  private facesOf(at: BlockRange) {
    const span = this.spanOf(at);
    if (!span || this.lips.state !== 'watching') return null;
    const frames = this.lips.film.between(span.from, span.to);
    return frames ? faceTrack(frames) : null;
  }

  /** Puts a changed phrase (a new object with the same id) in place of the old one and saves it. */
  private replaceSegment(next: Segment): boolean {
    const s = this.store.state;
    const index = s.segments.findIndex((seg) => seg.id === next.id);
    if (index < 0) return false;
    s.segments[index] = next;
    this.persistSegment(next);
    this.list.render(s.segments, s.slides, false);
    return true;
  }

  /** Writes a phrase to this browser's store and queues it for the recording on this computer. */
  private persistSegment(seg: Segment): void {
    void this.db.putSegment(seg);
    this.sync.putSegment(seg);
  }

  /** Removes a phrase from this browser's store and from the recording on this computer. */
  private forgetSegment(id: string): void {
    void this.db.deleteSegment(id);
    this.sync.deleteSegment(id);
  }

  /** A version from the studio landed for a phrase: kept with it, so it plays and exports from now on. */
  keepVersion(id: string, kind: 'deep' | 'voice', pcm: Int16Array): void {
    const seg = this.store.state.segments.find((x) => x.id === id);
    if (seg?.pcm.length !== pcm.length) return;
    this.replaceSegment(withVersion(seg, kind, pcm));
  }

  /** Which version a phrase plays and exports. */
  setChoice(id: string, choice: Voicing): void {
    const seg = this.store.state.segments.find((x) => x.id === id);
    if (!seg || seg.choice === choice) return;
    this.replaceSegment({ ...seg, choice });
  }

  /** The studio measured two voices talking at once in a phrase: it is marked, so the flagged list shows it. */
  flagTwoVoices(id: string, result: StudioClipResult): void {
    const seg = this.store.state.segments.find((x) => x.id === id);
    if (!seg || seg.speaker?.verdict === 'other') return;
    const reason = `Two voices overlap (another voice in ${Math.round((result.otherShare ?? 0) * 100)} % of it)`;
    if (seg.speaker?.reasons.includes(reason)) return;
    const speaker: SpeakerVerdict = {
      verdict: 'unsure',
      similarity: seg.speaker?.similarity ?? null,
      lips: seg.speaker?.lips ?? null,
      reasons: [...(seg.speaker?.reasons ?? []), reason],
    };
    this.replaceSegment({ ...seg, speaker });
  }

  /**
   * Has the studio make one version of one phrase (the editor's buttons): the deep clean, or only the
   * speaker's voice. Resolves with the phrase carrying the new version; the editor puts it in place.
   */
  async makeVersion(
    seg: Segment,
    kind: 'deep' | 'voice',
    onProgress: (message: string) => void,
  ): Promise<Segment> {
    const info = this.serverCaps?.studio ?? null;
    if (!this.serverCaps) throw new Error('the local server is not running (npm start)');
    const plan = planStudio([kind === 'voice' ? { ...seg, choice: 'voice' } : seg], {
      settings: { denoise: kind === 'deep', voice: kind === 'voice', findOverlap: false },
      info,
      redo: true,
    });
    if (plan.clips.length === 0) throw new Error(info?.note ?? 'the studio is not set up (npm run studio)');
    const landed: { pcm: Int16Array | null } = { pcm: null };
    const outcome = await runStudio({
      api: this.api,
      plan,
      profile: this.profile,
      signal: new AbortController().signal,
      onProgress: (job) => {
        const p = job.progress;
        onProgress(`${p.message}${p.fraction !== null ? ` ${Math.round(p.fraction * 100)} %` : ''}`);
      },
      onResult: (_seg, made, pcm) => {
        if (made === kind) landed.pcm = pcm;
      },
    });
    if (!landed.pcm) {
      const why =
        outcome.failed[0]?.error ?? (outcome.stopped ? 'the studio was stopped' : 'nothing came back');
      throw new Error(why);
    }
    return withVersion(seg, kind, landed.pcm);
  }

  deleteSegment(index: number): void {
    const s = this.store.state;
    const seg = s.segments[index];
    if (!seg) return;
    s.segments.splice(index, 1);
    this.forgetSegment(seg.id);
    s.deleted.push({ seg, index });
    this.saveMeta();
    this.list.render(s.segments, s.slides, false);
    this.updateSlideStats();
    this.updateButtons();
    this.syncInk();
    this.toast.show(
      `Removed ${seg.ink ? 'drawing' : 'phrase'} ${index + 1} (${fmtSec(segmentDuration(seg))}, slide ${seg.slide + 1})`,
      {
        label: 'Undo',
        run: () => this.undoDelete(),
      },
    );
  }

  deleteLast(): void {
    const s = this.store.state;
    // the drawing being made is not stored yet either
    if (this.discardInk()) {
      this.toast.show('Dropped the drawing you were making. Go again.');
      return;
    }
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
    // while a drawing is being made, undo takes back its last stroke
    if ((this.ink?.strokeCount ?? 0) > 0) {
      this.undoStroke();
      return;
    }
    const d = s.deleted.pop();
    if (!d) return;
    s.segments.splice(Math.min(d.index, s.segments.length), 0, d.seg);
    this.persistSegment(d.seg);
    this.saveMeta();
    this.list.render(s.segments, s.slides, false);
    this.updateSlideStats();
    this.updateButtons();
    this.syncInk();
  }

  moveSegment(from: number, to: number): void {
    const s = this.store.state;
    const [seg] = s.segments.splice(from, 1);
    if (!seg) return;
    s.segments.splice(to, 0, seg);
    this.saveMeta();
    this.list.render(s.segments, s.slides, false);
    this.syncInk();
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
    for (const id of before.keys()) if (!after.has(id)) this.forgetSegment(id);
    for (const [id, seg] of after) {
      if (before.get(id) === seg) continue;
      // a clip the editor made (a take, a split, a join) belongs to this sitting
      const tagged = seg.sitting === undefined && !before.has(id) ? { ...seg, sitting: this.sitting } : seg;
      if (tagged !== seg) {
        const k = next.indexOf(seg);
        if (k >= 0) next[k] = tagged;
      }
      this.persistSegment(tagged);
    }
    if (next.some((seg) => seg.sitting === this.sitting)) this.ensureSitting(this.store.state.current);
    s.segments = next.slice();
    this.saveMeta();
    this.list.render(s.segments, s.slides, false);
    this.updateSlideStats();
    this.updateButtons();
    this.syncInk();
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
    } else if (s.inking) {
      pill.classList.add('ink');
      text = 'Drawing';
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
    this.refs.capFlag.classList.toggle(
      'on',
      s.armed && (s.speaking || s.inking) && !s.muted && !s.previewing,
    );
    this.refs.capFlag.classList.toggle('ink', s.inking && !s.speaking);
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
    this.endInk();
    const tl = this.timeline('recorded');
    this.previewTimeline = tl;
    s.previewing = true;
    this.syncPaused();
    this.updateStatus();
    this.refs.previewFlag.classList.add('on');
    setLabel(this.refs.btnPreview, 'Stop preview');
    setButtonIcon(this.refs.btnPreview, 'square-filled');
    // the recorded pictures play over the slide where the live camera was
    this.previewOverlay?.close();
    this.previewOverlay = OverlayTrack.hasVideo(tl) ? new OverlayTrack(tl) : null;
    this.previewSerial = -1;
    if (this.previewOverlay) {
      this.camStage.showPlayback(this.camera.aspect);
      this.updateSelfView();
    }
    // and the recorded drawings appear as they were made
    this.previewInk = InkTrack.hasInk(tl) ? new InkTrack(tl) : null;
    this.previewInkSerial = -1;
    this.syncInk();
    if (this.previewInk) this.inkStage.show([]);
    await this.preview.start(tl, fromIndex);
  }

  private onPreviewTick(index: number, now: number, total: number): void {
    const items = (this.previewTimeline ?? this.timeline('recorded')).items;
    const it = items[index];
    if (!it) return;
    if (this.store.state.current !== it.seg.slide) this.showSlide(it.seg.slide);
    this.list.setPlaying(this.store.state.segments.indexOf(it.seg));
    this.refs.previewTime.textContent = `${fmtTime(now)} / ${fmtTime(total)}`;
    this.paintPreview(index, now);
    const ink = this.previewInk?.at(index, now) ?? null;
    const serial = ink?.serial ?? -1;
    if (this.previewInk && serial !== this.previewInkSerial) {
      this.previewInkSerial = serial;
      this.inkStage.show(ink?.strokes ?? []);
    }
  }

  /** The camera frame for this moment of the preview; a frame still decoding is skipped, never waited for. */
  private paintPreview(index: number, now: number): void {
    const track = this.previewOverlay;
    if (!track || this.previewPainting) return;
    this.previewPainting = true;
    void track
      .pictureAt(index, now)
      .then((picture) => {
        if (this.previewOverlay !== track) return;
        if (!picture) {
          this.camStage.paint(null);
          this.previewSerial = -1;
        } else if (picture.serial !== this.previewSerial) {
          this.previewSerial = picture.serial;
          this.camStage.paint(picture.frame, picture.aspect);
        }
      })
      .finally(() => {
        this.previewPainting = false;
      });
  }

  stopPreview(): void {
    const s = this.store.state;
    s.previewing = false;
    this.previewTimeline = null;
    this.preview.stop();
    this.previewOverlay?.close();
    this.previewOverlay = null;
    this.previewInk = null;
    this.syncCamStage();
    this.syncInk();
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

  /** Writes the project state a moment after the last change (see `writeMeta`). */
  private saveMeta(): void {
    clearTimeout(this.metaTimer);
    this.metaTimer = window.setTimeout(() => {
      this.metaTimer = 0;
      this.writeMeta();
    }, 300);
  }

  /** A write still waiting for its moment goes now: before the project is let go of or the page leaves. */
  private flushMeta(): void {
    if (this.metaTimer === 0) return;
    clearTimeout(this.metaTimer);
    this.metaTimer = 0;
    this.writeMeta();
  }

  /** The project state, to this browser's store and to the recording on this computer. */
  private writeMeta(): void {
    const meta: ProjectMeta = {
      order: this.store.state.segments.map((s) => s.id),
      current: this.store.state.current,
      settings: { ...this.store.settings },
      savedAt: Date.now(),
      segmentCounter: this.segmentCounter,
      exportRequest: this.exportRequest,
      recordingId: this.recordingId,
      sitting: this.sitting,
      sittings: this.sittings.slice(),
    };
    void this.db.putMeta(meta);
    this.sync.putMeta({
      order: meta.order,
      current: meta.current,
      sitting: this.sitting,
      sittings: this.sittings.slice(),
      settings: { ...this.store.settings },
      exportRequest: this.exportRequest,
      counter: this.segmentCounter,
    });
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
    // a new sitting begins: one more than any sitting that recorded something (a visit that recorded
    // nothing takes no number), and the first for a project with nothing in it yet
    this.sittings = meta?.sittings ?? [];
    this.sitting = Math.max(0, ...segments.map((s) => s.sitting ?? 1), ...this.sittings.map((x) => x.n)) + 1;
    this.list.setSittings(this.sittings);
    this.refs.saved.hidden = true;
    if (files) await this.loadSlideSource(files);
    // Resume was clicked: the checks can load now rather than at Start mic
    this.warmChecks();
    if (segments.length > 0) {
      const order = meta?.order ?? [];
      const byId = new Map(segments.map((s) => [s.id, s]));
      const ordered = order.map((id) => byId.get(id)).filter((s): s is Segment => s !== undefined);
      for (const s of segments) if (!order.includes(s.id)) ordered.push(s);
      const int16 = (a: Int16Array | undefined) =>
        a === undefined || a instanceof Int16Array ? a : new Int16Array(a);
      this.store.state.segments = ordered.map((s) => {
        const seg: Segment = { ...s, pcm: int16(s.pcm) ?? s.pcm };
        const raw = int16(s.raw);
        if (raw) seg.raw = raw;
        const deep = int16(s.deep);
        if (deep) seg.deep = deep;
        const voice = int16(s.voice);
        if (voice) seg.voice = voice;
        return seg;
      });
    }
    if (this.store.state.slides.length > 0) this.showSlide(meta?.current ?? 0);
    this.list.render(this.store.state.segments, this.store.state.slides, true);
    this.updateSlideStats();
    this.updateButtons();
    this.syncInk();
    const n = this.store.state.segments.length;
    this.toast.show(
      `Restored ${n} ${n === 1 ? 'phrase' : 'phrases'} (${fmtTime(totalDuration(this.store.state.segments))}). Sitting ${this.sitting}: new phrases go after the ones so far.`,
    );
    await this.reattachRecording(meta?.recordingId ?? null);
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
    this.endInk();
    this.recorder?.setPaused(true);
    const n = s.segments.length;
    const mirrored = this.recordingId !== null && this.syncState.kind !== 'off';
    if (n > 0) {
      const ok = await this.confirm.ask({
        title: 'Close these slides?',
        message: mirrored
          ? `The ${n === 1 ? 'phrase' : `${n} phrases`} recorded on them (${fmtTime(totalDuration(s.segments))}) leave this browser. The recording stays on this computer: find it under Library › Recordings to continue or delete it.`
          : `The ${n === 1 ? 'phrase' : `${n} phrases`} recorded on them (${fmtTime(totalDuration(s.segments))}) will be deleted. This cannot be undone.`,
        confirm: mirrored ? 'Close' : 'Close and delete',
        cancel: 'Keep working',
      });
      if (!ok) {
        this.syncPaused();
        return;
      }
    }
    if (s.armed) this.stopMic();
    if (s.previewing) this.stopPreview();
    this.flushMeta();
    if (mirrored && this.sync.pending > 0) {
      this.showLoading('Saving the last phrases to this computer…');
      await this.sync.flush();
      this.hideLoading();
    }
    const id = this.recordingId;
    this.sync.detach();
    this.recordingId = null;
    // a recording with nothing in it is not worth a folder
    if (id && n === 0) await this.api.deleteRecording(id).catch(() => undefined);
    await this.clearProject();
    this.toast.show(
      n > 0
        ? mirrored
          ? `Slides closed. The recording (${n === 1 ? '1 phrase' : `${n} phrases`}) stays on this computer.`
          : `Slides closed. ${n === 1 ? 'The phrase was' : `${n} phrases were`} deleted.`
        : 'Slides closed.',
    );
  }

  /** Empties this browser of the project: the deck, the phrases, the saved copy; the stage is back to "Load your slides". */
  private async clearProject(): Promise<void> {
    const s = this.store.state;
    if (s.armed) this.stopMic();
    if (s.previewing) this.stopPreview();
    this.endInk();
    await this.db.clear();
    this.sitting = 1;
    this.sittings = [];
    this.list.setSittings(this.sittings);
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
    this.pendingInk = [];
    this.updateSlideStats();
    this.updateButtons();
    this.syncInk();
    this.updateSyncPill();
    void this.showSavedRecordings();
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
      camera: this.camera,
      camStage: this.camStage,
      setRecordMode: (mode: RecordMode) => this.setRecordMode(mode),
      setCameraOn: (on: boolean) => this.setRecordMode(on ? 'camera' : 'voice'),
      /** The pen, driven without a pointer: a stroke from `penDown` through `penMove`s to `penUp`. */
      inkStage: this.inkStage,
      penBar: this.penBar,
      ink: () => this.ink,
      pendingInk: () => this.pendingInk.length,
      penDown: (x: number, y: number) => this.penDown(x, y),
      penMove: (x: number, y: number) => this.penMove(x, y),
      penUp: () => this.penUp(),
      setPen: (pen: PenSettings) => this.setPen(pen),
      undoStroke: () => this.undoStroke(),
      clearSlide: () => this.clearSlide(),
      cameraLayout: () => this.prefs.cameraLayout,
      setCameraLayout: (layout: CameraLayout) => this.setCameraLayout(layout, true),
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
      startPreview: (from: number) => this.startPreview(from),
      stopPreview: () => this.stopPreview(),
      exportDialog: this.exportDialog,
      openLibrary: (tab?: LibraryTab) => this.library.open(tab),
      library: this.library,
      /** The recording on this computer: its id, the sitting, how the mirror stands. */
      recording: () => ({
        id: this.recordingId,
        sitting: this.sitting,
        sittings: this.sittings,
        sync: this.syncState,
        pending: this.sync.pending,
      }),
      flushSync: () => this.sync.flush(),
      listRecordings: () => this.api.listRecordings(),
      continueRecording: (id: string) => this.continueRecording(id),
      startAgain: async (id: string) => {
        const r = (await this.api.listRecordings()).find((x) => x.id === id);
        if (!r) throw new Error('no such recording');
        await this.startAgain(r);
      },
      recordings: this.recordings,
      savedRecordings: () => this.savedRecordings,
      choice: this.choice,
      openEditor: () => this.openEditor(),
      editor: this.editor,
      serverCaps: () => this.serverCaps,
      browserCaps: () => this.browserCaps,
      studio: () => this.serverCaps?.studio ?? null,
      tape: () => this.tape,
      /** How far a phrase's raw copy sits from its filtered one, by correlation: 0 when they line up. */
      rawLag: (index: number) => {
        const seg = this.store.state.segments[index];
        if (!seg?.raw) return null;
        const around = new Float32Array(seg.raw.length + 2 * RAW_MAX_SHIFT);
        around.set(int16ToFloat(seg.raw), RAW_MAX_SHIFT);
        return bestLag(int16ToFloat(seg.pcm), around, seg.sampleRate, RAW_MAX_SHIFT);
      },
      setChoice: (index: number, choice: Voicing) => {
        const seg = this.store.state.segments[index];
        if (seg) this.setChoice(seg.id, choice);
      },
      /** Marks a phrase as another voice, as the checks would (the tests have no second speaker). */
      flag: (index: number, verdict: SpeakerVerdict['verdict']) => {
        const seg = this.store.state.segments[index];
        if (seg) {
          this.replaceSegment({
            ...seg,
            speaker: { verdict, similarity: 0.2, lips: null, reasons: ['set by a test'] },
          });
        }
      },
      makeVersion: async (index: number, kind: 'deep' | 'voice') => {
        const seg = this.store.state.segments[index];
        if (!seg) throw new Error('no such phrase');
        const next = await this.makeVersion(seg, kind, () => undefined);
        this.replaceSegment(next);
        return { deep: next.deep?.length ?? 0, voice: next.voice?.length ?? 0 };
      },
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
    const studioPlan = planStudio(this.store.state.segments, {
      settings: request.enhance.studio,
      info: this.serverCaps?.studio ?? null,
    });
    let studioNote: string | null = null;
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
      camera: this.prefs.cameraLayout,
      studio: {
        plan: studioPlan,
        profile: this.profile,
        onVersion: (seg, kind, pcm) => this.keepVersion(seg.id, kind, pcm),
        onTwoVoices: (seg, result) => this.flagTwoVoices(seg.id, result),
        onDone: (note) => {
          studioNote = note;
        },
      },
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
      studio: studioNote,
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
