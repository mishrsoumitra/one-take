/**
 * Long-session stress in the real app: headless Chrome, the built client, the real server, and a
 * generated voice as the microphone. For as long as asked (two minutes by default, hours if you like)
 * it talks through a twelve-slide deck while moving back and forth between slides with real key
 * presses, switching between auto and press to speak, holding Space and the stage button, deleting
 * and undoing, muting, and stopping and restarting the mic. Every minute it checks the phrases, the
 * timeline and the heap; at the end it stops, reloads, resumes, previews and exports the whole thing.
 *
 * Previews in the middle of the session are opt-in (`--preview`): in this headless Chrome, once a
 * preview has played, a later microphone stop wedges the browser's fake audio stack after about a
 * minute (every app call completes; the page then stops answering inside native code). It has not
 * been reproduced with a real microphone; check that sequence by hand on real hardware.
 *
 *   npm run e2e:stress                       (builds first; two minutes)
 *   tsx packages/e2e/src/stress.ts --minutes 30
 *   tsx packages/e2e/src/stress.ts --hours 3 --out /tmp/one-take-stress
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  audio,
  check,
  finish,
  MODIFIER,
  Page,
  probe,
  ROOT,
  sleep,
  startChrome,
  startServer,
  video,
} from './harness.js';
import { writeStressFixtures } from './make-fixtures.js';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    port: { type: 'string' },
    minutes: { type: 'string' },
    hours: { type: 'string' },
    seed: { type: 'string' },
    'no-export': { type: 'boolean' },
    verbose: { type: 'boolean' },
    preview: { type: 'boolean' },
  },
});
const OUT = path.resolve(values.out ?? path.join(ROOT, 'packages/e2e/stress-out'));
const PORT = Number(values.port ?? 4499);
const CDP_PORT = PORT + 1;
const MINUTES = values.hours ? Number(values.hours) * 60 : Number(values.minutes ?? 2);
const SEED = Number(values.seed ?? 20261009);

let seed = SEED >>> 0;
const random = (): number => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const between = (lo: number, hi: number) => lo + random() * (hi - lo);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
// Voice for the whole run plus a margin, played once; beyond an hour the file loops (see make-fixtures).
const WAV_SECONDS = Math.min((MINUTES + 4) * 60, 60 * 60);
const fixtures = writeStressFixtures(path.join(OUT, 'fixtures'), WAV_SECONDS);
const LOOP = WAV_SECONDS < (MINUTES + 4) * 60;
const exportsDir = path.join(OUT, 'exports');
fs.mkdirSync(exportsDir, { recursive: true });

await startServer(PORT, exportsDir);
startChrome({ cdpPort: CDP_PORT, profileDir: path.join(OUT, 'profile'), wav: fixtures.wav, loop: LOOP });
const page = await Page.open(CDP_PORT, OUT);
// The whole run, the final export included, must be over well within this; otherwise the script
// reports where it stalled and exits instead of waiting forever.
page.watchdog((MINUTES + 20) * 60_000);
page.step('loading the deck');
const ev = <T = unknown>(expression: string, timeoutMs?: number) => page.ev<T>(expression, timeoutMs);
await page.navigate(`http://127.0.0.1:${PORT}/`);
await page.waitForApp();
if (values.verbose) {
  await page.traceAudio();
  await page.enableStackDump();
}

await page.setFiles('#fileIn', [fixtures.pdf]);
check(
  await page.waitFor(`__onetake.state.slides.length === ${fixtures.pages}`, 150, 200),
  `${fixtures.pages} slides rendered`,
);
check(
  !(await ev<boolean>('document.getElementById("welcome").classList.contains("on")')),
  'welcome tour closed',
);

/* ------------------------------------------------------------------ what the page knows */

interface Snapshot {
  problems: string[];
  orphans: number;
  phrases: number;
  seconds: number;
  pcmMb: number;
  bufferedMs: number;
  speaking: boolean;
  held: boolean;
  armed: boolean;
  muted: boolean;
  mode: string;
  slide: number;
  perSlide: number[];
}

/** Runs inside the page: checks every phrase and both timelines, and reports the numbers. */
const SNAPSHOT = `(() => {
  const s = __onetake.state;
  const problems = [];
  let orphans = 0;
  let total = 0;
  const n = s.slides.length;
  const perSlide = new Array(n).fill(0);
  s.segments.forEach((seg, i) => {
    if (!(seg.slide >= 0 && seg.slide < n)) problems.push('phrase ' + (i + 1) + ' is on slide ' + (seg.slide + 1) + ' of ' + n);
    if (!(seg.pcm.length > 0)) problems.push('phrase ' + (i + 1) + ' is empty');
    if (!(seg.sampleRate > 8000)) problems.push('phrase ' + (i + 1) + ' has sample rate ' + seg.sampleRate);
    if (!seg.id || typeof seg.createdAt !== 'number') problems.push('phrase ' + (i + 1) + ' has no id or time');
    if (seg.joined && s.segments[i - 1]?.id !== seg.prevId) orphans++;
    if (!seg.joined && seg.prevId !== null) problems.push('phrase ' + (i + 1) + ' has a prevId but is not joined');
    const d = seg.pcm.length / seg.sampleRate;
    total += d;
    if (seg.slide < n) perSlide[seg.slide] += d;
  });
  for (const order of ['recorded', 'slide']) {
    const tl = __onetake.timeline(order);
    if (tl.items.length !== s.segments.length) problems.push(order + ': ' + tl.items.length + ' items for ' + s.segments.length + ' phrases');
    let t = 0;
    for (const it of tl.items) {
      if (Math.abs(it.from - t) > 1e-6) problems.push(order + ': item ' + it.seg.id + ' starts at ' + it.from + ' not ' + t);
      if (!(it.end >= it.start && it.start >= it.from && it.dur > 0)) problems.push(order + ': item ' + it.seg.id + ' has bad times');
      if (it.joined && it.gap !== 0) problems.push(order + ': joined item ' + it.seg.id + ' has a gap');
      t = it.end;
    }
    if (!Number.isFinite(tl.total) || Math.abs(tl.total - t) > 1e-6) problems.push(order + ': total ' + tl.total + ' vs ' + t);
    if (tl.total < total - 1e-6) problems.push(order + ': shorter than the phrases');
  }
  const ids = new Set(s.segments.map((x) => x.id));
  if (ids.size !== s.segments.length) problems.push('duplicate phrase ids');
  const vad = __onetake.vad();
  return {
    problems,
    orphans,
    phrases: s.segments.length,
    seconds: total,
    pcmMb: s.segments.reduce((a, x) => a + x.pcm.byteLength, 0) / 1048576,
    bufferedMs: vad ? vad.bufferedMs : 0,
    speaking: s.speaking,
    held: s.held,
    armed: s.armed,
    muted: s.muted,
    mode: s.mode,
    slide: s.current,
    perSlide,
  };
})()`;
const snapshot = () => ev<Snapshot>(SNAPSHOT);
const status = () => ev<string>('document.getElementById("statusText").textContent');
const phrases = () => ev<number>('__onetake.state.segments.length');
const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/* ------------------------------------------------------------------ the two modes, deterministically */

page.step('checking the two modes');
check(await page.startMic(), 'mic started in auto mode');
await sleep(8000);
const autoPhrases = await phrases();
check(autoPhrases > 0, `auto mode recorded ${autoPhrases} phrases in eight seconds of talk`);

await ev('document.getElementById("modeHold").click()');
check((await ev<string>('__onetake.state.mode')) === 'hold', 'switched to press to speak with the mic on');
check((await status()) === 'Hold Space to speak', `status reads "${await status()}"`);
const beforeHold = await phrases();
await sleep(6000);
check((await phrases()) === beforeHold, 'six seconds of talk with the key up recorded nothing');
check(
  (await ev<number>('__onetake.state.segments.length')) === beforeHold &&
    !(await ev<boolean>('__onetake.state.speaking')),
  'the detector is idle while the key is up',
);
const slideBefore = await ev<number>('__onetake.state.current');
await page.key(' ', 'keyDown');
for (let i = 0; i < 6; i++) {
  await sleep(50);
  await page.key(' ', 'keyDown', { repeat: true });
}
check(await ev<boolean>('__onetake.state.held'), 'Space is held');
check(
  (await ev<number>('__onetake.state.current')) === slideBefore,
  'Space (and its auto-repeat) did not move the slide',
);
await sleep(4000); // the loop never stays quiet longer than 2.5 s, so a 4 s hold always catches speech
const during = await status();
check(during === 'Recording' || during === 'Speak now', `status while held reads "${during}"`);
await page.key(' ', 'keyUp');
await sleep(300);
check(
  !(await ev<boolean>('__onetake.state.held')) && !(await ev<boolean>('__onetake.state.speaking')),
  'key up ends the hold and the phrase',
);
check(
  (await phrases()) > beforeHold,
  `holding Space for four seconds recorded ${(await phrases()) - beforeHold} phrase(s)`,
);
const beforeMouse = await phrases();
check(await page.mouseDown('#btnHold'), 'mouse down on the stage button');
await sleep(200);
check(await ev<boolean>('__onetake.state.held'), 'the stage button holds');
await sleep(4000);
await page.mouseUp('#btnHold');
await sleep(300);
check((await phrases()) > beforeMouse, 'holding the stage button recorded a phrase');
await page.screenshot('press-to-speak.png');
await ev('document.getElementById("modeAuto").click()');
check((await ev<string>('__onetake.state.mode')) === 'auto', 'back in auto mode');

/* ------------------------------------------------------------------ the long random session */

page.step('the random session');
const deadline = Date.now() + MINUTES * 60_000;
let restartFailures = 0;
const started = Date.now();
const heapStart = await page.heapMb();
let mode: 'auto' | 'hold' = 'auto';
let nextReport = Date.now() + 60_000;
let actions = 0;
let holds = 0;
let slideMoves = 0;
let modeSwitches = 0;
let deletes = 0;
let restarts = 0;
let previews = 0;
let maxHeap = heapStart;
let maxBuffered = 0;
const errorsSeen = new Set<string>();

const armed = () => ev<boolean>('__onetake.state.armed');
/** Names the action for the stall report and, with --verbose, prints it with the time since start. */
const act = async (label: string, fn: () => Promise<unknown>) => {
  page.step(label);
  if (values.verbose) console.log(`  ${((Date.now() - started) / 1000).toFixed(1).padStart(6)} s  ${label}`);
  await fn();
};
const slideKey = async () => {
  const r = random();
  if (r < 0.45) await act('→', () => page.press('ArrowRight'));
  else if (r < 0.75) await act('←', () => page.press('ArrowLeft'));
  else if (r < 0.85) await act('PageDown', () => page.press('PageDown'));
  else if (r < 0.9) await act('Home', () => page.press('Home'));
  else if (r < 0.95) await act('End', () => page.press('End'));
  else {
    const n = Math.floor(random() * fixtures.pages);
    await act(`jump to slide ${n + 1}`, () => ev(`__onetake.goTo(${n})`));
  }
  slideMoves++;
};

while (Date.now() < deadline) {
  await sleep(between(300, 2000));
  actions++;
  const r = random();
  if (r < 0.4) {
    await slideKey();
  } else if (r < 0.58 && mode === 'hold' && (await armed())) {
    // a press: sometimes with a slide change inside, sometimes with the mouse
    holds++;
    const mouse = random() < 0.3;
    const length = between(800, 5000);
    const how = mouse ? 'the stage button' : 'Space';
    await act(`hold ${how} for ${(length / 1000).toFixed(1)} s`, () =>
      mouse ? page.mouseDown('#btnHold') : page.key(' ', 'keyDown'),
    );
    if (random() < 0.3) {
      await sleep(length / 2);
      await slideKey();
      await sleep(length / 2);
    } else {
      await sleep(length);
    }
    await act(`release ${how}`, () => (mouse ? page.mouseUp('#btnHold') : page.key(' ', 'keyUp')));
  } else if (r < 0.66) {
    mode = mode === 'auto' ? 'hold' : 'auto';
    await act(`switch to ${mode}`, () =>
      ev(`document.getElementById(${JSON.stringify(mode === 'auto' ? 'modeAuto' : 'modeHold')}).click()`),
    );
    modeSwitches++;
  } else if (r < 0.72) {
    await act('Backspace', () => page.press('Backspace'));
    deletes++;
    if (random() < 0.5) {
      await sleep(between(200, 800));
      await act('Ctrl+Z', () => page.press('z', MODIFIER.ctrl));
    }
  } else if (r < 0.76 && mode === 'auto' && (await armed())) {
    await act('M (mute)', () => page.press('m'));
    await sleep(between(1000, 3000));
    await act('M (unmute)', () => page.press('m'));
  } else if (r < 0.8) {
    await act('R (mic off)', () => page.press('r'));
    await sleep(between(800, 2000));
    if (!(await armed())) {
      await act('R (mic on)', () => page.press('r'));
      if (!(await page.waitFor('__onetake.state.armed', 100, 100))) restartFailures++;
    }
    restarts++;
  } else if (r < 0.84 && values.preview && (await phrases()) > 0) {
    await act('preview', () => ev('document.getElementById("btnPreview").click()'));
    previews++;
    await sleep(between(1500, 3000));
    await act('Escape (stop preview)', () => page.press('Escape'));
  } else {
    await act('just talking', () => sleep(between(2000, 6000)));
  }
  if (Date.now() >= nextReport) {
    nextReport += 60_000;
    page.step(`the random session, minute ${Math.round((Date.now() - started) / 60_000)}`);
    const snap = await snapshot();
    const heap = await page.heapMb();
    maxHeap = Math.max(maxHeap, heap);
    maxBuffered = Math.max(maxBuffered, snap.bufferedMs);
    const minute = Math.round((Date.now() - started) / 60_000);
    console.log(
      `  ${String(minute).padStart(3)} min  ${snap.phrases} phrases, ${fmt(snap.seconds)} recorded (${snap.pcmMb.toFixed(1)} MB pcm), ` +
        `heap ${heap.toFixed(1)} MB, ${snap.mode}${snap.armed ? '' : ' (mic off)'}, slide ${snap.slide + 1}, ${snap.orphans} orphan continuations`,
    );
    if (snap.problems.length) check(false, `minute ${minute}: ${snap.problems.slice(0, 5).join(' | ')}`);
    for (const e of page.errors()) {
      if (!errorsSeen.has(e)) {
        errorsSeen.add(e);
        check(false, `page error at minute ${minute}: ${e}`);
      }
    }
  }
}

/* ------------------------------------------------------------------ the end: stop, verify, resume, export */

page.step('stopping');
await page.key(' ', 'keyUp');
await page.press('Escape');
if (!(await armed())) check(await page.startMic(), 'the mic starts again at the end');
check(restartFailures === 0, `every mic restart during the session armed again (${restartFailures} did not)`);
await sleep(500);
await ev('__onetake.stopMic()');
const finalSnap = await snapshot();
const heapEnd = await page.heapMb();
const elapsedMin = (Date.now() - started) / 60_000;
console.log(
  `\nran ${elapsedMin.toFixed(1)} min: ${actions} actions (${slideMoves} slide moves, ${holds} holds, ${modeSwitches} mode switches, ` +
    `${deletes} deletes, ${restarts} mic restarts, ${previews} previews); ${finalSnap.phrases} phrases, ${fmt(finalSnap.seconds)} recorded, ` +
    `${finalSnap.pcmMb.toFixed(1)} MB of pcm; heap ${heapStart.toFixed(1)} → ${heapEnd.toFixed(1)} MB (peak ${maxHeap.toFixed(1)}); ` +
    `detector buffer peak ${maxBuffered} ms`,
);
console.log('seconds per slide:', finalSnap.perSlide.map((d) => d.toFixed(0)).join(' '));
check(
  finalSnap.problems.length === 0,
  `phrases and timelines consistent${finalSnap.problems.length ? `: ${finalSnap.problems.slice(0, 5).join(' | ')}` : ''}`,
);
check(finalSnap.phrases > MINUTES * 3, `recorded ${finalSnap.phrases} phrases in ${MINUTES} minutes`);
check(
  finalSnap.perSlide.filter((d) => d > 0).length >= Math.min(fixtures.pages, 6),
  'the talk landed on many different slides',
);
check(
  !finalSnap.speaking && !finalSnap.held && !finalSnap.armed,
  'mic off, nothing held, nothing being spoken',
);
check(
  finalSnap.seconds < elapsedMin * 60 * 0.9,
  `pauses were removed: ${fmt(finalSnap.seconds)} kept out of ${fmt(elapsedMin * 60)}`,
);
check(
  maxBuffered <= 230 + 60_000,
  `the detector never held more than one phrase (${(maxBuffered / 1000).toFixed(1)} s)`,
);
// the V8 heap holds the phrase objects and the DOM; the audio itself is in typed arrays outside it
check(heapEnd - heapStart < 150, `heap growth ${(heapEnd - heapStart).toFixed(1)} MB over the run`);
await page.screenshot('end.png');

// reload: everything written to IndexedDB as it happened must come back, and the mode too
page.step('reloading and resuming');
const modeBefore = await ev<string>('__onetake.state.mode');
await page.reload();
await sleep(800);
check(
  await ev<boolean>('document.getElementById("restore").classList.contains("on")'),
  'restore banner offered after reload',
);
await ev('document.getElementById("btnRestore").click()');
check(
  await page.waitFor(`__onetake.state.segments.length === ${finalSnap.phrases}`, 300, 200),
  `all ${finalSnap.phrases} phrases restored`,
);
await sleep(500);
const restored = await snapshot();
check(
  Math.abs(restored.seconds - finalSnap.seconds) < 1e-6,
  `restored ${fmt(restored.seconds)} of audio, as recorded`,
);
check(restored.problems.length === 0, 'restored phrases and timelines consistent');
check(
  (await ev<string>('__onetake.state.mode')) === modeBefore,
  `the recording mode (${modeBefore}) survived the reload`,
);
check((await ev<number>('__onetake.state.slides.length')) === fixtures.pages, 'slides restored');

// preview the long result: it starts, moves through slides, and stops on Escape
await ev('document.getElementById("btnPreview").click()');
await sleep(2500);
check(await ev<boolean>('__onetake.state.previewing'), 'preview of the long session plays');
await page.press('Escape');
await sleep(200);
check(!(await ev<boolean>('__onetake.state.previewing')), 'Escape stops it');

// export the whole thing to MP4 and check the duration matches the timeline
if (!values['no-export']) {
  page.step('exporting');
  const tl = await ev<{ total: number }>('(()=>({ total: __onetake.timeline("recorded").total }))()');
  const exportStart = Date.now();
  const result = await ev<{
    job: { state: string; outputs: { path: string; bytes: number }[]; error: string | null };
    timing: { elapsedMs: number; encodeMs: number; videoSeconds: number };
  }>(
    `__onetake.exportWith(${JSON.stringify({ fileName: 'stress', container: 'mp4', resolution: { preset: '360p' }, fps: 5 })})`,
    15 * 60_000, // a long session takes a while to encode; the watchdog covers the rest
  );
  const exportSec = (Date.now() - exportStart) / 1000;
  check(
    result.job.state === 'done',
    `export of ${fmt(tl.total)} done in ${exportSec.toFixed(1)} s${result.job.error ? ` (${result.job.error})` : ''}`,
  );
  const file = result.job.outputs[0]?.path ?? '';
  if (fs.existsSync(file)) {
    const p = probe(file);
    const dur = Number(p.format.duration);
    check(
      Math.abs(dur - (tl.total + 0.25)) < 0.5,
      `mp4 duration ${fmt(dur)} matches the timeline ${fmt(tl.total)}`,
    );
    check(video(p)?.codec_name === 'h264' && audio(p)?.codec_name === 'aac', 'mp4 is h264 with aac');
    console.log(
      `export: ${(result.job.outputs[0]?.bytes ?? 0) / 1048576 > 1 ? ((result.job.outputs[0]?.bytes ?? 0) / 1048576).toFixed(1) + ' MB' : `${result.job.outputs[0]?.bytes ?? 0} bytes`}, ${(result.timing.videoSeconds / (result.timing.encodeMs / 1000)).toFixed(1)}× real time encode`,
    );
  }
}

const bad = page.errors();
check(bad.length === 0, `no page errors${bad.length ? `: ${bad.slice(0, 5).join(' | ')}` : ''}`);
page.close();
finish(`${elapsedMin.toFixed(1)} minutes of talking, outputs in ${OUT}`);
