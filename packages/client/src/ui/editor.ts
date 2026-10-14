/**
 * The editor: play the lecture with a scrub bar and change it clip by clip. A clip is one phrase on
 * one slide. A clip can be re-recorded, have a stretch of audio cut out of it, be split in two, be
 * shown on another slide, or be deleted; a new clip can be recorded and dropped in anywhere.
 *
 * Every change goes to the controller at once (and from there to IndexedDB), so there is no "save":
 * the list of clips the editor shows is the lecture. Undo steps back through the changes made since
 * the editor was opened.
 */
import { type Settings, type Slide } from '../app/types.js';
import { type MicCapture, type NoiseFilterMode } from '../audio/mic.js';
import { PreviewPlayer } from '../audio/preview.js';
import { TakeRecorder, type Take } from '../audio/take.js';
import {
  cutRange,
  insertAt,
  itemAt,
  keepRange,
  peaks,
  removeAt,
  replaceAt,
  splitAt,
  takeToSegments,
  withSlide,
} from '../core/edit.js';
import { fmtSec, fmtTime } from '../core/format.js';
import { listenAgain } from '../core/hindsight.js';
import { type CaptureMode } from '../core/recorder.js';
import { speechRanges, trimSilences, type Range as SpeechRange } from '../core/silence.js';
import { type VoiceScorer } from '../core/speech.js';
import {
  buildTimeline,
  segmentDuration,
  totalDuration,
  type Segment,
  type Timeline,
} from '../core/timeline.js';

import { clear, h, label, setLabel } from './dom.js';
import { icon, setButtonIcon } from './icon.js';
import { kbd, shortcut } from './kbd.js';
import { LevelMeter } from './meter.js';
import { type Toast } from './toast.js';

export interface EditorDeps {
  slides: () => readonly Slide[];
  segments: () => readonly Segment[];
  settings: () => Settings;
  /** How the mic is driven, the same choice as in the top bar: auto, or only while Space is held. */
  mode: () => CaptureMode;
  mic: MicCapture;
  micDeviceId: () => string | undefined;
  /** Which noise filter runs, the same choice as under the level meter. */
  noiseFilter: () => NoiseFilterMode;
  nextId: () => string;
  /** The voice detector; it cuts takes and finds the pauses in recorded clips. */
  speech: () => VoiceScorer;
  /** The clips changed; the new list is the lecture from now on. */
  onChange: (segments: Segment[]) => void;
  onClose: () => void;
  toast: Toast;
}

/** What a take is for: a new recording of one clip, or a new clip inserted at a position. */
type TakeTarget = { kind: 'replace'; index: number } | { kind: 'insert'; at: number };

interface Range {
  from: number;
  to: number;
}

const BLOCK_MS = 10;
const HISTORY_LIMIT = 50;
/** A pointer that moved less than this on the waveform is a click (seek), not a selection. */
const DRAG_PX = 4;

export class Editor {
  readonly el: HTMLElement;
  private readonly player: PreviewPlayer;
  private readonly take: TakeRecorder;
  private readonly meter: LevelMeter;
  private readonly e: {
    info: HTMLElement;
    screen: HTMLElement;
    slideImg: HTMLImageElement;
    noSlide: HTMLElement;
    btnPlay: HTMLButtonElement;
    time: HTMLElement;
    btnPrev: HTMLButtonElement;
    btnNext: HTMLButtonElement;
    scrub: HTMLElement;
    scrubBlocks: HTMLElement;
    scrubHead: HTMLElement;
    clipList: HTMLElement;
    clipsInfo: HTMLElement;
    btnAdd: HTMLButtonElement;
    btnTrim: HTMLButtonElement;
    clip: HTMLElement;
    clipTitle: HTMLElement;
    slideSelect: HTMLSelectElement;
    wave: HTMLCanvasElement;
    waveHint: HTMLElement;
    btnRerecord: HTMLButtonElement;
    btnPlayRange: HTMLButtonElement;
    btnCut: HTMLButtonElement;
    btnKeep: HTMLButtonElement;
    btnSplit: HTMLButtonElement;
    btnAddAfter: HTMLButtonElement;
    btnDelete: HTMLButtonElement;
    btnUndo: HTMLButtonElement;
    takePanel: HTMLElement;
    takeTitle: HTMLElement;
    takeSlideRow: HTMLElement;
    takeSlideSelect: HTMLSelectElement;
    takePosRow: HTMLElement;
    takePosSelect: HTMLSelectElement;
    takeThumb: HTMLImageElement;
    takeMeter: HTMLCanvasElement;
    takeNote: HTMLElement;
    btnRecord: HTMLButtonElement;
    btnHold: HTMLButtonElement;
    takeStatus: HTMLElement;
    takeResult: HTMLElement;
    takeResultText: HTMLElement;
    btnListen: HTMLButtonElement;
    btnUse: HTMLButtonElement;
    btnAgain: HTMLButtonElement;
    btnTakeCancel: HTMLButtonElement;
    btnDone: HTMLButtonElement;
  };

  private list: Segment[] = [];
  private tl: Timeline = { items: [], total: 0 };
  private history: Segment[][] = [];
  private selected = 0;
  /** The playhead, in seconds from the start of the lecture. */
  private position = 0;
  /** A stretch of the selected clip, in seconds into that clip. */
  private range: Range | null = null;
  /** Stop playback when the playhead leaves the selected range. */
  private stopAtSec: number | null = null;
  private target: TakeTarget | null = null;
  private finished: Take | null = null;
  /** The finished take is playing instead of the lecture. */
  private auditioning = false;
  private takeRaf = 0;
  /** Bumped by every take started, stopped or closed, so a stop that finishes late knows it was overtaken. */
  private takeGeneration = 0;
  private clipRows: HTMLElement[] = [];
  private previouslyFocused: Element | null = null;
  /** The voice detector is going through the clips looking for pauses. */
  private scanning = false;

  constructor(
    parent: HTMLElement,
    private readonly deps: EditorDeps,
  ) {
    this.player = new PreviewPlayer({
      onTick: (index, now) => this.onTick(index, now),
      onEnd: () => this.onEnd(),
    });
    this.take = new TakeRecorder(deps.mic, BLOCK_MS, () => deps.speech());

    /* ------------------------------------------------------------ player */
    const slideImg = h('img', { class: 'slide', alt: '' });
    const noSlide = h('div', { class: 'noslide' }, 'No clips. Add a clip to start.');
    const screen = h('div', { class: 'screen' }, slideImg, noSlide);
    const btnPlay = h(
      'button',
      { class: 'icon', id: 'edPlay', title: 'Play / pause (Space)', attrs: { 'aria-label': 'Play' } },
      icon('play'),
    );
    const time = h('span', { class: 'time', id: 'edTime' }, '0:00 / 0:00');
    const btnPrev = h(
      'button',
      { class: 'icon', id: 'edPrev', title: 'Previous clip (←)', attrs: { 'aria-label': 'Previous clip' } },
      icon('skip-previous'),
    );
    const btnNext = h(
      'button',
      { class: 'icon', id: 'edNext', title: 'Next clip (→)', attrs: { 'aria-label': 'Next clip' } },
      icon('skip-next'),
    );
    const scrubBlocks = h('div', { class: 'blocks' });
    const scrubHead = h('div', { class: 'head' });
    const scrub = h(
      'div',
      { class: 'scrub', id: 'edScrub', title: 'Click or drag to move through the lecture' },
      scrubBlocks,
      scrubHead,
    );
    const player = h(
      'div',
      { class: 'player' },
      screen,
      h('div', { class: 'bar' }, btnPlay, btnPrev, btnNext, time, h('div', { class: 'spacer' })),
      scrub,
    );

    /* ------------------------------------------------------------ selected clip */
    const clipTitle = h('b', { id: 'edClipTitle' });
    const slideSelect = h('select', { id: 'edSlide', title: 'Show this clip on another slide' });
    const wave = h('canvas', { class: 'wave', id: 'edWave', attrs: { height: '72' } });
    const waveHint = h('span', { class: 'hint', id: 'edWaveHint' });
    const btnRerecord = h(
      'button',
      { class: 'primary', id: 'edRerecord', title: 'Record this clip again; the new voice takes its place' },
      icon('refresh'),
      label('Re-record'),
    );
    const btnPlayRange = h(
      'button',
      { id: 'edPlayRange', title: 'Listen to the selected stretch' },
      icon('play'),
      label('Play selection'),
    );
    const btnCut = h(
      'button',
      { id: 'edCut', title: 'Remove the selected stretch of audio from this clip' },
      icon('remove'),
      label('Cut selection'),
    );
    const btnKeep = h(
      'button',
      { id: 'edKeep', title: 'Keep only the selected stretch; the rest of the clip is removed' },
      icon('check'),
      label('Keep only selection'),
    );
    const btnSplit = h(
      'button',
      { id: 'edSplit', title: 'Split this clip in two at the playhead, so a new clip can go between' },
      icon('split-screen'),
      label('Split at playhead'),
    );
    const btnAddAfter = h(
      'button',
      { id: 'edAddAfter', title: 'Record a new clip and put it right after this one' },
      icon('plus'),
      label('Add clip after'),
    );
    const btnDelete = h(
      'button',
      { class: 'danger', id: 'edDelete', title: 'Remove this clip (Delete)' },
      icon('bin'),
      label('Delete'),
    );
    const btnUndo = h(
      'button',
      { class: 'ghost', id: 'edUndo', title: 'Undo the last change (⌘Z)', disabled: true },
      icon('reply'),
      label('Undo'),
    );
    const clip = h(
      'div',
      { class: 'clip', id: 'edClip' },
      h(
        'div',
        { class: 'title' },
        clipTitle,
        h('label', { class: 'slidepick' }, 'Slide', slideSelect),
        h('div', { class: 'spacer' }),
        btnUndo,
      ),
      wave,
      waveHint,
      h(
        'div',
        { class: 'actions inline' },
        btnRerecord,
        btnPlayRange,
        btnCut,
        btnKeep,
        btnSplit,
        btnAddAfter,
        h('div', { class: 'spacer' }),
        btnDelete,
      ),
    );

    /* ------------------------------------------------------------ take panel */
    const takeTitle = h('b', { id: 'edTakeTitle' });
    const takeSlideSelect = h('select', { id: 'edTakeSlide' });
    const takeThumb = h('img', { class: 'thumb', alt: '' });
    const takeSlideRow = h('label', { class: 'pick' }, 'On slide', takeSlideSelect);
    const takePosSelect = h('select', { id: 'edTakePos' });
    const takePosRow = h('label', { class: 'pick' }, 'Put it', takePosSelect);
    const takeMeter = h('canvas', { class: 'meter', id: 'edMeter', attrs: { height: '30' } });
    const takeNote = h('span', { class: 'hint' });
    const btnRecord = h(
      'button',
      { class: 'primary', id: 'edRecord', title: 'Start recording' },
      icon('dot-circle'),
      label('Record'),
    );
    const btnHold = h(
      'button',
      {
        class: 'hold',
        id: 'edHold',
        hidden: true,
        title: 'Press and hold while you speak; let go while you think. Space does the same.',
        attrs: { 'aria-label': 'Hold to speak', 'aria-keyshortcuts': 'Space' },
      },
      icon('mic', 16),
      label('Hold to speak'),
      kbd('Space'),
    );
    const takeStatus = h('span', { class: 'status', id: 'edTakeStatus' });
    const takeResultText = h('span', { id: 'edTakeResultText' });
    const btnListen = h('button', { id: 'edListen' }, icon('play'), label('Listen'));
    const btnUse = h('button', { class: 'primary', id: 'edUse' }, icon('check'), label('Use this take'));
    const btnAgain = h('button', { id: 'edAgain' }, icon('refresh'), label('Record again'));
    const takeResult = h(
      'div',
      { class: 'result', hidden: true },
      takeResultText,
      h('div', { class: 'actions inline' }, btnListen, btnUse, btnAgain),
    );
    const btnTakeCancel = h('button', { class: 'ghost', id: 'edTakeCancel' }, 'Cancel');
    const takePanel = h(
      'div',
      { class: 'take', id: 'edTake', hidden: true },
      h('div', { class: 'title' }, icon('mic', 16), takeTitle, h('div', { class: 'spacer' }), btnTakeCancel),
      h('div', { class: 'where' }, takeThumb, takeSlideRow, takePosRow),
      h('div', { class: 'meterrow' }, btnRecord, btnHold, takeMeter, takeStatus),
      takeNote,
      takeResult,
    );

    /* ------------------------------------------------------------ clip list */
    const clipsInfo = h('span', { id: 'edClipsInfo' });
    const clipList = h('div', { class: 'list', id: 'edClips' });
    const btnAdd = h(
      'button',
      { id: 'edAdd', title: 'Record a new clip on any slide and put it anywhere in the lecture' },
      icon('plus'),
      label('Add a clip'),
    );
    const btnTrim = h(
      'button',
      {
        id: 'edTrim',
        title:
          'Listen through every clip with the voice detector and cut out the stretches where nobody is speaking',
      },
      icon('hearing'),
      label('Remove pauses'),
    );
    const clips = h(
      'div',
      { class: 'clips' },
      h('h4', null, 'Clips ', clipsInfo),
      clipList,
      h('div', { class: 'actions inline' }, btnAdd, btnTrim),
    );

    /* ------------------------------------------------------------ frame */
    const info = h('span', { class: 'info', id: 'edInfo' });
    const btnX = h(
      'button',
      { class: 'x', title: 'Done (Esc)', attrs: { 'aria-label': 'Close' } },
      icon('close', 16),
    );
    btnX.onclick = () => this.close();
    const btnDone = h('button', { class: 'primary', id: 'edDone' }, icon('check'), label('Done'));
    btnDone.onclick = () => this.close();
    this.el = h(
      'div',
      { class: 'modal editor', id: 'editor' },
      h(
        'div',
        { class: 'box', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'editorTitle' } },
        h(
          'div',
          { class: 'head' },
          icon('pen', 20),
          h('h3', { id: 'editorTitle' }, 'Edit the video'),
          info,
          btnX,
        ),
        h('div', { class: 'body' }, h('div', { class: 'left' }, player, clip, takePanel), clips),
        h(
          'div',
          { class: 'foot' },
          h(
            'span',
            { class: 'hint keys' },
            shortcut('play / pause', 'Space'),
            shortcut('clip', '←', '→'),
            shortcut('delete clip', 'Delete'),
            shortcut('undo', '⌘Z'),
            shortcut('done', 'Esc'),
          ),
          h('div', { class: 'spacer' }),
          btnDone,
        ),
      ),
    );
    this.e = {
      info,
      screen,
      slideImg,
      noSlide,
      btnPlay,
      time,
      btnPrev,
      btnNext,
      scrub,
      scrubBlocks,
      scrubHead,
      clipList,
      clipsInfo,
      btnAdd,
      btnTrim,
      clip,
      clipTitle,
      slideSelect,
      wave,
      waveHint,
      btnRerecord,
      btnPlayRange,
      btnCut,
      btnKeep,
      btnSplit,
      btnAddAfter,
      btnDelete,
      btnUndo,
      takePanel,
      takeTitle,
      takeSlideRow,
      takeSlideSelect,
      takePosRow,
      takePosSelect,
      takeThumb,
      takeMeter,
      takeNote,
      btnRecord,
      btnHold,
      takeStatus,
      takeResult,
      takeResultText,
      btnListen,
      btnUse,
      btnAgain,
      btnTakeCancel,
      btnDone,
    };
    this.meter = new LevelMeter(takeMeter, takeNote);
    this.wire();
    parent.appendChild(this.el);
  }

  get isOpen(): boolean {
    return this.el.classList.contains('on');
  }

  /* ------------------------------------------------------------------ */
  /* Open and close                                                      */
  /* ------------------------------------------------------------------ */

  open(): void {
    this.list = this.deps.segments().slice();
    this.history = [];
    this.selected = 0;
    this.position = 0;
    this.range = null;
    this.stopAtSec = null;
    this.closeTake();
    this.previouslyFocused = document.activeElement;
    this.el.classList.add('on');
    this.rebuild();
    this.e.btnPlay.focus();
  }

  close(): void {
    if (!this.isOpen) return;
    this.pause();
    this.closeTake();
    this.el.classList.remove('on');
    if (this.previouslyFocused instanceof HTMLElement) this.previouslyFocused.focus();
    this.deps.onClose();
  }

  /* ------------------------------------------------------------------ */
  /* Wiring                                                              */
  /* ------------------------------------------------------------------ */

  private wire(): void {
    const e = this.e;
    e.btnPlay.onclick = () => this.togglePlay();
    e.btnPrev.onclick = () => this.select(this.selected - 1, true);
    e.btnNext.onclick = () => this.select(this.selected + 1, true);
    e.btnAdd.onclick = () => this.openTake({ kind: 'insert', at: this.list.length });
    e.btnTrim.onclick = () => void this.removePauses();
    e.btnAddAfter.onclick = () => this.openTake({ kind: 'insert', at: this.selected + 1 });
    e.btnRerecord.onclick = () => this.openTake({ kind: 'replace', index: this.selected });
    e.btnDelete.onclick = () => this.deleteSelected();
    e.btnUndo.onclick = () => this.undo();
    e.btnCut.onclick = () => this.cutSelection(false);
    e.btnKeep.onclick = () => this.cutSelection(true);
    e.btnSplit.onclick = () => this.splitSelected();
    e.btnPlayRange.onclick = () => void this.playRange();
    e.slideSelect.onchange = () => this.changeSlide(Number(e.slideSelect.value));
    e.btnRecord.onclick = () => {
      if (this.take.recording) void this.stopTake();
      else void this.startTake();
    };
    e.btnTakeCancel.onclick = () => this.closeTake();
    e.btnAgain.onclick = () => void this.startTake();
    e.btnUse.onclick = () => this.useTake();
    e.btnListen.onclick = () => void this.listenTake();
    e.takeSlideSelect.onchange = () => this.updateTakeThumb();
    // press to speak inside a take: the button follows the pointer, down starts and up (anywhere) ends
    e.btnHold.onpointerdown = (ev) => {
      ev.preventDefault();
      e.btnHold.setPointerCapture(ev.pointerId);
      this.hold(true);
    };
    const holdUp = (ev: PointerEvent) => {
      if (e.btnHold.hasPointerCapture(ev.pointerId)) e.btnHold.releasePointerCapture(ev.pointerId);
      this.hold(false);
    };
    e.btnHold.onpointerup = holdUp;
    e.btnHold.onpointercancel = holdUp;
    e.btnHold.oncontextmenu = (ev) => ev.preventDefault();

    // the scrub bar: click or drag to move the playhead
    let scrubbing = false;
    const scrubTo = (ev: PointerEvent) => {
      const rect = e.scrubBlocks.getBoundingClientRect();
      if (rect.width <= 0) return;
      const f = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      this.seek(f * this.tl.total);
    };
    e.scrub.addEventListener('pointerdown', (ev) => {
      if (this.tl.items.length === 0) return;
      scrubbing = true;
      e.scrub.setPointerCapture(ev.pointerId);
      scrubTo(ev);
    });
    e.scrub.addEventListener('pointermove', (ev) => {
      if (scrubbing) scrubTo(ev);
    });
    const endScrub = (ev: PointerEvent) => {
      if (!scrubbing) return;
      scrubbing = false;
      try {
        e.scrub.releasePointerCapture(ev.pointerId);
      } catch {
        /* already released */
      }
    };
    e.scrub.addEventListener('pointerup', endScrub);
    e.scrub.addEventListener('pointercancel', endScrub);

    // the waveform: drag to select a stretch, click to put the playhead there
    let waveDown: { x: number; id: number } | null = null;
    const waveSec = (clientX: number) => {
      const seg = this.list[this.selected];
      const rect = e.wave.getBoundingClientRect();
      if (!seg || rect.width <= 0) return 0;
      const f = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return f * segmentDuration(seg);
    };
    e.wave.addEventListener('pointerdown', (ev) => {
      if (!this.list[this.selected]) return;
      waveDown = { x: ev.clientX, id: ev.pointerId };
      e.wave.setPointerCapture(ev.pointerId);
    });
    e.wave.addEventListener('pointermove', (ev) => {
      if (!waveDown) return;
      if (Math.abs(ev.clientX - waveDown.x) < DRAG_PX && !this.range) return;
      this.range = { from: waveSec(waveDown.x), to: waveSec(ev.clientX) };
      this.drawWave();
      this.updateClipButtons();
    });
    const endWave = (ev: PointerEvent) => {
      if (!waveDown) return;
      const down = waveDown;
      waveDown = null;
      try {
        e.wave.releasePointerCapture(ev.pointerId);
      } catch {
        /* already released */
      }
      if (ev.type === 'pointercancel') return;
      if (Math.abs(ev.clientX - down.x) < DRAG_PX) {
        // a click: clear the selection and move the playhead into the clip
        this.range = null;
        const it = this.tl.items[this.selected];
        if (it) this.seek(it.start + waveSec(ev.clientX));
        this.drawWave();
        this.updateClipButtons();
        return;
      }
      const a = waveSec(down.x);
      const b = waveSec(ev.clientX);
      this.range = { from: Math.min(a, b), to: Math.max(a, b) };
      this.drawWave();
      this.updateClipButtons();
    };
    e.wave.addEventListener('pointerup', endWave);
    e.wave.addEventListener('pointercancel', endWave);

    window.addEventListener('resize', () => {
      if (this.isOpen) this.drawWave();
    });
    this.el.addEventListener('click', (ev) => {
      if (ev.target === this.el && !this.take.recording) this.close();
    });
    // On the document, like the welcome tour: the keys work wherever focus is while the editor is open.
    document.addEventListener('keydown', (ev) => this.onKey(ev));
    document.addEventListener('keyup', (ev) => {
      if (this.isOpen && ev.key === ' ') this.hold(false);
    });
    window.addEventListener('blur', () => this.hold(false));
  }

  /** Space or the hold button, while a press-to-speak take is recording. */
  private hold(down: boolean): boolean {
    if (!this.take.recording || this.take.mode !== 'hold') return false;
    const changed = this.take.hold(down);
    if (changed) this.e.btnHold.classList.toggle('on', down);
    return true;
  }

  private onKey(ev: KeyboardEvent): void {
    if (!this.isOpen) return;
    const tag = (ev.target as HTMLElement | null)?.tagName.toLowerCase() ?? '';
    const typing = tag === 'input' || tag === 'select' || tag === 'textarea';
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      ev.stopPropagation();
      this.undo();
      return;
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    switch (ev.key) {
      case 'Escape':
        ev.stopPropagation();
        if (this.take.recording) this.closeTake();
        else if (this.player.playing) this.pause();
        else if (this.target) this.closeTake();
        else this.close();
        break;
      case ' ':
        if (this.take.recording && this.take.mode === 'hold') {
          // the talk key: a held key auto-repeats, and those repeats mean nothing
          ev.preventDefault();
          ev.stopPropagation();
          if (!ev.repeat) this.hold(true);
          return;
        }
        if (typing || tag === 'button') return;
        ev.preventDefault();
        ev.stopPropagation();
        if (!this.target) this.togglePlay();
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
        if (typing) return;
        ev.preventDefault();
        ev.stopPropagation();
        this.select(this.selected + (ev.key === 'ArrowLeft' ? -1 : 1), true);
        break;
      case 'Backspace':
      case 'Delete':
        if (typing || this.target) return;
        ev.preventDefault();
        ev.stopPropagation();
        this.deleteSelected();
        break;
      default:
        break;
    }
  }

  /* ------------------------------------------------------------------ */
  /* The list of clips                                                   */
  /* ------------------------------------------------------------------ */

  /** Records a change: the old list goes on the undo stack, the new one is shown and saved. */
  private commit(next: Segment[], message?: string): void {
    this.history.push(this.list);
    while (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.list = next;
    this.range = null;
    this.deps.onChange(this.list.slice());
    this.rebuild();
    if (message) this.deps.toast.show(message);
  }

  undo(): void {
    const prev = this.history.pop();
    if (!prev) return;
    this.pause();
    this.list = prev;
    this.range = null;
    this.deps.onChange(this.list.slice());
    this.rebuild();
    this.deps.toast.show('Undone');
  }

  /** Everything derived from the list: the timeline, the clip rows, the scrub blocks, the tools. */
  private rebuild(): void {
    this.tl = buildTimeline(this.list, 'recorded', this.deps.settings());
    this.selected = Math.max(0, Math.min(this.list.length - 1, this.selected));
    this.position = Math.max(0, Math.min(this.tl.total, this.position));
    this.renderClips();
    this.renderScrub();
    this.e.info.textContent = this.list.length
      ? `${this.list.length} clip${this.list.length === 1 ? '' : 's'} · ${fmtTime(this.tl.total)}`
      : 'No clips';
    this.e.btnUndo.disabled = this.history.length === 0;
    this.e.btnTrim.disabled = this.list.length === 0 || this.scanning;
    this.updateSelection();
    this.updatePlayhead();
  }

  private renderClips(): void {
    const e = this.e;
    const slides = this.deps.slides();
    clear(e.clipList);
    this.clipRows = [];
    if (this.list.length === 0) {
      e.clipList.appendChild(
        h('div', { class: 'empty' }, 'No clips yet. Add a clip: pick a slide, record your voice, done.'),
      );
      e.clipsInfo.textContent = '';
      return;
    }
    const frag = document.createDocumentFragment();
    this.list.forEach((seg, i) => {
      const slide = slides[seg.slide];
      const joined = seg.joined && this.list[i - 1]?.id === seg.prevId;
      const row = h(
        'div',
        {
          class: 'seg',
          dataset: { i: String(i) },
          title: `Clip ${i + 1}: slide ${seg.slide + 1}, ${fmtSec(segmentDuration(seg))}`,
          attrs: { role: 'button', tabindex: '0' },
          on: {
            click: () => this.select(i, true),
            keydown: (ev) => {
              if (ev.key === 'Enter') this.select(i, true);
            },
          },
        },
        h('span', { class: 'i' }, String(i + 1)),
        h('img', { src: slide?.thumbUrl ?? '', alt: '' }),
        h(
          'div',
          { class: 'meta' },
          h('b', null, `Slide ${seg.slide + 1}`),
          h(
            'small',
            { class: joined ? 'join' : '' },
            `${fmtSec(segmentDuration(seg))}${joined ? ' · continues' : ''}`,
          ),
        ),
      );
      this.clipRows.push(row);
      frag.appendChild(row);
    });
    e.clipList.appendChild(frag);
    e.clipsInfo.textContent = `${this.list.length} · ${fmtTime(totalDuration(this.list))}`;
  }

  private renderScrub(): void {
    const e = this.e;
    clear(e.scrubBlocks);
    const total = this.tl.total;
    this.tl.items.forEach((it, i) => {
      const span = it.end - it.from;
      const gapPct = span > 0 ? (it.gap / span) * 100 : 0;
      e.scrubBlocks.appendChild(
        h('span', {
          class: 'blk',
          dataset: { i: String(i) },
          style: `flex-grow: ${total > 0 ? span / total : 1}; --gap: ${gapPct.toFixed(2)}%`,
          title: `Clip ${i + 1} · slide ${it.seg.slide + 1}`,
        }),
      );
    });
  }

  /** Makes clip `index` the one the tools work on; `seek` also moves the playhead to its start. */
  select(index: number, seek: boolean): void {
    if (this.list.length === 0) return;
    const i = Math.max(0, Math.min(this.list.length - 1, index));
    if (i !== this.selected) this.range = null;
    this.selected = i;
    if (seek) {
      const it = this.tl.items[i];
      if (it) this.seek(it.start);
    }
    this.updateSelection();
  }

  private updateSelection(): void {
    const e = this.e;
    const seg = this.list[this.selected];
    this.clipRows.forEach((row, i) => {
      const on = i === this.selected;
      row.classList.toggle('sel', on);
      if (on) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    });
    this.clipRows[this.selected]?.scrollIntoView({ block: 'nearest' });
    for (const blk of e.scrubBlocks.children)
      blk.classList.toggle('sel', (blk as HTMLElement).dataset.i === String(this.selected));
    e.clip.hidden = !seg || this.target !== null;
    if (!seg) {
      e.btnPrev.disabled = true;
      e.btnNext.disabled = true;
      return;
    }
    e.btnPrev.disabled = this.selected === 0;
    e.btnNext.disabled = this.selected >= this.list.length - 1;
    e.clipTitle.textContent = `Clip ${this.selected + 1} of ${this.list.length} · ${fmtSec(segmentDuration(seg))}`;
    this.fillSlideSelect(e.slideSelect, seg.slide);
    this.drawWave();
    this.updateClipButtons();
  }

  private fillSlideSelect(select: HTMLSelectElement, value: number): void {
    const slides = this.deps.slides();
    const n = Math.max(slides.length, value + 1);
    if (select.options.length !== n) {
      clear(select);
      for (let i = 0; i < n; i++) select.appendChild(h('option', { value: String(i) }, `Slide ${i + 1}`));
    }
    select.value = String(value);
  }

  private updateClipButtons(): void {
    const e = this.e;
    const seg = this.list[this.selected];
    const r = this.range;
    const range =
      r && Math.abs(r.to - r.from) > 0.01
        ? { from: Math.min(r.from, r.to), to: Math.max(r.from, r.to) }
        : null;
    e.btnCut.disabled = !range;
    e.btnKeep.disabled = !range;
    e.btnPlayRange.disabled = !range;
    const it = this.tl.items[this.selected];
    const inside = seg && it ? this.position - it.start : -1;
    e.btnSplit.disabled = !seg || inside <= 0.05 || inside >= segmentDuration(seg) - 0.05;
    e.waveHint.textContent = range
      ? `Selected ${fmtSec(range.from)} to ${fmtSec(range.to)} (${fmtSec(range.to - range.from)}). Cut it, keep only it, or play it.`
      : 'Drag across the waveform to select a stretch of audio. Click to put the playhead there.';
  }

  /* ------------------------------------------------------------------ */
  /* Edits                                                               */
  /* ------------------------------------------------------------------ */

  private deleteSelected(): void {
    const seg = this.list[this.selected];
    if (!seg) return;
    this.pause();
    const n = this.selected + 1;
    this.commit(removeAt(this.list, this.selected), `Removed clip ${n} (${fmtSec(segmentDuration(seg))})`);
  }

  private changeSlide(slide: number): void {
    const seg = this.list[this.selected];
    if (!seg || seg.slide === slide) return;
    this.commit(
      withSlide(this.list, this.selected, slide),
      `Clip ${this.selected + 1} now shows slide ${slide + 1}`,
    );
  }

  private cutSelection(keepInstead: boolean): void {
    const seg = this.list[this.selected];
    const r = this.range;
    if (!seg || !r) return;
    this.pause();
    const next = keepInstead ? keepRange(seg, r.from, r.to) : cutRange(seg, r.from, r.to);
    const n = this.selected + 1;
    if (next === null) {
      this.commit(removeAt(this.list, this.selected), `Nothing left of clip ${n}, so it was removed`);
      return;
    }
    const removed = segmentDuration(seg) - segmentDuration(next);
    const it = this.tl.items[this.selected];
    if (it) this.position = it.start + (keepInstead ? 0 : Math.min(r.from, r.to));
    this.commit(
      replaceAt(this.list, this.selected, 1, [next]),
      keepInstead
        ? `Kept ${fmtSec(segmentDuration(next))} of clip ${n}`
        : `Cut ${fmtSec(removed)} out of clip ${n}`,
    );
  }

  private splitSelected(): void {
    const seg = this.list[this.selected];
    const it = this.tl.items[this.selected];
    if (!seg || !it) return;
    this.pause();
    const parts = splitAt(seg, this.position - it.start, this.deps.nextId());
    if (!parts) {
      this.deps.toast.show('Move the playhead inside the clip to split it');
      return;
    }
    const n = this.selected + 1;
    this.commit(
      replaceAt(this.list, this.selected, 1, parts),
      `Split clip ${n} into clips ${n} and ${n + 1}`,
    );
  }

  /**
   * Every clip goes through the second listen; the stretches without a voice, apart from pauses
   * shorter than the hangover and the pre-roll and tail at the ends, are cut out, splitting a clip
   * where a long pause sat inside it. One change on the undo stack, however many clips it touched.
   */
  private async removePauses(): Promise<void> {
    if (this.scanning || this.list.length === 0) return;
    this.pause();
    this.closeTake();
    this.scanning = true;
    this.e.btnTrim.disabled = true;
    const list = this.list;
    const total = totalDuration(list);
    const settings = this.deps.settings();
    try {
      const ranges = new Map<string, SpeechRange[]>();
      let done = 0;
      for (const seg of list) {
        const show = (sec: number) => {
          const pct = total > 0 ? Math.min(100, Math.round(((done + sec) / total) * 100)) : 100;
          this.e.info.textContent = `Listening for pauses… ${pct}%`;
        };
        show(0);
        const probs = await listenAgain(seg.pcm, seg.sampleRate, show);
        done += segmentDuration(seg);
        ranges.set(seg.id, speechRanges(probs, segmentDuration(seg), settings));
      }
      if (this.list !== list) {
        this.deps.toast.show('The clips changed while pauses were being found; try again.');
        return;
      }
      const result = trimSilences(list, ranges, this.deps.nextId);
      if (result.changed === 0) {
        this.deps.toast.show('No pauses to remove: every clip is speech from start to end.');
        return;
      }
      this.position = 0;
      this.commit(
        result.segments,
        `Removed ${fmtTime(result.removedSec)} of silence from ${result.changed} clip${result.changed === 1 ? '' : 's'}`,
      );
    } catch (error) {
      console.warn('Remove pauses failed', error);
      this.deps.toast.show('Listening for pauses failed; nothing was changed.');
    } finally {
      this.scanning = false;
      this.rebuild();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Playback                                                            */
  /* ------------------------------------------------------------------ */

  private togglePlay(): void {
    if (this.player.playing && !this.auditioning) this.pause();
    else void this.play(this.position);
  }

  private async play(fromSec: number): Promise<void> {
    if (this.tl.items.length === 0) return;
    this.auditioning = false;
    this.stopAtSec = null;
    if (fromSec >= this.tl.total - 0.01) fromSec = 0;
    this.position = fromSec;
    setButtonIcon(this.e.btnPlay, 'pause');
    this.e.btnPlay.setAttribute('aria-label', 'Pause');
    await this.player.startAtTime(this.tl, fromSec);
  }

  private pause(): void {
    if (this.player.playing) this.player.stop();
    this.auditioning = false;
    this.stopAtSec = null;
    setButtonIcon(this.e.btnPlay, 'play');
    this.e.btnPlay.setAttribute('aria-label', 'Play');
    this.updatePlayhead();
  }

  /** Moves the playhead; keeps playing from there if it was playing. */
  seek(sec: number): void {
    const was = this.player.playing && !this.auditioning;
    this.position = Math.max(0, Math.min(this.tl.total, sec));
    if (was) void this.play(this.position);
    else {
      const hit = itemAt(this.tl, this.position);
      if (hit && hit.index !== this.selected) this.select(hit.index, false);
      this.updatePlayhead();
    }
  }

  private async playRange(): Promise<void> {
    const it = this.tl.items[this.selected];
    const r = this.range;
    if (!it || !r) return;
    const from = Math.min(r.from, r.to);
    const to = Math.max(r.from, r.to);
    await this.play(it.start + from);
    this.stopAtSec = it.start + to;
  }

  private onTick(index: number, now: number): void {
    if (this.auditioning) {
      this.e.takeStatus.textContent = `Playing the take · ${fmtTime(now)}`;
      return;
    }
    this.position = now;
    if (this.stopAtSec !== null && now >= this.stopAtSec) {
      this.pause();
      return;
    }
    if (index !== this.selected) this.select(index, false);
    this.updatePlayhead();
  }

  private onEnd(): void {
    if (this.auditioning) {
      this.auditioning = false;
      this.showTakeResult();
      return;
    }
    this.position = this.tl.total;
    this.pause();
  }

  /** The slide on the screen, the time, the scrub head and the line on the waveform. */
  private updatePlayhead(): void {
    const e = this.e;
    const hit = itemAt(this.tl, this.position);
    const slides = this.deps.slides();
    const it = hit ? this.tl.items[hit.index] : undefined;
    const slide = it ? slides[it.seg.slide] : undefined;
    e.noSlide.hidden = this.list.length > 0;
    if (slide) {
      if (e.slideImg.src !== slide.url) e.slideImg.src = slide.url;
      e.slideImg.hidden = false;
    } else {
      e.slideImg.hidden = true;
    }
    e.time.textContent = `${fmtTime(this.position)} / ${fmtTime(this.tl.total)}`;
    const f = this.tl.total > 0 ? this.position / this.tl.total : 0;
    e.scrubHead.style.left = `${(f * 100).toFixed(3)}%`;
    e.scrubHead.hidden = this.list.length === 0;
    e.btnPlay.disabled = this.list.length === 0;
    this.drawWave();
    this.updateClipButtons();
  }

  /* ------------------------------------------------------------------ */
  /* The waveform of the selected clip                                   */
  /* ------------------------------------------------------------------ */

  private drawWave(): void {
    const c = this.e.wave;
    const seg = this.list[this.selected];
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 600;
    const hPx = c.clientHeight || 72;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hPx * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hPx * dpr);
    }
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const style = getComputedStyle(c);
    const colour = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    g.clearRect(0, 0, w, hPx);
    if (!seg) return;
    const dur = segmentDuration(seg);
    const x = (sec: number) => (dur > 0 ? (sec / dur) * w : 0);
    // the selected stretch first, so the bars draw over it
    if (this.range) {
      const a = x(Math.min(this.range.from, this.range.to));
      const b = x(Math.max(this.range.from, this.range.to));
      g.fillStyle = colour('--wave-sel', 'rgba(6,115,249,.25)');
      g.fillRect(a, 0, Math.max(1, b - a), hPx);
      g.fillStyle = colour('--wave-sel-line', '#0673f9');
      g.fillRect(a, 0, 1, hPx);
      g.fillRect(b - 1, 0, 1, hPx);
    }
    const bars = peaks(seg.pcm, Math.max(1, Math.floor(w / 2)));
    const mid = hPx / 2;
    g.fillStyle = colour('--wave-bar', '#8b93a7');
    for (let i = 0; i < bars.length; i++) {
      const v = bars[i] ?? 0;
      const half = Math.max(1, v * (mid - 4));
      g.fillRect(i * 2, mid - half, 1.4, half * 2);
    }
    // tick every second
    g.fillStyle = colour('--wave-tick', 'rgba(255,255,255,.15)');
    for (let s = 1; s < dur; s++) g.fillRect(x(s), hPx - 6, 1, 6);
    // the playhead, when it is inside this clip
    const it = this.tl.items[this.selected];
    if (it) {
      const inside = this.position - it.start;
      if (inside >= 0 && inside <= dur) {
        g.fillStyle = colour('--wave-head', '#fff');
        g.fillRect(x(inside) - 1, 0, 2, hPx);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Takes: re-record a clip or record a new one                         */
  /* ------------------------------------------------------------------ */

  private openTake(target: TakeTarget): void {
    this.pause();
    this.closeTake();
    this.target = target;
    this.finished = null;
    const e = this.e;
    const slides = this.deps.slides();
    e.clip.hidden = true;
    e.takePanel.hidden = false;
    e.takeResult.hidden = true;
    e.takeStatus.textContent = '';
    if (target.kind === 'replace') {
      const seg = this.list[target.index];
      if (!seg) return;
      e.takeTitle.textContent = `Re-record clip ${target.index + 1} (slide ${seg.slide + 1})`;
      e.takeSlideRow.hidden = true;
      e.takePosRow.hidden = true;
      this.fillSlideSelect(e.takeSlideSelect, seg.slide);
    } else {
      e.takeTitle.textContent = 'New clip';
      e.takeSlideRow.hidden = false;
      e.takePosRow.hidden = false;
      const near = this.list[Math.min(target.at, this.list.length) - 1] ?? this.list[0];
      this.fillSlideSelect(e.takeSlideSelect, near?.slide ?? 0);
      clear(e.takePosSelect);
      e.takePosSelect.appendChild(h('option', { value: '0' }, 'at the start'));
      this.list.forEach((_, i) =>
        e.takePosSelect.appendChild(h('option', { value: String(i + 1) }, `after clip ${i + 1}`)),
      );
      e.takePosSelect.value = String(Math.max(0, Math.min(this.list.length, target.at)));
    }
    this.updateTakeThumb();
    e.takeNote.textContent =
      slides.length === 0
        ? 'Load slides first so the clip has something to show.'
        : this.deps.mode() === 'hold'
          ? 'Press Record, then hold Space (or the button) while you talk and let go while you think. Press Stop when you are done.'
          : 'Press Record and talk. Pauses are cut out, as always. Press Stop when you are done.';
    e.btnHold.hidden = true;
    setLabel(e.btnRecord, 'Record');
    setButtonIcon(e.btnRecord, 'dot-circle');
    e.btnRecord.classList.add('primary');
    e.btnRecord.classList.remove('rec');
    e.btnRecord.disabled = false;
    this.drawTakeMeter();
    e.takePanel.scrollIntoView({ block: 'nearest' });
    e.btnRecord.focus();
  }

  private updateTakeThumb(): void {
    const slide = this.deps.slides()[Number(this.e.takeSlideSelect.value)];
    this.e.takeThumb.src = slide?.thumbUrl ?? '';
    this.e.takeThumb.hidden = !slide;
  }

  private closeTake(): void {
    this.takeGeneration++;
    if (this.take.recording) this.take.cancel();
    cancelAnimationFrame(this.takeRaf);
    this.e.btnHold.hidden = true;
    if (this.auditioning) {
      this.player.stop();
      this.auditioning = false;
    }
    this.target = null;
    this.finished = null;
    this.e.takePanel.hidden = true;
    this.e.clip.hidden = !this.list[this.selected];
  }

  private async startTake(): Promise<void> {
    const target = this.target;
    if (!target) return;
    this.takeGeneration++;
    if (this.auditioning) {
      this.player.stop();
      this.auditioning = false;
    }
    this.finished = null;
    const e = this.e;
    e.takeResult.hidden = true;
    e.btnRecord.disabled = true;
    e.takeStatus.textContent = 'Opening the microphone…';
    let opened: boolean;
    try {
      opened = await this.take.start({
        settings: this.deps.settings(),
        mode: this.deps.mode(),
        deviceId: this.deps.micDeviceId(),
        noiseFilter: this.deps.noiseFilter(),
      });
    } catch (error) {
      e.btnRecord.disabled = false;
      e.takeStatus.textContent = '';
      this.deps.toast.show(`Microphone not available: ${(error as Error).message}`);
      return;
    }
    e.btnRecord.disabled = false;
    if (!opened || this.target !== target) {
      // cancelled (or the panel closed) while the microphone was opening
      e.takeStatus.textContent = '';
      return;
    }
    const hold = this.take.mode === 'hold';
    e.btnHold.hidden = !hold;
    e.btnHold.classList.remove('on');
    setLabel(e.btnRecord, 'Stop');
    setButtonIcon(e.btnRecord, 'square-filled');
    e.btnRecord.classList.remove('primary');
    e.btnRecord.classList.add('rec');
    const loop = () => {
      if (!this.take.recording) return;
      this.drawTakeMeter();
      const n = this.take.phraseCount;
      const sofar = n === 0 ? '' : `${n} phrase${n === 1 ? '' : 's'} · ${fmtSec(this.take.seconds)} · `;
      e.takeStatus.textContent = this.take.speaking
        ? `RECORDING ${fmtSec(this.take.seconds)}`
        : hold
          ? this.take.held
            ? 'Go ahead and talk'
            : `${sofar}hold Space or the button to speak`
          : n === 0
            ? 'Listening… speak whenever you are ready'
            : `${sofar}listening`;
      e.takeStatus.classList.toggle('rec', this.take.speaking);
      this.takeRaf = requestAnimationFrame(loop);
    };
    loop();
  }

  private async stopTake(): Promise<void> {
    if (!this.take.recording) return;
    cancelAnimationFrame(this.takeRaf);
    const e = this.e;
    e.btnHold.hidden = true;
    e.btnHold.classList.remove('on');
    setLabel(e.btnRecord, 'Record');
    setButtonIcon(e.btnRecord, 'dot-circle');
    e.btnRecord.classList.add('primary');
    e.btnRecord.classList.remove('rec');
    e.takeStatus.classList.remove('rec');
    e.takeStatus.textContent = 'Listening again for the pauses…';
    e.btnRecord.disabled = true;
    const generation = ++this.takeGeneration;
    let take: Take;
    try {
      take = await this.take.stop();
    } finally {
      e.btnRecord.disabled = false;
    }
    // the panel closed (or another take began) while the last phrases were being gone over
    if (this.takeGeneration !== generation) return;
    this.drawTakeMeter();
    if (take.phrases.length === 0) {
      e.takeStatus.textContent = 'Nothing was heard above the speech line. Try again, a little louder.';
      return;
    }
    this.finished = take;
    this.showTakeResult();
  }

  private takeSeconds(take: Take): number {
    return take.phrases.reduce((a, p) => a + p.length / take.sampleRate, 0);
  }

  private showTakeResult(): void {
    const take = this.finished;
    const e = this.e;
    if (!take) return;
    const n = take.phrases.length;
    e.takeStatus.textContent = '';
    e.takeResultText.textContent = `Take: ${n} phrase${n === 1 ? '' : 's'}, ${fmtSec(this.takeSeconds(take))}. Listen to it, use it, or record it again.`;
    e.takeResult.hidden = false;
    setLabel(e.btnListen, 'Listen');
    setButtonIcon(e.btnListen, 'play');
    e.btnUse.focus();
  }

  private async listenTake(): Promise<void> {
    const take = this.finished;
    if (!take) return;
    if (this.auditioning) {
      this.player.stop();
      this.auditioning = false;
      this.showTakeResult();
      return;
    }
    if (this.player.playing) this.pause();
    let n = 0;
    const segs = takeToSegments(
      take.phrases,
      take.sampleRate,
      Number(this.e.takeSlideSelect.value),
      () => `take-${++n}`,
    );
    const tl = buildTimeline(segs, 'recorded', this.deps.settings());
    this.auditioning = true;
    setLabel(this.e.btnListen, 'Stop');
    setButtonIcon(this.e.btnListen, 'square-filled');
    await this.player.start(tl, 0);
  }

  private useTake(): void {
    const take = this.finished;
    const target = this.target;
    if (!take || !target) return;
    if (this.auditioning) {
      this.player.stop();
      this.auditioning = false;
    }
    const slide = Number(this.e.takeSlideSelect.value);
    const segs = takeToSegments(take.phrases, take.sampleRate, slide, this.deps.nextId);
    if (segs.length === 0) return;
    let next: Segment[];
    let first: number;
    if (target.kind === 'replace') {
      next = replaceAt(this.list, target.index, 1, segs);
      first = target.index;
    } else {
      first = Math.max(0, Math.min(this.list.length, Number(this.e.takePosSelect.value)));
      next = insertAt(this.list, first, segs);
    }
    const what = `${segs.length} clip${segs.length === 1 ? '' : 's'} (${fmtSec(this.takeSeconds(take))}) on slide ${slide + 1}`;
    this.closeTake();
    this.selected = first;
    this.commit(
      next,
      target.kind === 'replace' ? `Replaced clip ${first + 1} with ${what}` : `Added ${what}`,
    );
    const it = this.tl.items[first];
    if (it) this.seek(it.start);
  }

  private drawTakeMeter(): void {
    const settings = this.deps.settings();
    this.meter.draw({
      armed: this.take.recording,
      muted: false,
      speaking: this.take.speaking,
      level: this.take.level,
      threshold: this.take.threshold ?? settings.threshold,
      noise: this.take.noise,
      settingThreshold: settings.threshold,
      voice: this.take.voice,
    });
  }
}
