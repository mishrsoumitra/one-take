/**
 * The pen: headless Chrome with a fake camera and a WAV microphone. Chooses the "voice + camera +
 * pen" mode, records phrases and draws on the slides between and during them, and checks that a
 * drawing ends the phrase being spoken, that a voice or the pen's rest ends the drawing, that
 * strokes stay on their slide and go when the slide is cleared, that the undo takes a stroke back,
 * that the export's frames carry the strokes exactly where and when they were drawn, and that the
 * preview, the editor and a reload all show them.
 *
 *   npm run e2e:ink          (builds first)
 *   tsx packages/e2e/src/ink.ts --out /tmp/one-take-ink --port 4699
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { check, finish, Page, ROOT, probe, sleep, startChrome, startServer, video } from './harness.js';
import { writeFixtures } from './make-fixtures.js';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    port: { type: 'string' },
  },
});
const OUT = path.resolve(values.out ?? path.join(ROOT, 'packages/e2e/ink-out'));
const PORT = Number(values.port ?? 4699);
const CDP_PORT = PORT + 1;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const fixtures = await writeFixtures(path.join(OUT, 'fixtures'));
const exportsDir = path.join(OUT, 'exports');
fs.mkdirSync(exportsDir, { recursive: true });

await startServer(PORT, exportsDir);
startChrome({ cdpPort: CDP_PORT, profileDir: path.join(OUT, 'profile'), wav: fixtures.wav, loop: true });
const page = await Page.open(CDP_PORT, OUT);
page.watchdog(14 * 60_000);
const ev = <T = unknown>(expression: string, timeoutMs?: number) => page.ev<T>(expression, timeoutMs);

/* ------------------------------------------------------------ what the page knows about its clips */
interface Stroke {
  tool: string;
  color: string;
  points: number;
  first: number;
  last: number;
}
interface SegInfo {
  slide: number;
  sec: number;
  joined: boolean;
  ink: null | { wipe: boolean; strokes: Stroke[] };
  video: boolean;
}
const segments = () =>
  ev<SegInfo[]>(
    `__onetake.state.segments.map(s => ({ slide: s.slide, sec: +(s.pcm.length / s.sampleRate).toFixed(3), joined: s.joined,
      video: Boolean(s.video && s.video.pieces.length > 0),
      ink: s.ink ? { wipe: s.ink.wipe, strokes: s.ink.strokes.map(k => ({ tool: k.tool, color: k.color, points: k.points.length,
        first: k.points[0]?.t ?? -1, last: k.points[k.points.length - 1]?.t ?? -1 })) } : null }))`,
  );
/** How many strokes the stage shows right now. */
const shown = () => ev<number>('__onetake.inkStage.shown.length');
/** Colours of the strokes the stage shows. */
const shownColors = () => ev<string[]>('__onetake.inkStage.shown.map(s => s.color)');

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
const inkCanvasRect = () =>
  ev<Box>(
    '(() => { const b = document.querySelector("#stage .ink-layer canvas").getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()',
  );

/** Draws a stroke with the mouse through `points` (fractions of the slide), a few moves per leg, `ms` long in all. */
async function draw(points: { x: number; y: number }[], ms = 400): Promise<void> {
  const r = await inkCanvasRect();
  const at = (p: { x: number; y: number }) => ({ x: r.x + p.x * r.w, y: r.y + p.y * r.h });
  const first = points[0];
  if (!first) return;
  const start = at(first);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: start.x,
    y: start.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  const legs = Math.max(1, points.length - 1);
  const steps = 6;
  const pause = Math.max(5, Math.round(ms / (legs * steps)));
  let last = start;
  for (let k = 0; k < legs; k++) {
    const a = points[k];
    const b = points[k + 1];
    if (!a || !b) break;
    for (let i = 1; i <= steps; i++) {
      const p = at({ x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps });
      await page.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: p.x,
        y: p.y,
        button: 'left',
        buttons: 1,
      });
      last = p;
      await sleep(pause);
    }
  }
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: last.x,
    y: last.y,
    button: 'left',
    clickCount: 1,
  });
}

/** Counts the pixels of a frame that are clearly red, blue or green (the slides are black on white). */
function countColours(file: string): { red: number; blue: number; green: number; yellow: number } {
  // a 720p frame as raw RGB is 2.8 MB, more than execFileSync's default buffer
  const raw = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    {
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  let red = 0;
  let blue = 0;
  let green = 0;
  let yellow = 0;
  const width = 1280;
  for (let i = 0; i + 2 < raw.length; i += 3) {
    // the camera's picture (a green pacman) sits in the bottom-right corner: not counted
    const px = (i / 3) % width;
    const py = Math.floor(i / 3 / width);
    if (px >= 900 && py >= 470) continue;
    const r = raw[i] ?? 0;
    const g = raw[i + 1] ?? 0;
    const b = raw[i + 2] ?? 0;
    if (r > 170 && g < 110 && b < 110) red++;
    else if (b > 170 && r < 110 && g < 170) blue++;
    else if (g > 140 && r < 120 && b < 140) green++;
    // the highlighter is translucent: pale yellow over the white slide
    else if (r > 220 && g > 200 && b < 200 && r - b > 40) yellow++;
  }
  return { red, blue, green, yellow };
}

/* ------------------------------------------------------------ boot */
page.step('boot');
await page.navigate(`http://127.0.0.1:${PORT}/`);
await page.waitForApp();
await sleep(1500);
await page.setFiles('#fileIn', [fixtures.pdf]);
for (let i = 0; i < 100 && (await ev<number>('__onetake.state.slides.length')) < 4; i++) await sleep(200);
check((await ev<number>('__onetake.state.slides.length')) === 4, 'four slides rendered');
// the lip check is not what this run is about, and it loads a model
await ev('__onetake.setCamera("off")');

/* ------------------------------------------------------------ the mode */
page.step('pen mode');
check(await ev<boolean>('document.getElementById("penBar").hidden'), 'no pen toolbar in the voice mode');
check(
  await ev<boolean>('document.getElementById("recVoice").getAttribute("aria-checked") === "true"'),
  'voice is the mode to begin with',
);
await ev('document.getElementById("recInk").click()');
await sleep(200);
check(await ev<boolean>('__onetake.prefs().record === "annotate"'), 'the pen mode is remembered');
check(
  await ev<boolean>('document.getElementById("recInk").getAttribute("aria-checked") === "true"'),
  'the pen option is marked',
);
check(await ev<boolean>('!document.getElementById("penBar").hidden'), 'the pen toolbar appears');
check(
  await page.waitFor('__onetake.camera.on', 100, 100),
  'the camera opens with the pen mode (it is recorded too)',
);
check(await ev<boolean>('!document.getElementById("camRow").hidden'), 'the camera row is there too');
check(
  !(await ev<boolean>('__onetake.inkStage.canDraw')),
  'the slide does not take the pen before the mic is on',
);
check(
  (await ev<string>('document.getElementById("penNote").textContent')) === 'Start mic to draw',
  'the toolbar says to start the mic first',
);
check(
  await ev<boolean>('document.getElementById("pen-pen").getAttribute("aria-checked") === "true"'),
  'the pen is the tool to begin with',
);
check(
  await ev<boolean>('document.getElementById("pen-color-ff3b30").getAttribute("aria-checked") === "true"'),
  'red is the colour to begin with',
);
await ev('document.getElementById("pen-color-0673f9").click()');
check(await ev<boolean>('__onetake.prefs().pen.color === "#0673f9"'), 'a colour click is remembered');
await ev('document.getElementById("pen-color-ff3b30").click()');
await page.screenshot('ink-mode.png');

/* ------------------------------------------------------------ recording, with a voice that the pen cuts */
page.step('the pen cuts a phrase');
// the first mic start offers the voice enrollment; skipped, so the run is about the pen
await ev('void __onetake.startMic()');
if (await page.waitFor('__onetake.enroll.isOpen', 30, 100))
  await ev('document.getElementById("enrollSkip").click()');
check(await page.startMic(), 'mic started');
check(await ev<boolean>('__onetake.inkStage.canDraw'), 'the slide takes the pen while the mic is on');
check(
  (await ev<string>('document.getElementById("penNote").textContent')) === 'Draw on the slide',
  'the toolbar says to draw',
);
// a phrase first, so the drawing has something to land after
check(await page.waitFor('__onetake.state.segments.length >= 1', 200, 100), 'a phrase was recorded');
// wait for a voice, then put the pen down in the middle of it
check(await page.waitFor('__onetake.state.speaking', 200, 50), 'a voice is being spoken');
const beforePen = await ev<number>('__onetake.state.segments.length');
const r0 = await inkCanvasRect();
await page.send('Input.dispatchMouseEvent', {
  type: 'mouseMoved',
  x: r0.x + 0.2 * r0.w,
  y: r0.y + 0.3 * r0.h,
});
await page.send('Input.dispatchMouseEvent', {
  type: 'mousePressed',
  x: r0.x + 0.2 * r0.w,
  y: r0.y + 0.3 * r0.h,
  button: 'left',
  buttons: 1,
  clickCount: 1,
});
await sleep(60);
check(
  !(await ev<boolean>('__onetake.state.speaking')),
  'the phrase ends the moment the pen touches the slide',
);
check(await ev<boolean>('__onetake.recorder().inking'), 'the recorder knows the pen is down');
check(!(await ev<boolean>('__onetake.recorder().gateOpen')), 'the mic gate is shut while the pen is down');
check(await ev<boolean>('__onetake.state.inking'), 'the app is drawing');
check(
  (await ev<string>('document.getElementById("statusText").textContent')) === 'Drawing',
  'the status pill reads Drawing',
);
check(
  await ev<boolean>(
    'document.getElementById("capFlag").classList.contains("ink") && document.getElementById("capFlag").classList.contains("on")',
  ),
  'the flag on the stage is the drawing one',
);
// draw a line across the top of the slide, well away from the camera's corner
for (let i = 1; i <= 8; i++) {
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: r0.x + (0.2 + 0.05 * i) * r0.w,
    y: r0.y + 0.3 * r0.h,
    button: 'left',
    buttons: 1,
  });
  await sleep(40);
}
check((await shown()) === 1, 'the stroke shows on the stage as it is drawn');
await page.send('Input.dispatchMouseEvent', {
  type: 'mouseReleased',
  x: r0.x + 0.6 * r0.w,
  y: r0.y + 0.3 * r0.h,
  button: 'left',
  clickCount: 1,
});
const penUpAt = Date.now();
await sleep(30);
check(!(await ev<boolean>('__onetake.recorder().inking')), 'the pen is up: the mic may listen again');
check(await ev<boolean>('__onetake.recorder().gateOpen'), 'the gate is open again while the pen rests');
check(await page.waitFor('__onetake.ink() === null', 40, 50), 'the drawing ends (a voice, or the rest)');
const endedAfterMs = Date.now() - penUpAt;
console.log(
  `the drawing ended ${endedAfterMs} ms after the pen came up (${endedAfterMs < 1100 ? 'a voice ended it' : 'the rest ended it'})`,
);
check(endedAfterMs < 1600, 'the drawing ended within the rest');
await page.screenshot('ink-first-stroke.png');
// the drawing is stored after the phrase it cut, once that phrase's review is in
check(
  await page.waitFor(`__onetake.state.segments.length >= ${beforePen + 1}`, 100, 100),
  'the drawing is stored',
);
{
  const segs = await segments();
  const cut = segs[beforePen - 1];
  const drawing = segs[beforePen];
  console.log('after the first drawing:', JSON.stringify(segs));
  check(cut?.ink === null, 'the clip before the drawing is the phrase the pen cut');
  check(Boolean(drawing?.ink), 'the clip after it is the drawing');
  check(drawing?.ink?.strokes.length === 1, 'the drawing has one stroke');
  check(
    (drawing?.ink?.strokes[0]?.points ?? 0) >= 5,
    `the stroke has its points (${drawing?.ink?.strokes[0]?.points})`,
  );
  check(drawing?.ink?.strokes[0]?.color === '#ff3b30', 'the stroke is red');
  check(drawing?.ink?.strokes[0]?.first === 0, 'the stroke begins at the start of its clip');
  const last = drawing?.ink?.strokes[0]?.last ?? 0;
  check(
    Math.abs((drawing?.sec ?? 0) - (last + 150) / 1000) < 0.01,
    `the clip lasts to the last point plus the tail (${drawing?.sec} s for a stroke of ${last} ms)`,
  );
  check(drawing?.video === false, 'a drawing has no camera picture');
  check(drawing?.slide === 0, 'the drawing is on the slide it was drawn on');
}
check((await shown()) === 1, 'the stroke stays on the slide');

/* ------------------------------------------------------------ the rest ends a drawing; undo; colours */
page.step('a drawing that the rest ends');
// press to speak: nothing is heard unless Space is held, so the pen's rest is what ends the drawing
await ev('__onetake.setMode("hold")');
await ev('document.getElementById("pen-color-0673f9").click()');
await ev('document.getElementById("pen-width-thick").click()');
const t1 = Date.now();
await draw(
  [
    { x: 0.2, y: 0.5 },
    { x: 0.4, y: 0.7 },
  ],
  300,
);
await sleep(250);
await ev('document.getElementById("pen-highlighter").click()');
await ev('document.getElementById("pen-color-ffd60a").click()');
await draw(
  [
    { x: 0.2, y: 0.85 },
    { x: 0.55, y: 0.85 },
  ],
  300,
);
check(
  await ev<boolean>('__onetake.ink() !== null'),
  'the drawing is still open right after the second stroke',
);
check((await shown()) === 3, 'three strokes on the stage (one stored, two being drawn)');
check(
  !(await ev<boolean>('document.getElementById("penUndo").disabled')),
  'undo is possible while the drawing is being made',
);
check(await page.waitFor('__onetake.ink() === null', 60, 50), 'the pen rested: the drawing ends by itself');
const restMs = Date.now() - t1;
console.log(`the second drawing ended ${restMs} ms after it began`);
check(await page.waitFor('__onetake.pendingInk() === 0', 50, 100), 'the drawing is stored');
{
  const segs = await segments();
  const d = segs[segs.length - 1];
  check(d?.ink?.strokes.length === 2, 'the drawing has both strokes');
  const [a, b] = d?.ink?.strokes ?? [];
  check(a?.color === '#0673f9' && a.tool === 'pen', 'the first stroke is the blue pen');
  check(b?.color === '#ffd60a' && b.tool === 'highlighter', 'the second stroke is the yellow highlighter');
  const gap = (b?.first ?? 0) - (a?.last ?? 0);
  check(gap > 0 && gap <= 400, `the pause between the strokes is kept, up to 0.4 s (${gap} ms)`);
  check(
    Math.abs((d?.sec ?? 0) - ((b?.last ?? 0) + 150) / 1000) < 0.01,
    'the clip ends a tail after the last point',
  );
}
check((await shown()) === 3, 'three strokes stay on the slide');

page.step('undo');
await draw(
  [
    { x: 0.7, y: 0.2 },
    { x: 0.7, y: 0.4 },
  ],
  200,
);
check((await shown()) === 4, 'a fourth stroke is being drawn');
await ev('document.getElementById("penUndo").click()');
check((await shown()) === 3, 'undo takes the stroke back');
check(await ev<boolean>('__onetake.ink() === null'), 'with nothing left, the drawing is over at once');
check(!(await ev<boolean>('__onetake.recorder().inking')), 'and the mic may listen again');
// Backspace drops a drawing in progress
await draw(
  [
    { x: 0.7, y: 0.2 },
    { x: 0.7, y: 0.4 },
  ],
  200,
);
check((await shown()) === 4, 'another stroke is being drawn');
await page.press('Backspace');
await sleep(100);
check(
  (await shown()) === 3 && (await ev<boolean>('__onetake.ink() === null')),
  'Backspace drops the drawing in progress',
);
await sleep(300);
check(
  (await ev<SegInfo[]>('__onetake.state.segments.map(s => ({ ink: s.ink ? 1 : null }))')).filter((s) => s.ink)
    .length === 2,
  'nothing of the dropped drawings was stored',
);

/* ------------------------------------------------------------ drawings stay on their slide; clear */
page.step('slides and clear');
await ev('__onetake.goTo(1)');
await sleep(150);
check((await shown()) === 0, 'the next slide is bare');
check(await ev<boolean>('document.getElementById("penClear").disabled'), 'nothing to clear on a bare slide');
await ev('document.getElementById("pen-pen").click()');
await ev('document.getElementById("pen-color-34c759").click()');
await ev('document.getElementById("pen-width-medium").click()');
await draw(
  [
    { x: 0.3, y: 0.3 },
    { x: 0.6, y: 0.6 },
  ],
  300,
);
check(await page.waitFor('__onetake.ink() === null', 60, 50), 'the drawing on slide 2 ends');
check(await page.waitFor('__onetake.pendingInk() === 0', 50, 100), 'and is stored');
check((await shown()) === 1, 'slide 2 shows its one stroke');
await ev('__onetake.goTo(0)');
await sleep(150);
check((await shown()) === 3, 'back on slide 1, its three strokes are still there');
check((await shownColors()).join(',') === '#ff3b30,#0673f9,#ffd60a', 'in the order they were drawn');
await ev('__onetake.goTo(1)');
await sleep(150);
check((await shown()) === 1, 'and slide 2 still has its stroke');
check(!(await ev<boolean>('document.getElementById("penClear").disabled')), 'the slide can be cleared');
const beforeClear = await ev<number>('__onetake.state.segments.length');
await ev('document.getElementById("penClear").click()');
await sleep(100);
check((await shown()) === 0, 'clear wipes the slide on the stage at once');
check(
  await page.waitFor(`__onetake.state.segments.length === ${beforeClear + 1}`, 50, 100),
  'the wipe is a clip',
);
{
  const segs = await segments();
  const wipe = segs[segs.length - 1];
  check(wipe?.ink?.wipe === true && wipe.ink.strokes.length === 0, 'the last clip is the wipe');
  check(Math.abs((wipe?.sec ?? 0) - 0.4) < 0.01, 'a wipe shows the clean slide for 0.4 s');
  check(wipe?.slide === 1, 'on slide 2');
}
await ev('__onetake.goTo(0)');
await sleep(150);
check((await shown()) === 3, 'slide 1 keeps its strokes through the other slide being cleared');
// a phrase on slide 1 after the drawings, for the export's frames: hold Space until one lands
page.step('a phrase after the drawings');
{
  const before = await ev<number>('__onetake.state.segments.length');
  await page.key(' ', 'keyDown');
  const landed = await page.waitFor(
    `__onetake.state.segments.length > ${before} || __onetake.state.speaking`,
    120,
    100,
  );
  if (await ev<boolean>('__onetake.state.speaking')) await page.waitFor('!__onetake.state.speaking', 60, 100);
  await page.key(' ', 'keyUp');
  check(landed, 'a voice was heard while Space was held');
}
await ev('__onetake.stopMic()');
await ev('__onetake.settled()');
await sleep(300);
check(
  !(await ev<boolean>('__onetake.inkStage.canDraw')),
  'with the mic off the slide no longer takes the pen',
);
check((await shown()) === 3, 'the strokes stay on the stage with the mic off');
const all = await segments();
console.log('all clips:', JSON.stringify(all));
const inkClips = all.map((s, i) => ({ s, i })).filter(({ s }) => s.ink !== null);
check(inkClips.length === 4, `four pen clips (${inkClips.length}): three drawings and a wipe`);
check(
  (await ev<number>('document.querySelectorAll("#segs .seg.ink").length')) === 4,
  'the timeline marks the four pen clips',
);
check(
  (await ev<string>('document.querySelectorAll("#segs .seg.ink small")[0].textContent')).includes('1 stroke'),
  'a drawing row says how many strokes it has',
);
check(
  (await ev<string>('document.querySelectorAll("#segs .seg.ink small")[3].textContent')).includes('cleared'),
  'the wipe row says the slide was cleared',
);
await page.screenshot('ink-recorded.png');

/* ------------------------------------------------------------ the preview draws the strokes */
page.step('preview');
interface Item {
  from: number;
  start: number;
  end: number;
  slide: number;
  ink: boolean;
  wipe: boolean;
  strokes: number;
}
const items = await ev<Item[]>(
  `__onetake.timeline('recorded').items.map(it => ({ from: it.from, start: it.start, end: it.end, slide: it.seg.slide, ink: Boolean(it.seg.ink), wipe: Boolean(it.seg.ink?.wipe), strokes: it.seg.ink?.strokes.length ?? 0 }))`,
);
const firstInk = items.findIndex((it) => it.ink);
await ev(`__onetake.startPreview(${firstInk})`);
await sleep(Math.round(((items[firstInk]?.end ?? 0) - (items[firstInk]?.start ?? 0)) * 1000) + 600);
{
  const painted = await ev<number>(
    '(() => { const c = document.querySelector("#stage .ink-layer canvas"); if (!c || !c.width) return -1; const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 170 && d[i+1] < 110 && d[i+2] < 110 && d[i+3] > 200) n++; return n; })()',
  );
  console.log(`preview: ${painted} red pixels on the ink canvas`);
  check(painted > 100, 'the preview draws the red stroke on the stage');
  check(
    !(await ev<boolean>('document.querySelector("#stage .ink-layer").hidden')),
    'the ink layer shows during the preview',
  );
}
await page.screenshot('ink-preview.png');
await ev('__onetake.stopPreview()');
await sleep(200);
check((await shown()) === 3, "after the preview the stage shows the current slide's board again");

/* ------------------------------------------------------------ export: the strokes in the frames */
page.step('export');
interface ServerResult {
  job: { state: string; error?: string; outputs: { path: string }[] };
  timing: { elapsedMs: number; encodeMs: number; videoSeconds: number };
}
const res = await ev<ServerResult>(
  `__onetake.exportWith(${JSON.stringify({ fileName: 'ink', container: 'mp4', resolution: { preset: '720p' }, fps: 24 })})`,
  10 * 60_000,
);
check(res.job.state === 'done', `mp4 export done${res.job.error ? ` (${res.job.error})` : ''}`);
console.log(
  `export: ${(res.timing.videoSeconds / (res.timing.encodeMs / 1000)).toFixed(1)}× real time encode, ${(res.timing.elapsedMs / 1000).toFixed(1)} s in all`,
);
{
  const file = res.job.outputs[0]?.path ?? '';
  const p = probe(file);
  const v = video(p);
  check(v?.codec_name === 'h264' && v.width === 1280 && v.height === 720, 'mp4 is h264 1280x720');
  const frameAt = (sec: number, name: string) => {
    const out = path.join(OUT, name);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', sec.toFixed(3), '-i', file, '-frames:v', '1', out]);
    return countColours(out);
  };
  const first = items[firstInk];
  const second = items.findIndex((it, i) => it.ink && i > firstInk);
  const sec2 = items[second];
  const wipeIdx = items.findIndex((it) => it.wipe);
  const greenIdx = items.findIndex((it) => it.ink && it.slide === 1 && !it.wipe);
  const voiceAfter = items.findIndex((it, i) => !it.ink && it.slide === 0 && i > second);
  // before the first drawing: a bare slide
  const bare = frameAt(Math.max(0.05, (items[0]?.start ?? 0) + 0.2), 'frame-bare.png');
  console.log('bare slide:', JSON.stringify(bare));
  check(bare.red < 20 && bare.blue < 20, 'before any drawing the frame has no pen colours');
  // early in the first drawing: only part of the red stroke
  const early = frameAt((first?.start ?? 0) + 0.06, 'frame-early.png');
  // a frame's time is where it starts, and the tail after the last point is 0.15 s: 0.2 s before the
  // end the stroke is all but drawn and the frame is still the clip's
  const late = frameAt((first?.end ?? 0) - 0.2, 'frame-late.png');
  console.log('first drawing early:', JSON.stringify(early), 'late:', JSON.stringify(late));
  check(early.red > 20, 'the red stroke has begun early in its clip');
  check(
    late.red > early.red * 1.5,
    'and is drawn further by the end of the clip (the pen moves in the video)',
  );
  // during the second drawing: red stays, blue and yellow come
  const mid2 = frameAt((sec2?.end ?? 0) - 0.2, 'frame-second.png');
  console.log('second drawing:', JSON.stringify(mid2));
  check(mid2.red > 100, 'the red stroke stays on the slide for the next drawing');
  check(mid2.blue > 100, 'the blue stroke is there by the end of the second drawing');
  check(mid2.yellow > 100, 'and the yellow highlight');
  // the phrase on slide 1 after the drawings shows all of them
  if (voiceAfter >= 0) {
    const va = items[voiceAfter];
    const vf = frameAt(
      (va?.start ?? 0) + Math.min(0.3, ((va?.end ?? 0) - (va?.start ?? 0)) / 2),
      'frame-voice-after.png',
    );
    console.log('voice after the drawings:', JSON.stringify(vf));
    check(vf.red > 100 && vf.blue > 100 && vf.yellow > 100, 'a phrase after the drawings shows them all');
  } else {
    check(false, 'a phrase was recorded on slide 1 after the drawings');
  }
  // slide 2: the green stroke, then the wipe takes it away
  const g = items[greenIdx];
  const gf = frameAt((g?.end ?? 0) - 0.2, 'frame-green.png');
  const w = items[wipeIdx];
  const wf = frameAt((w?.start ?? 0) + 0.2, 'frame-wiped.png');
  console.log('green drawing:', JSON.stringify(gf), 'after the wipe:', JSON.stringify(wf));
  check(gf.green > 100, 'the green stroke is in the frames of slide 2');
  check(wf.green < 20 && wf.red < 20, 'after the wipe the slide is clean');
  // where the red stroke is, once complete: along y = 30 % of the slide, from x = 20 % to 60 %; the
  // slide fills the 16:9 frame
  const row = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      path.join(OUT, 'frame-voice-after.png'),
      '-vf',
      'crop=1280:12:0:210',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  let firstRed = -1;
  let lastRed = -1;
  for (let x = 0; x < 1280; x++) {
    let redHere = false;
    for (let y = 0; y < 12 && !redHere; y++) {
      const i = (y * 1280 + x) * 3;
      redHere = (row[i] ?? 0) > 170 && (row[i + 1] ?? 0) < 110 && (row[i + 2] ?? 0) < 110;
    }
    if (redHere) {
      if (firstRed < 0) firstRed = x;
      lastRed = x;
    }
  }
  console.log(`red stroke spans x = ${firstRed}..${lastRed} of 1280 at y ≈ 216`);
  check(
    firstRed > 0.2 * 1280 - 30 && firstRed < 0.2 * 1280 + 30,
    'the stroke starts where the pen went down (20 % across)',
  );
  check(
    lastRed > 0.6 * 1280 - 40 && lastRed < 0.6 * 1280 + 30,
    'and ends where the pen came up (60 % across)',
  );
  fs.copyFileSync(file, path.join(OUT, 'ink.mp4'));
}

/* ------------------------------------------------------------ the editor */
page.step('editor');
await ev('__onetake.openEditor()');
await sleep(300);
const edInk = inkClips[0]?.i ?? 1;
await ev(`__onetake.editor.select(${edInk}, true)`);
await sleep(150);
check(
  (await ev<string>('document.getElementById("edClipTitle").textContent')).includes('drawing'),
  'the editor names a drawing clip',
);
check(
  (await ev<string>('document.getElementById("edWaveHint").textContent')).includes('drawing'),
  'the hint explains the stroke bars',
);
check(
  (await ev<string>('document.getElementById("edRerecord").textContent')).includes('Replace with voice'),
  'a drawing is replaced with a voice, not re-recorded',
);
check(
  await ev<boolean>(
    'document.querySelector("#editor .voicing") === null || document.querySelector("#editor .voicing").hidden',
  ),
  'no sound versions for a drawing',
);
// seek into the phrase after the drawings: the editor's screen shows the strokes
{
  const va = items.findIndex((it, i) => !it.ink && it.slide === 0 && i > (inkClips[1]?.i ?? 0));
  const target = items[va];
  await ev(`__onetake.editor.seek(${((target?.start ?? 0) + 0.1).toFixed(3)})`);
  await sleep(200);
  const painted = await ev<number>(
    '(() => { const c = document.querySelector("#editor .ink-layer canvas"); if (!c || !c.width) return -1; const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i+3] > 100) n++; return n; })()',
  );
  console.log(`editor: ${painted} drawn pixels on its ink canvas`);
  check(painted > 300, 'the editor shows the strokes at the playhead');
}
await page.screenshot('ink-editor.png');
// split the second drawing in the middle: both halves keep their strokes
{
  const idx = inkClips[1]?.i ?? 2;
  const it = items[idx];
  const before = await segments();
  const points = before[idx]?.ink?.strokes.reduce((n, s) => n + s.points, 0) ?? 0;
  await ev(`__onetake.editor.select(${idx}, true)`);
  await ev(`__onetake.editor.seek(${(((it?.start ?? 0) + (it?.end ?? 0)) / 2).toFixed(3)})`);
  await ev('document.getElementById("edSplit").click()');
  await sleep(200);
  const after = await segments();
  check(after.length === before.length + 1, 'the split made one more clip');
  const a = after[idx];
  const b = after[idx + 1];
  check(a?.ink !== null && b?.ink !== null, 'both halves are drawings');
  const sum =
    (a?.ink?.strokes.reduce((n, s) => n + s.points, 0) ?? 0) +
    (b?.ink?.strokes.reduce((n, s) => n + s.points, 0) ?? 0);
  check(sum === points, `no point was lost in the split (${sum} of ${points})`);
  check(b?.joined === true, 'the second half continues the first');
  // undo puts it back
  await ev('document.getElementById("edUndo").click()');
  await sleep(200);
  check((await segments()).length === before.length, 'undo joins them again');
}
await ev('__onetake.editor.close()');
await sleep(200);

/* ------------------------------------------------------------ reload: the drawings are kept */
page.step('reload');
await page.reload();
await page.waitForApp();
await sleep(500);
await ev('document.getElementById("btnRestore").click()');
for (let i = 0; i < 100 && (await ev<number>('__onetake.state.segments.length')) === 0; i++) await sleep(200);
await sleep(300);
{
  const restored = await segments();
  check(restored.length === all.length, 'every clip came back');
  check(restored.filter((s) => s.ink).length === 4, 'the four pen clips came back');
  check(
    JSON.stringify(restored.map((s) => s.ink)) === JSON.stringify(all.map((s) => s.ink)),
    'with their strokes as they were',
  );
  check((await shown()) === 3, "the stage shows the current slide's strokes after the reload");
  check(await ev<boolean>('__onetake.prefs().record === "annotate"'), 'the pen mode is remembered');
  check(await ev<boolean>('!document.getElementById("penBar").hidden'), 'the toolbar is back');
  check(await ev<boolean>('__onetake.prefs().pen.color === "#34c759"'), 'the pen keeps its last colour');
}
await ev('__onetake.setRecordMode("voice")');
await sleep(200);
check(
  await ev<boolean>('document.getElementById("penBar").hidden'),
  'back in the voice mode the toolbar goes',
);
check((await shown()) === 3, 'but the drawings already made stay on the slide');
check(await ev<boolean>('!__onetake.camera.on'), 'and the camera closes');
check(page.errors().length === 0, `no page errors (${page.errors().join(' | ')})`);
page.close();
finish(`screenshots, frames and ink.mp4 in ${OUT}`);
