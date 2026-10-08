import { h } from './dom.js';

export interface LayoutRefs {
  fileInput: HTMLInputElement;
  btnLoad: HTMLButtonElement;
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
  stage: HTMLElement;
  empty: HTMLElement;
  drop: HTMLElement;
  slideImg: HTMLImageElement;
  navPrev: HTMLButtonElement;
  navNext: HTMLButtonElement;
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

function kbd(text: string): HTMLElement {
  return h('kbd', null, text);
}

/** Builds the static page skeleton and returns handles to everything the app updates. */
export function buildLayout(root: HTMLElement): LayoutRefs {
  const fileInput = h('input', {
    type: 'file',
    id: 'fileIn',
    accept: 'application/pdf,image/*',
    multiple: true,
    hidden: true,
  });
  const btnLoad = h('button', { id: 'btnLoad' }, 'Load slides');
  const micSelect = h(
    'select',
    { id: 'micSel', title: 'Microphone' },
    h('option', { value: '' }, 'Default microphone'),
  );
  const btnArm = h('button', { id: 'btnArm', class: 'primary', disabled: true }, 'Start mic');
  const btnMute = h('button', { id: 'btnMute', disabled: true }, 'Mute');
  const statusText = h('span', { id: 'statusText' }, 'Mic off');
  const statusPill = h('span', { class: 'pill', id: 'status' }, h('span', { class: 'dot' }), statusText);
  const serverText = h('span', null, 'Server…');
  const serverPill = h(
    'span',
    { class: 'pill server', id: 'serverPill', title: 'Local save server' },
    h('span', { class: 'dot' }),
    serverText,
  );
  const totalTime = h('b', { id: 'totalTime' }, '0:00');
  const segCount = h('b', { id: 'segCount' }, '0');
  const btnPreview = h('button', { id: 'btnPreview', disabled: true }, 'Preview');
  const btnExport = h('button', { id: 'btnExport', class: 'primary', disabled: true }, 'Export video');
  const btnNew = h(
    'button',
    { id: 'btnNew', class: 'ghost', title: 'Discard everything and start a new lecture' },
    'New',
  );

  const top = h(
    'header',
    { id: 'top' },
    h('div', { class: 'brand' }, 'One Take ', h('small', null, 'slides + your voice, pauses removed')),
    fileInput,
    btnLoad,
    micSelect,
    btnArm,
    btnMute,
    statusPill,
    h('span', { class: 'stat' }, 'Recorded ', totalTime, ' · ', segCount, ' phrases'),
    h('div', { class: 'spacer' }),
    serverPill,
    btnPreview,
    btnExport,
    btnNew,
  );

  const drop = h(
    'div',
    { id: 'drop' },
    'Drop a PDF here, or a set of slide images (PNG / JPG)',
    h('br'),
    h('span', { class: 'hint' }, 'PowerPoint, Keynote or Google Slides: export as PDF first.'),
  );
  const empty = h(
    'div',
    { id: 'empty' },
    h('h1', null, 'Record a lecture in one take'),
    h(
      'p',
      null,
      'Load your slides, start the mic, and just talk. Only the moments you speak are kept. Thinking pauses are cut out, so the video sounds like one continuous take. Move through the slides as you go; the video follows.',
    ),
    drop,
    h(
      'ol',
      null,
      h(
        'li',
        null,
        'Load slides · 2. Start mic · 3. Speak; use ',
        kbd('→'),
        ' ',
        kbd('←'),
        ' or a clicker to change slides',
      ),
      h('li', null, kbd('Backspace'), ' removes the last phrase if you flubbed it, then just say it again'),
      h(
        'li',
        null,
        'Export when done: MP4, WebM, MKV, MOV, HLS or DASH, saved to any folder on this computer',
      ),
    ),
  );
  const slideImg = h('img', { id: 'slideImg', alt: '' });
  const navPrev = h('button', { class: 'nav prev', id: 'navPrev', title: 'Previous slide (←)' }, '‹');
  const navNext = h('button', { class: 'nav next', id: 'navNext', title: 'Next slide (→)' }, '›');
  const slideNo = h('span', { id: 'slideNo' }, '–');
  const slideTime = h('span', { class: 'hint', id: 'slideTime' });
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
  const loading = h('div', { id: 'loading' }, loadingText);
  const stage = h(
    'main',
    { id: 'stage' },
    empty,
    slideImg,
    navPrev,
    navNext,
    h('div', { id: 'overlay' }, slideNo, slideTime),
    capFlag,
    previewFlag,
    restore,
    loading,
  );

  const meter = h('canvas', { id: 'meter', attrs: { height: '30' } });
  const meterNote = h('span', { class: 'hint', id: 'meterNote', style: 'width:220px' });
  const thr = h('input', { type: 'range', id: 'thr', min: -70, max: -20, step: 1, value: '-45' });
  const thrV = h('b', { id: 'thrV' }, '-45 dB');
  const gap = h('input', { type: 'range', id: 'gap', min: 0, max: 1000, step: 50, value: '150' });
  const gapV = h('b', { id: 'gapV' }, '0.15 s');
  const hang = h('input', { type: 'range', id: 'hang', min: 300, max: 1500, step: 50, value: '700' });
  const hangV = h('b', { id: 'hangV' }, '0.70 s');
  const bottom = h(
    'section',
    { id: 'bottom' },
    h(
      'div',
      { id: 'meterWrap' },
      h('span', { class: 'hint', style: 'width:70px' }, 'Mic level'),
      meter,
      meterNote,
    ),
    h(
      'div',
      { id: 'controls' },
      h(
        'label',
        {
          title:
            'Sound above this level counts as speech. Your voice should go clearly past the line, room noise should stay under it.',
        },
        'Speech threshold ',
        thr,
        thrV,
      ),
      h(
        'label',
        { title: 'How much silence to leave between phrases in the finished video.' },
        'Pause between phrases ',
        gap,
        gapV,
      ),
      h(
        'label',
        {
          title:
            'A phrase ends after this much silence. Pauses shorter than this stay in the video untouched.',
        },
        'Phrase ends after ',
        hang,
        hangV,
      ),
      h(
        'span',
        { class: 'hint', id: 'keys' },
        kbd('→'),
        kbd('←'),
        ' slides · ',
        kbd('Backspace'),
        ' undo last phrase · ',
        kbd('M'),
        ' mute · ',
        kbd('R'),
        ' mic on/off',
      ),
    ),
  );

  const filmInfo = h('span', { id: 'filmInfo' });
  const film = h('div', { id: 'film' });
  const segInfo = h('span', { id: 'segInfo' });
  const segs = h('div', { id: 'segs' });
  const side = h(
    'aside',
    { id: 'side' },
    h('h2', null, 'Slides ', filmInfo),
    film,
    h('h2', null, 'Timeline ', segInfo),
    segs,
  );

  root.append(top, stage, bottom, side);

  return {
    serverText,
    fileInput,
    btnLoad,
    micSelect,
    btnArm,
    btnMute,
    statusPill,
    statusText,
    serverPill,
    totalTime,
    segCount,
    btnPreview,
    btnExport,
    btnNew,
    stage,
    empty,
    drop,
    slideImg,
    navPrev,
    navNext,
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
