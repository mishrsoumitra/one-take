import { PRESENTATION_EXTENSIONS } from '@one-take/shared';

import { h, label } from './dom.js';
import { icon, nstMark, type IconName } from './icon.js';
import { kbd, shortcut } from './kbd.js';

export interface LayoutRefs {
  fileInput: HTMLInputElement;
  btnLoad: HTMLButtonElement;
  /** Name of the loaded deck, next to the Load button. */
  deckName: HTMLElement;
  /** The × after the deck name: closes the slides and abandons the session. Hidden while nothing is loaded. */
  btnClose: HTMLButtonElement;
  /** Numbered badges in the top bar: 1 slides, 2 mic, 3 export. */
  stepSlides: HTMLElement;
  stepMic: HTMLElement;
  stepExport: HTMLElement;
  /** Which microphone to open; in the bottom bar, after the sliders. */
  micSelect: HTMLSelectElement;
  /** Which noise filter runs over the microphone (deep, classic, off); next to the picker. */
  noiseFilter: HTMLSelectElement;
  /** Which camera the lip check watches, or none. */
  camSelect: HTMLSelectElement;
  /** Enrolls the speaker's voice for the voice check, or does it again. */
  btnVoice: HTMLButtonElement;
  /** The camera's picture in a corner of the stage while the lip check watches it, with a note under it. */
  selfBox: HTMLElement;
  selfView: HTMLVideoElement;
  selfNote: HTMLElement;
  btnArm: HTMLButtonElement;
  /** Auto / press to speak, as a two-button segmented control. */
  modeSwitch: HTMLElement;
  btnModeAuto: HTMLButtonElement;
  btnModeHold: HTMLButtonElement;
  btnMute: HTMLButtonElement;
  statusPill: HTMLElement;
  statusText: HTMLElement;
  serverPill: HTMLElement;
  serverText: HTMLElement;
  totalTime: HTMLElement;
  segCount: HTMLElement;
  btnPreview: HTMLButtonElement;
  /** Opens the editor: play with a scrub bar, re-record, cut, add or remove clips. */
  btnEdit: HTMLButtonElement;
  btnExport: HTMLButtonElement;
  /** Opens the list of exported videos: play, show in folder, delete. */
  btnLibrary: HTMLButtonElement;
  btnHelp: HTMLButtonElement;
  /** Switches between grauity's dark and light themes. */
  btnTheme: HTMLButtonElement;
  stage: HTMLElement;
  empty: HTMLElement;
  /** The big "choose a file" button inside the empty stage. */
  btnChoose: HTMLButtonElement;
  btnEmptyHelp: HTMLButtonElement;
  drop: HTMLElement;
  /** Under the drop zone: which deck formats the server can convert right now. */
  dropHint: HTMLElement;
  slideImg: HTMLImageElement;
  navPrev: HTMLButtonElement;
  navNext: HTMLButtonElement;
  /** The slide-number badge; hidden while no slides are loaded. */
  overlay: HTMLElement;
  slideNo: HTMLElement;
  slideTime: HTMLElement;
  capFlag: HTMLElement;
  capFlagText: HTMLElement;
  /** Press to speak: the big hold-to-talk button at the bottom of the stage. */
  btnHold: HTMLButtonElement;
  btnHoldText: HTMLElement;
  previewFlag: HTMLElement;
  previewTime: HTMLElement;
  btnStopPreview: HTMLButtonElement;
  restore: HTMLElement;
  restoreText: HTMLElement;
  btnRestore: HTMLButtonElement;
  btnDiscard: HTMLButtonElement;
  loading: HTMLElement;
  loadingText: HTMLElement;
  /** The "what to do next" tip at the bottom of the stage. */
  coach: HTMLElement;
  coachText: HTMLElement;
  btnCoachClose: HTMLButtonElement;
  meter: HTMLCanvasElement;
  meterNote: HTMLElement;
  thr: HTMLInputElement;
  thrV: HTMLElement;
  gap: HTMLInputElement;
  gapV: HTMLElement;
  hang: HTMLInputElement;
  hangV: HTMLElement;
  /** Shortcut legend entries that only make sense in one of the two modes. */
  keyMute: HTMLElement;
  keyHold: HTMLElement;
  film: HTMLElement;
  filmInfo: HTMLElement;
  segs: HTMLElement;
  segInfo: HTMLElement;
}

/** A numbered step badge; the number gives way to a tick once the step is done. */
function stepBadge(id: string, n: number, title: string): HTMLElement {
  return h(
    'span',
    { class: 'step', id, title, attrs: { 'aria-label': `Step ${n}: ${title}` } },
    h('span', { class: 'n' }, String(n)),
    icon('check', 16),
  );
}

/** One option of the mode switch: a radio in a segmented control, with its icon and label. */
function modeOption(id: string, name: IconName, text: string, title: string): HTMLButtonElement {
  return h(
    'button',
    { id, class: 'opt', title, attrs: { role: 'radio', 'aria-checked': 'false' } },
    icon(name, 16),
    label(text),
  );
}

/** Builds the static page skeleton and returns handles to everything the app updates. */
export function buildLayout(root: HTMLElement): LayoutRefs {
  /* ---------------------------------------------------------------- top bar */
  const fileInput = h('input', {
    type: 'file',
    id: 'fileIn',
    accept: ['application/pdf', 'image/*', ...PRESENTATION_EXTENSIONS.map((e) => `.${e}`)].join(','),
    multiple: true,
    hidden: true,
  });
  const btnLoad = h(
    'button',
    { id: 'btnLoad', title: 'PDF, PowerPoint or PNG / JPG images' },
    icon('upload'),
    label('Load slides'),
  );
  const deckName = h('span', { class: 'deck', id: 'deckName', hidden: true });
  const btnClose = h(
    'button',
    {
      id: 'btnClose',
      class: 'ghost icon',
      hidden: true,
      title: 'Close these slides and abandon the session',
      attrs: { 'aria-label': 'Close slides' },
    },
    icon('close', 16),
  );
  const stepSlides = stepBadge('stepSlides', 1, 'Load your slides');
  const stepMic = stepBadge('stepMic', 2, 'Start the mic and talk');
  const stepExport = stepBadge('stepExport', 3, 'Preview, edit and export');

  const btnArm = h(
    'button',
    { id: 'btnArm', class: 'primary', disabled: true, title: 'Load your slides first' },
    icon('mic'),
    label('Start mic'),
  );
  const btnModeAuto = modeOption(
    'modeAuto',
    'hearing',
    'Auto',
    'Automatic: the mic listens the whole time and the app decides when you are speaking. Pauses are cut out.',
  );
  const btnModeHold = modeOption(
    'modeHold',
    'hold',
    'Press to speak',
    'Press to speak: nothing is recorded unless you hold Space or the button on the stage. Let go while you think.',
  );
  const modeSwitch = h(
    'div',
    {
      class: 'segmented',
      id: 'modeSwitch',
      title: 'How the mic is driven',
      attrs: { role: 'radiogroup', 'aria-label': 'Recording mode' },
    },
    btnModeAuto,
    btnModeHold,
  );
  const btnMute = h(
    'button',
    { id: 'btnMute', hidden: true, title: 'Mute (M)' },
    icon('micmute'),
    label('Mute'),
  );
  const statusText = h('span', { id: 'statusText' }, 'Mic off');
  const statusPill = h('span', { class: 'pill', id: 'status' }, h('span', { class: 'dot' }), statusText);
  const totalTime = h('b', { id: 'totalTime' }, '0:00');
  const segCount = h('b', { id: 'segCount' }, '0');

  const btnPreview = h(
    'button',
    { id: 'btnPreview', disabled: true, title: 'Play back what you have recorded so far' },
    icon('play'),
    label('Preview'),
  );
  const btnEdit = h(
    'button',
    { id: 'btnEdit', disabled: true, title: 'Re-record, cut, add or remove clips' },
    icon('pen'),
    label('Edit'),
  );
  const btnExport = h(
    'button',
    { id: 'btnExport', class: 'primary', disabled: true, title: 'Save the finished video' },
    icon('download'),
    h('span', { class: 'label' }, 'Export', h('span', { class: 'long' }, ' video')),
  );
  const btnLibrary = h(
    'button',
    {
      id: 'btnLibrary',
      class: 'ghost',
      title: 'Your exported videos: watch them, show them in the folder, or delete them',
    },
    icon('folder'),
    label('Exports'),
  );
  const btnHelp = h(
    'button',
    { id: 'btnHelp', class: 'ghost', title: 'How it works' },
    icon('question-circle'),
    label('Help'),
  );
  const btnTheme = h(
    'button',
    { id: 'btnTheme', class: 'ghost icon', title: 'Switch to the light theme' },
    icon('sun'),
  );

  const top = h(
    'header',
    { id: 'top' },
    h(
      'div',
      { class: 'brand', title: 'One Take, by Newton School' },
      h('span', { class: 'mark' }, nstMark()),
      h('span', { class: 'name' }, 'One Take'),
      h('span', { class: 'by' }, 'Newton School'),
    ),
    fileInput,
    h('div', { class: 'group', id: 'gSlides' }, stepSlides, btnLoad, deckName, btnClose),
    h(
      'div',
      { class: 'group', id: 'gMic' },
      stepMic,
      btnArm,
      modeSwitch,
      btnMute,
      statusPill,
      h(
        'span',
        { class: 'stat', title: 'Total speech recorded so far' },
        totalTime,
        ' · ',
        segCount,
        ' phrases',
      ),
    ),
    h('div', { class: 'spacer' }),
    h('div', { class: 'group', id: 'gExport' }, stepExport, btnPreview, btnEdit, btnExport),
    h('div', { class: 'group tools' }, btnLibrary, btnHelp, btnTheme),
  );

  /* ------------------------------------------------------------------ stage */
  const dropHint = h(
    'span',
    { class: 'hint', id: 'dropHint' },
    'PowerPoint files are converted by the local server. Keynote or Google Slides: export as PDF first.',
  );
  const btnChoose = h(
    'button',
    { class: 'primary big', id: 'btnChoose' },
    icon('folder-open'),
    label('Choose a file…'),
  );
  const drop = h(
    'div',
    { id: 'drop' },
    h('div', { class: 'icon', attrs: { 'aria-hidden': 'true' } }, icon('upload', 24)),
    h('div', { class: 'what' }, 'Drop a PDF, a PowerPoint file or PNG / JPG slide images here'),
    btnChoose,
    dropHint,
  );
  const btnEmptyHelp = h('button', { class: 'ghost', id: 'btnEmptyHelp' }, 'Show me how it works');
  const empty = h(
    'div',
    { id: 'empty' },
    h('div', { class: 'tag' }, 'Step 1 of 3'),
    h('h1', null, 'Load your slides'),
    h(
      'p',
      null,
      'Then start the mic and just talk. Only the moments you speak are kept, so the video sounds like one continuous take.',
    ),
    drop,
    h(
      'div',
      { class: 'then' },
      h('span', { class: 'step' }, '2'),
      'Start the mic and talk',
      h('span', { class: 'step' }, '3'),
      'Preview and export',
      btnEmptyHelp,
    ),
  );
  const slideImg = h('img', { id: 'slideImg', alt: '' });
  const navPrev = h(
    'button',
    {
      class: 'nav prev',
      id: 'navPrev',
      title: 'Previous slide (←)',
      attrs: { 'aria-label': 'Previous slide' },
    },
    icon('chevron-left', 24),
  );
  const navNext = h(
    'button',
    { class: 'nav next', id: 'navNext', title: 'Next slide (→)', attrs: { 'aria-label': 'Next slide' } },
    icon('chevron-right', 24),
  );
  const slideNo = h('span', { id: 'slideNo' }, '–');
  const slideTime = h('span', { class: 'hint', id: 'slideTime' });
  const overlay = h('div', { id: 'overlay', hidden: true }, slideNo, slideTime);
  const capFlagText = h('span', null, 'RECORDING');
  const capFlag = h('div', { id: 'capFlag' }, h('span', { class: 'dot' }), capFlagText);
  const btnHoldText = h('span', { class: 'label' }, 'Hold to speak');
  const btnHold = h(
    'button',
    {
      id: 'btnHold',
      hidden: true,
      title: 'Press and hold while you speak; let go while you think. Space does the same.',
      attrs: { 'aria-label': 'Hold to speak', 'aria-keyshortcuts': 'Space' },
    },
    icon('mic', 24),
    btnHoldText,
    kbd('Space'),
  );
  const previewTime = h('span', { id: 'previewTime' }, '0:00');
  const btnStopPreview = h('button', { id: 'btnStopPreview' }, 'Stop');
  const previewFlag = h('div', { id: 'previewFlag' }, 'Preview ', previewTime, btnStopPreview);
  const restoreText = h('span', { id: 'restoreText' });
  const btnRestore = h('button', { class: 'primary', id: 'btnRestore' }, 'Resume');
  const btnDiscard = h('button', { id: 'btnDiscard' }, 'Discard');
  const restore = h('div', { id: 'restore' }, restoreText, btnRestore, btnDiscard);
  const loadingText = h('span', { id: 'loadingText' }, 'Loading…');
  const loading = h('div', { id: 'loading' }, h('span', { class: 'spinner' }), loadingText);
  const coachText = h('span', { id: 'coachText' });
  const btnCoachClose = h(
    'button',
    {
      class: 'x',
      id: 'btnCoachClose',
      title: 'Hide tips (Help turns them back on)',
      attrs: { 'aria-label': 'Hide tips' },
    },
    icon('close', 16),
  );
  const coach = h('div', { id: 'coach', hidden: true }, coachText, btnCoachClose);
  const selfView = h('video', {
    id: 'selfView',
    attrs: { autoplay: '', playsinline: '', 'aria-label': 'Your camera' },
  });
  selfView.muted = true;
  const selfNote = h('span', { class: 'note' }, 'Camera');
  const selfBox = h('div', { id: 'self', hidden: true }, selfView, selfNote);
  const stage = h(
    'main',
    { id: 'stage' },
    empty,
    slideImg,
    navPrev,
    navNext,
    overlay,
    capFlag,
    btnHold,
    previewFlag,
    restore,
    coach,
    selfBox,
    loading,
  );

  /* ------------------------------------------------------------- bottom bar */
  const meter = h('canvas', { id: 'meter', attrs: { height: '30' } });
  const meterNote = h('span', { class: 'hint', id: 'meterNote' });
  const serverText = h('span', null, 'Server…');
  const serverPill = h(
    'span',
    { class: 'pill server', id: 'serverPill', title: 'Local save server' },
    h('span', { class: 'dot' }),
    serverText,
  );
  const micSelect = h(
    'select',
    { id: 'micSel', title: 'Which microphone to use' },
    h('option', { value: '' }, 'Default microphone'),
  );
  const noiseFilter = h(
    'select',
    {
      id: 'noiseFilter',
      title:
        'What is taken out from under your voice before anything is recorded. Deep: DeepFilterNet3, a trained model that removes fans, typing, traffic, music and other people talking. Classic: a plain filter for steady noise (a fan, a hum, hiss). Off: only what Chrome does on its own.',
    },
    h('option', { value: 'deep' }, 'Deep (DeepFilterNet3)'),
    h('option', { value: 'classic' }, 'Classic'),
    h('option', { value: 'off' }, 'Off'),
  );
  const camSelect = h(
    'select',
    {
      id: 'camSel',
      title:
        'The lip check: the camera watches your mouth while you record, so a phrase someone else says while your lips are still is marked as another voice. The picture stays on this computer. The choice is remembered.',
    },
    h('option', { value: '' }, 'Default camera'),
    h('option', { value: 'off' }, 'Camera off'),
  );
  const btnVoice = h(
    'button',
    {
      id: 'btnVoice',
      class: 'ghost',
      title:
        'The voice check: read for twenty seconds once, and every phrase is compared with how your voice sounds. A phrase in another voice is marked in the timeline.',
    },
    icon('mic', 16),
    label('Learn my voice'),
  );
  const micSettings = h(
    'span',
    { id: 'micSettings' },
    h(
      'label',
      { class: 'pick', title: 'Which microphone to use. The choice is remembered.' },
      h('span', { class: 'label' }, 'Microphone'),
      micSelect,
    ),
    h('label', { class: 'pick' }, h('span', { class: 'label' }, 'Noise filter'), noiseFilter),
    h('label', { class: 'pick' }, h('span', { class: 'label' }, 'Camera'), camSelect),
    btnVoice,
  );
  const thr = h('input', { type: 'range', id: 'thr', min: -70, max: -20, step: 1, value: '-45' });
  const thrV = h('b', { id: 'thrV' }, '-45 dB');
  const gap = h('input', { type: 'range', id: 'gap', min: 0, max: 1000, step: 50, value: '150' });
  const gapV = h('b', { id: 'gapV' }, '0.15 s');
  const hang = h('input', { type: 'range', id: 'hang', min: 300, max: 1500, step: 50, value: '700' });
  const hangV = h('b', { id: 'hangV' }, '0.70 s');
  const keyHold = shortcut('hold to speak', 'Space');
  keyHold.id = 'keyHold';
  keyHold.hidden = true;
  const keyMute = shortcut('mute', 'M');
  keyMute.id = 'keyMute';
  const bottom = h(
    'section',
    { id: 'bottom' },
    h('div', { id: 'meterWrap' }, h('span', { class: 'label' }, 'Mic level'), meter, meterNote, serverPill),
    h(
      'div',
      { id: 'controls' },
      h(
        'label',
        {
          title:
            'Sound under this line never counts as speech, even a faint voice from the next room. Your voice should go clearly past it; the voice detector tells it from noise above the line.',
        },
        h('span', { class: 'label' }, 'Speech line'),
        thr,
        thrV,
      ),
      h(
        'label',
        { title: 'How much silence to leave between phrases in the finished video.' },
        h('span', { class: 'label' }, 'Pause between phrases'),
        gap,
        gapV,
      ),
      h(
        'label',
        {
          title:
            'A phrase ends after this much silence. Pauses shorter than this stay in the video untouched.',
        },
        h('span', { class: 'label' }, 'Phrase ends after'),
        hang,
        hangV,
      ),
      micSettings,
      h(
        'span',
        { class: 'hint keys', id: 'keys' },
        keyHold,
        shortcut('slides', '→', '←'),
        shortcut('remove last phrase', 'Backspace'),
        keyMute,
        shortcut('mic on / off', 'R'),
      ),
    ),
  );

  /* ------------------------------------------------------------- side panel */
  const filmInfo = h('span', { id: 'filmInfo' });
  const film = h('div', { id: 'film' });
  const segInfo = h('span', { id: 'segInfo' });
  const segs = h('div', { id: 'segs' });
  const side = h(
    'aside',
    { id: 'side' },
    h('h2', null, icon('image', 16), 'Slides ', filmInfo),
    film,
    h('h2', null, icon('waveform', 16), 'Timeline ', segInfo),
    segs,
  );

  root.append(top, stage, bottom, side);

  return {
    fileInput,
    btnLoad,
    deckName,
    btnClose,
    stepSlides,
    stepMic,
    stepExport,
    micSelect,
    noiseFilter,
    camSelect,
    btnVoice,
    selfBox,
    selfView,
    selfNote,
    btnArm,
    modeSwitch,
    btnModeAuto,
    btnModeHold,
    btnMute,
    statusPill,
    statusText,
    serverPill,
    serverText,
    totalTime,
    segCount,
    btnPreview,
    btnEdit,
    btnExport,
    btnLibrary,
    btnHelp,
    btnTheme,
    stage,
    empty,
    btnChoose,
    btnEmptyHelp,
    drop,
    dropHint,
    slideImg,
    navPrev,
    navNext,
    overlay,
    slideNo,
    slideTime,
    capFlag,
    capFlagText,
    btnHold,
    btnHoldText,
    previewFlag,
    previewTime,
    btnStopPreview,
    restore,
    restoreText,
    btnRestore,
    btnDiscard,
    loading,
    loadingText,
    coach,
    coachText,
    btnCoachClose,
    meter,
    meterNote,
    thr,
    thrV,
    gap,
    gapV,
    hang,
    hangV,
    keyMute,
    keyHold,
    film,
    filmInfo,
    segs,
    segInfo,
  };
}
