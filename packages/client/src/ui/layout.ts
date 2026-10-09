import { PRESENTATION_EXTENSIONS } from '@one-take/shared';

import { h, label } from './dom.js';
import { icon, nstMark } from './icon.js';
import { shortcut } from './kbd.js';

export interface LayoutRefs {
  fileInput: HTMLInputElement;
  btnLoad: HTMLButtonElement;
  /** Name of the loaded deck, next to the Load button. */
  deckName: HTMLElement;
  /** Numbered badges in the top bar: 1 slides, 2 mic, 3 export. */
  stepSlides: HTMLElement;
  stepMic: HTMLElement;
  stepExport: HTMLElement;
  micSelect: HTMLSelectElement;
  btnArm: HTMLButtonElement;
  btnMute: HTMLButtonElement;
  statusPill: HTMLElement;
  statusText: HTMLElement;
  serverPill: HTMLElement;
  serverText: HTMLElement;
  totalTime: HTMLElement;
  segCount: HTMLElement;
  btnPreview: HTMLButtonElement;
  btnExport: HTMLButtonElement;
  btnNew: HTMLButtonElement;
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
  const stepSlides = stepBadge('stepSlides', 1, 'Load your slides');
  const stepMic = stepBadge('stepMic', 2, 'Start the mic and talk');
  const stepExport = stepBadge('stepExport', 3, 'Preview and export');

  const micSelect = h(
    'select',
    { id: 'micSel', title: 'Which microphone to use' },
    h('option', { value: '' }, 'Default microphone'),
  );
  const btnArm = h(
    'button',
    { id: 'btnArm', class: 'primary', disabled: true, title: 'Load your slides first' },
    icon('mic'),
    label('Start mic'),
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
  const btnExport = h(
    'button',
    { id: 'btnExport', class: 'primary', disabled: true, title: 'Save the finished video' },
    icon('download'),
    label('Export video'),
  );
  const btnNew = h(
    'button',
    { id: 'btnNew', class: 'ghost', title: 'Discard everything and start a new lecture' },
    icon('plus'),
    label('New'),
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
    h('div', { class: 'group', id: 'gSlides' }, stepSlides, btnLoad, deckName),
    h(
      'div',
      { class: 'group', id: 'gMic' },
      stepMic,
      btnArm,
      micSelect,
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
    h('div', { class: 'group', id: 'gExport' }, stepExport, btnPreview, btnExport),
    h('div', { class: 'group tools' }, btnNew, btnHelp, btnTheme),
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
  const stage = h(
    'main',
    { id: 'stage' },
    empty,
    slideImg,
    navPrev,
    navNext,
    overlay,
    capFlag,
    previewFlag,
    restore,
    coach,
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
  const thr = h('input', { type: 'range', id: 'thr', min: -70, max: -20, step: 1, value: '-45' });
  const thrV = h('b', { id: 'thrV' }, '-45 dB');
  const gap = h('input', { type: 'range', id: 'gap', min: 0, max: 1000, step: 50, value: '150' });
  const gapV = h('b', { id: 'gapV' }, '0.15 s');
  const hang = h('input', { type: 'range', id: 'hang', min: 300, max: 1500, step: 50, value: '700' });
  const hangV = h('b', { id: 'hangV' }, '0.70 s');
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
            'Sound above this line counts as speech. Your voice should go clearly past it, room noise should stay under it.',
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
      h(
        'span',
        { class: 'hint keys', id: 'keys' },
        shortcut('slides', '→', '←'),
        shortcut('remove last phrase', 'Backspace'),
        shortcut('mute', 'M'),
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
    stepSlides,
    stepMic,
    stepExport,
    micSelect,
    btnArm,
    btnMute,
    statusPill,
    statusText,
    serverPill,
    serverText,
    totalTime,
    segCount,
    btnPreview,
    btnExport,
    btnNew,
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
    film,
    filmInfo,
    segs,
    segInfo,
  };
}
