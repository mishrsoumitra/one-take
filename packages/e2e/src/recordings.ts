/**
 * End-to-end check of recordings on disk: a deck is loaded and spoken over in one browser, the
 * recording lands in the server's recordings folder phrase by phrase (each file's hash checked
 * against the manifest), then a second browser with nothing in its storage continues it from the
 * slide it was left on, records more (with the camera and the pen), and exports one video of both
 * sittings. A third fresh browser continues again, starts afresh on the same deck, is offered the
 * saved recording when the same deck is loaded, and deletes a recording from the Library.
 *
 *   npm run e2e:recordings            (builds first)
 *   tsx packages/e2e/src/recordings.ts --out /tmp/one-take-recordings
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  audio,
  check,
  finish,
  Page,
  probe,
  ROOT,
  sleep,
  startChrome,
  startServer,
  video,
} from './harness.js';
import { writeFixtures } from './make-fixtures.js';

const { values } = parseArgs({ options: { out: { type: 'string' }, port: { type: 'string' } } });
const OUT = path.resolve(values.out ?? path.join(ROOT, 'packages/e2e/recordings-out'));
const PORT = Number(values.port ?? 4699);
const URL = `http://127.0.0.1:${PORT}/`;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const fixtures = await writeFixtures(path.join(OUT, 'fixtures'));
const exportsDir = path.join(OUT, 'exports');
fs.mkdirSync(exportsDir, { recursive: true });
await startServer(PORT, exportsDir);
const recordingsDir = path.join(OUT, 'data', 'recordings');

interface Summary {
  id: string;
  name: string;
  slides: number;
  deckReady: boolean;
  phrases: number;
  seconds: number;
  current: number;
  lastSlide: number;
  sittings: number;
  camera: boolean;
  ink: boolean;
  path: string;
}
interface Phrase {
  id: string;
  slide: number;
  seconds: number;
  sitting: number;
  kind: 'voice' | 'ink';
  camera: boolean;
  sha256: string;
  bytes: number;
}
interface Manifest {
  id: string;
  deckReady: boolean;
  phrases: Phrase[];
  order: string[];
  current: number;
  sitting: number;
  sittings: { n: number; fromSlide: number }[];
  path: string;
}
interface Seg {
  id: string;
  slide: number;
  sec: number;
  sitting: number | null;
  joined: boolean;
  raw: boolean;
  ink: number | null;
  video: boolean;
}
interface RecordingHook {
  id: string | null;
  sitting: number;
  sittings: { n: number; fromSlide: number }[];
  sync: { kind: string; pending?: number };
  pending: number;
}

const api = async <T>(p: string): Promise<T> =>
  (await fetch(`http://127.0.0.1:${PORT}${p}`)).json() as Promise<T>;
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const SEGS =
  '__onetake.state.segments.map(s=>({id:s.id, slide:s.slide, sec:+(s.pcm.length/s.sampleRate).toFixed(3), sitting:s.sitting ?? null, joined:s.joined, raw:s.raw instanceof Int16Array, ink:s.ink ? s.ink.strokes.length : null, video:Boolean(s.video)}))';

/** The first Start mic in a fresh profile offers the voice enrollment; it is skipped here. */
async function skipEnrollment(page: Page): Promise<void> {
  await page.ev('void __onetake.startMic()');
  if (await page.waitFor('__onetake.enroll.isOpen', 50, 100)) {
    await page.ev('document.getElementById("enrollSkip").click()');
    await page.waitFor('!__onetake.enroll.isOpen', 20, 100);
  }
}

/** Checks every phrase file of a recording against its manifest entry. */
function checkFiles(rec: Manifest, label: string): void {
  let ok = true;
  for (const p of rec.phrases) {
    const file = path.join(rec.path, 'phrases', `${p.id}.phrase`);
    if (!fs.existsSync(file) || fs.statSync(file).size !== p.bytes || sha(file) !== p.sha256) {
      ok = false;
      console.log(`  phrase ${p.id}: ${fs.existsSync(file) ? 'hash or size differs' : 'file missing'}`);
    }
  }
  check(ok, `${label}: every phrase file on disk matches the manifest's size and SHA-256`);
}

/* ================================================================== sitting 1: a fresh browser */
let chrome = startChrome({
  cdpPort: PORT + 1,
  profileDir: path.join(OUT, 'profile-1'),
  wav: fixtures.wav,
  loop: false,
});
let page = await Page.open(PORT + 1, OUT);
page.watchdog(20 * 60_000);
let ev = <T = unknown>(expression: string, timeoutMs?: number) => page.ev<T>(expression, timeoutMs);
page.step('sitting 1: loading the deck');
await page.navigate(URL);
await page.waitForApp();
check(
  (await ev<string>('document.querySelector("#btnLibrary .label").textContent')) === 'Library',
  'the top bar has a Library button',
);
check(
  await ev<boolean>('document.getElementById("saved").hidden'),
  'with nothing saved yet, the empty stage offers no recording to continue',
);
check(
  await ev<boolean>('__onetake.listRecordings().then((l) => l.length === 0)'),
  'the server has no recordings yet',
);
await page.setFiles('#fileIn', [fixtures.pdf]);
check(await page.waitFor('__onetake.state.slides.length === 4', 100, 200), 'four slides rendered');
check(
  await page.waitFor('__onetake.recording().id !== null', 100, 100),
  'loading a deck opens a recording on this computer',
);
const rec1 = (await ev<RecordingHook>('__onetake.recording()')).id ?? '';
{
  const list = await api<Summary[]>('/api/recordings');
  const first = list[0];
  check(
    list.length === 1 && first?.id === rec1 && first.deckReady && first.slides === 4,
    `the server lists it with its deck (${first?.name ?? '?'}, ${first?.slides ?? 0} slides, deck ready: ${String(first?.deckReady)})`,
  );
  check(/^\d{8}-\d{6}-[0-9a-f]{12}$/.test(rec1), `the recording's id is a time and a hash (${rec1})`);
  const folder = path.join(recordingsDir, rec1);
  check(
    fs.existsSync(path.join(folder, 'recording.json')) &&
      fs.readdirSync(path.join(folder, 'deck')).length === 1,
    `its folder holds the manifest and the deck (${path.relative(OUT, folder)})`,
  );
  const deckFile = path.join(folder, 'deck', fs.readdirSync(path.join(folder, 'deck'))[0] ?? '');
  check(sha(deckFile) === sha(fixtures.pdf), 'the deck on disk is the file that was loaded, byte for byte');
  check(
    (await ev<string>('document.getElementById("serverPill").textContent')).includes(
      'saved on this computer',
    ),
    `the server pill says the recording is saved (${await ev<string>('document.getElementById("serverPill").textContent')})`,
  );
}

page.step('sitting 1: recording');
await skipEnrollment(page);
check(await page.startMic(), 'mic started');
{
  const t0 = Date.now();
  const at = async (sec: number, fn: () => Promise<unknown>) => {
    const d = t0 + sec * 1000 - Date.now();
    if (d > 0) await sleep(d);
    await fn();
  };
  await at(4.0, () => ev('__onetake.goTo(1)')); // in a pause
  await at(10.0, () => ev('__onetake.goTo(2)')); // mid-phrase: the sentence is split across slides
  await at(13.5, () => ev('__onetake.stopMic()'));
  await ev('__onetake.settled()');
}
const segs1 = await ev<Seg[]>(SEGS);
console.log('sitting 1 phrases:', JSON.stringify(segs1));
check(segs1.length === 4, `four phrases recorded (${segs1.length})`);
check(
  segs1.every((s) => s.sitting === 1),
  'every phrase is tagged with sitting 1',
);
check(
  segs1.some((s) => s.raw),
  'phrases carry their raw microphone copy',
);
check(await ev<boolean>('__onetake.flushSync()', 60_000), 'every phrase reached the disk');
let rec = await api<Manifest>(`/api/recordings/${rec1}`);
check(
  rec.phrases.length === 4 && rec.order.join() === segs1.map((s) => s.id).join(),
  'the manifest lists the four phrases in order',
);
checkFiles(rec, 'sitting 1');
check(
  rec.phrases.every((p, i) => {
    const seg = segs1[i];
    return seg?.slide === p.slide && Math.abs(p.seconds - seg.sec) < 0.01;
  }),
  'the manifest knows each phrase’s slide and length',
);
check(
  rec.current === 2 && rec.sitting === 1,
  `the manifest remembers the slide (${rec.current + 1}) and the sitting`,
);
check(rec.sittings.length === 1 && rec.sittings[0]?.fromSlide === 0, 'one sitting so far, begun on slide 1');
check(
  (await ev<RecordingHook>('__onetake.recording()')).sync.kind === 'saved',
  'the mirror reports itself saved',
);
// a change follows: the last phrase goes, then comes back
await ev('__onetake.deleteLast()');
await ev('__onetake.flushSync()', 30_000);
rec = await api<Manifest>(`/api/recordings/${rec1}`);
check(rec.phrases.length === 3, 'deleting a phrase removes it from the disk too');
await ev('__onetake.undoDelete()');
await ev('__onetake.flushSync()', 30_000);
rec = await api<Manifest>(`/api/recordings/${rec1}`);
check(
  rec.phrases.length === 4 && rec.order.join() === segs1.map((s) => s.id).join(),
  'undo puts it back on the disk, in its place',
);
await page.screenshot('sitting-1.png');
page.close();
chrome.kill('SIGKILL');
await sleep(500);

/* ======================================================= sitting 2: a browser with nothing in it */
page.step('sitting 2: a fresh browser');
chrome = startChrome({
  cdpPort: PORT + 2,
  profileDir: path.join(OUT, 'profile-2'),
  wav: fixtures.wav,
  loop: false,
});
page = await Page.open(PORT + 2, OUT);
page.watchdog(15 * 60_000);
ev = <T = unknown>(expression: string, timeoutMs?: number) => page.ev<T>(expression, timeoutMs);
await page.navigate(URL);
await page.waitForApp();
check(
  await page.waitFor('!document.getElementById("saved").hidden', 50, 100),
  'a browser with empty storage offers the recording saved on this computer',
);
{
  const row = await ev<{ name: string; facts: string } | null>(
    `(() => { const r = document.querySelector('#savedList .saved-rec[data-id="${rec1}"]'); return r ? { name: r.querySelector('.name').textContent, facts: r.querySelector('small').textContent } : null; })()`,
  );
  check(
    row?.name === 'slides.pdf' && row.facts.includes('4 phrases') && row.facts.includes('slide 3 of 4'),
    `the row names the deck and says where it was left (${row?.facts ?? 'no row'})`,
  );
}
await page.screenshot('fresh-browser.png');
await ev(`document.querySelector('#savedList .saved-rec[data-id="${rec1}"] button.continue').click()`);
check(
  await page.waitFor('__onetake.state.slides.length === 4', 150, 200),
  'Continue loads the deck from this computer',
);
check(await page.waitFor('__onetake.state.segments.length === 4', 50, 200), 'and every phrase');
const segs2 = await ev<Seg[]>(SEGS);
check(
  JSON.stringify(segs2) === JSON.stringify(segs1),
  'the phrases came back exactly as they were (ids, slides, lengths, raw copies, sitting)',
);
check((await ev<number>('__onetake.state.current')) === 2, 'the slide it was left on is showing');
{
  const r = await ev<RecordingHook>('__onetake.recording()');
  check(r.id === rec1 && r.sitting === 2, `the same recording goes on, in sitting ${r.sitting}`);
  check(
    await ev<boolean>('document.getElementById("saved").hidden'),
    'the offer leaves the stage once a deck is loaded',
  );
}

page.step('sitting 2: recording with the camera and the pen');
await ev('__onetake.goTo(3)');
await ev('__onetake.setRecordMode("annotate")');
const cameraOn = await page.waitFor('__onetake.camera.on', 100, 100);
console.log(`camera: ${cameraOn ? 'on' : 'not available; the phrases will have no picture'}`);
await skipEnrollment(page);
check(await page.startMic(), 'mic started again');
{
  const t0 = Date.now();
  const at = async (sec: number, fn: () => Promise<unknown>) => {
    const d = t0 + sec * 1000 - Date.now();
    if (d > 0) await sleep(d);
    await fn();
  };
  // a stroke before the first phrase: the voice ends the drawing and the two are separate clips
  await at(0.3, () => ev('__onetake.penDown(0.2, 0.3)'));
  await at(0.4, () => ev('__onetake.penMove(0.5, 0.5)'));
  await at(0.5, () => ev('__onetake.penMove(0.7, 0.4)'));
  await at(0.6, () => ev('__onetake.penUp()'));
  await at(7.0, () => ev('__onetake.stopMic()'));
  await ev('__onetake.settled()');
}
const segs3 = await ev<Seg[]>(SEGS);
const added = segs3.slice(4);
console.log('sitting 2 clips:', JSON.stringify(added));
check(added.length >= 2, `sitting 2 added clips (${added.length})`);
check(
  added.every((s) => s.sitting === 2 && s.slide === 3),
  'the new clips are tagged with sitting 2, on slide 4',
);
check(
  added.some((s) => s.ink !== null && s.ink > 0),
  'one of them is the drawing',
);
if (cameraOn)
  check(
    added.some((s) => s.video),
    'a spoken clip carries the camera’s picture',
  );
check(
  (await ev<number>('document.querySelectorAll("#segs .sitting").length')) === 2,
  'the timeline marks where each sitting begins',
);
check(
  (await ev<string>('[...document.querySelectorAll("#segs .sitting")].at(-1).textContent')).includes(
    'Sitting 2',
  ),
  'the second divider says Sitting 2',
);
check(await ev<boolean>('__onetake.flushSync()', 60_000), 'the new clips reached the disk');
rec = await api<Manifest>(`/api/recordings/${rec1}`);
check(rec.phrases.length === segs3.length, `the manifest holds all ${segs3.length} clips of both sittings`);
checkFiles(rec, 'sitting 2');
check(
  rec.sittings.length === 2 && rec.sittings[1]?.n === 2 && rec.sittings[1].fromSlide === 3,
  'the manifest knows the second sitting began on slide 4',
);
check(
  rec.phrases.some((p) => p.kind === 'ink') &&
    rec.phrases.filter((p) => p.sitting === 2).length === added.length,
  'the manifest marks the drawing and the sitting of each clip',
);
{
  const list = await api<Summary[]>('/api/recordings');
  const s = list.find((x) => x.id === rec1);
  check(
    s?.sittings === 2 && s.ink && s.phrases === segs3.length && s.lastSlide === 3,
    `the summary counts ${s?.sittings ?? 0} sittings, ${s?.phrases ?? 0} clips, pen ${String(s?.ink)}, last slide ${(s?.lastSlide ?? -1) + 1}`,
  );
}
await page.screenshot('sitting-2.png');

page.step('exporting both sittings');
interface ServerResult {
  kind: string;
  job: { state: string; outputs: { path: string }[]; error: string | null };
}
const tl = await ev<{ total: number; items: number }>(
  '(()=>{const t=__onetake.timeline("recorded");return {total:+t.total.toFixed(2), items:t.items.length}})()',
);
const res = await ev<ServerResult>(
  `__onetake.exportWith(${JSON.stringify({ fileName: 'both-sittings', container: 'mp4', resolution: { preset: '720p' }, fps: 24 })})`,
  10 * 60_000,
);
check(res.job.state === 'done', `the export is done${res.job.error ? ` (${res.job.error})` : ''}`);
{
  const file = res.job.outputs[0]?.path ?? '';
  const p = probe(file);
  const v = video(p);
  check(v?.codec_name === 'h264' && v.width === 1280 && v.height === 720, 'mp4 is h264 1280x720');
  check(audio(p)?.codec_name === 'aac', 'mp4 has aac audio');
  const dur = Number(p.format.duration);
  check(
    tl.items === segs3.length && Math.abs(dur - (tl.total + 0.25)) < 0.4,
    `one video of all ${tl.items} clips from both sittings: ${dur.toFixed(2)} s for a ${tl.total} s timeline`,
  );
  const sitting1 = segs1.reduce((a, s) => a + s.sec, 0);
  check(
    dur > sitting1 + added.reduce((a, s) => a + s.sec, 0) - 0.5,
    'the video is longer than either sitting alone',
  );
}
page.close();
chrome.kill('SIGKILL');
await sleep(500);

/* ============================================ sitting 3: continue again, then start afresh */
page.step('sitting 3: continuing again');
chrome = startChrome({
  cdpPort: PORT + 3,
  profileDir: path.join(OUT, 'profile-3'),
  wav: fixtures.wav,
  loop: false,
});
page = await Page.open(PORT + 3, OUT);
page.watchdog(10 * 60_000);
ev = <T = unknown>(expression: string, timeoutMs?: number) => page.ev<T>(expression, timeoutMs);
await page.navigate(URL);
await page.waitForApp();
await ev(`__onetake.continueRecording(${JSON.stringify(rec1)})`, 120_000);
const segs4 = await ev<Seg[]>(SEGS);
check(
  JSON.stringify(segs4) === JSON.stringify(segs3),
  'the drawing and the pictures came back from the disk with the voice',
);
check(
  await ev<boolean>(
    '(() => { const d = __onetake.state.segments.find((s) => s.ink); return d !== undefined && d.ink.strokes[0].points.length >= 2; })()',
  ),
  'the drawing’s strokes are intact',
);
if (cameraOn) {
  check(
    await ev<boolean>(
      '(() => { const v = __onetake.state.segments.find((s) => s.video)?.video; return v !== undefined && v.pieces[0].frames[0].key && v.pieces[0].frames[0].data instanceof Uint8Array; })()',
    ),
    'the camera frames came back as encoded bytes starting on a key frame',
  );
}
check((await ev<RecordingHook>('__onetake.recording()')).sitting === 3, 'this is sitting 3');
check((await ev<number>('__onetake.state.current')) === 3, 'the slide it was left on is showing');

page.step('the Library');
await ev('__onetake.openLibrary("recordings")');
check(
  await page.waitFor(`document.querySelector('#recordingsList .rec[data-id="${rec1}"]') !== null`, 50, 100),
  'the Library lists the recording',
);
check(
  await ev<boolean>(
    `(() => { const r = document.querySelector('#recordingsList .rec[data-id="${rec1}"]'); return r.classList.contains('current') && r.querySelector('button.continue').disabled && r.querySelector('.chip-tag').textContent === 'open now'; })()`,
  ),
  'the open recording is marked and cannot be continued into itself',
);
await page.screenshot('library.png');
await ev(`document.querySelector('#recordingsList .rec[data-id="${rec1}"] button.again').click()`);
check(
  await page.waitFor('document.getElementById("confirm").classList.contains("on")', 20, 100),
  'Start again asks first',
);
await ev('document.getElementById("confirmYes").click()');
check(
  await page.waitFor(
    `__onetake.recording().id !== null && __onetake.recording().id !== ${JSON.stringify(rec1)}`,
    100,
    200,
  ),
  'a new recording opens',
);
const rec2 = (await ev<RecordingHook>('__onetake.recording()')).id ?? '';
check(
  await ev<boolean>(
    '__onetake.state.segments.length === 0 && __onetake.state.slides.length === 4 && __onetake.state.current === 0',
  ),
  'with the same deck, nothing recorded, on slide 1',
);
{
  const list = await api<Summary[]>('/api/recordings');
  const a = list.find((x) => x.id === rec1);
  const b = list.find((x) => x.id === rec2);
  check(
    list.length === 2 && a?.phrases === segs3.length && b?.phrases === 0 && b.deckReady,
    'both recordings are on disk: the earlier one untouched, the new one with the deck copied',
  );
}
await skipEnrollment(page);
check(await page.startMic(), 'mic started in the new recording');
await sleep(4000);
await ev('__onetake.stopMic()');
await ev('__onetake.settled()');
check(await ev<boolean>('__onetake.flushSync()', 60_000), 'the new recording’s phrase reached the disk');
{
  const r2 = await api<Manifest>(`/api/recordings/${rec2}`);
  check(
    r2.phrases.length >= 1 && r2.phrases.every((p) => p.sitting === 1),
    `the new recording has its own phrases in sitting 1 (${r2.phrases.length})`,
  );
  checkFiles(r2, 'the new recording');
}

page.step('loading the same deck again');
await ev('void __onetake.closeSlides()'); // it waits for the answer to its question
check(
  await page.waitFor('document.getElementById("confirm").classList.contains("on")', 20, 100),
  'closing asks first',
);
check(
  (await ev<string>('document.getElementById("confirmText").textContent')).includes('stays on this computer'),
  'and says the recording stays on this computer',
);
await ev('document.getElementById("confirmYes").click()');
check(
  await page.waitFor('__onetake.state.slides.length === 0 && __onetake.recording().id === null', 50, 100),
  'the slides close',
);
check(
  await page.waitFor('!document.getElementById("saved").hidden', 50, 100),
  'the empty stage offers the recordings again',
);
check(
  (await ev<number>('document.querySelectorAll("#savedList .saved-rec").length')) === 2,
  'both are offered',
);
await page.setFiles('#fileIn', [fixtures.pdf]);
check(
  await page.waitFor('document.getElementById("choice").classList.contains("on")', 50, 100),
  'loading the same deck offers to continue or start again',
);
{
  const labels = await ev<string[]>(
    '[...document.querySelectorAll("#choiceList .choice-btn .label")].map((e) => e.textContent)',
  );
  check(
    labels.length === 2 &&
      /^Continue from slide \d/.test(labels[0] ?? '') &&
      labels[1] === 'Start a new recording',
    `the choices are ${labels.join(' / ')}`,
  );
}
await page.screenshot('choice.png');
await ev('document.getElementById("choice-continue").click()');
check(
  await page.waitFor('__onetake.state.segments.length > 0 && __onetake.state.slides.length === 4', 100, 200),
  'Continue brings the most recent recording of the deck back',
);
check((await ev<RecordingHook>('__onetake.recording()')).id === rec2, 'that is the one worked on last');

page.step('deleting from the Library');
await ev('__onetake.openLibrary("recordings")');
check(
  await page.waitFor(
    `document.querySelector('#recordingsList .rec[data-id="${rec2}"] button.del') !== null`,
    50,
    100,
  ),
  'the Library lists both',
);
await ev(`document.querySelector('#recordingsList .rec[data-id="${rec2}"] button.del').click()`);
check(
  await page.waitFor('document.getElementById("confirm").classList.contains("on")', 20, 100),
  'Delete asks first',
);
await ev('document.getElementById("confirmYes").click()');
check(
  await page.waitFor('__onetake.recording().id === null && __onetake.state.slides.length === 0', 50, 100),
  'deleting the open recording closes the slides',
);
await sleep(300);
check(!fs.existsSync(path.join(recordingsDir, rec2)), 'its folder is gone');
{
  const list = await api<Summary[]>('/api/recordings');
  check(
    list.length === 1 && list[0]?.id === rec1 && list[0].phrases === segs3.length,
    'the earlier recording is still there, whole',
  );
}
check(page.errors().length === 0, `no page errors (${page.errors().slice(0, 3).join(' | ')})`);
page.close();
chrome.kill('SIGKILL');
finish(`recordings survive a wiped browser and both sittings export as one video; output in ${OUT}`);
