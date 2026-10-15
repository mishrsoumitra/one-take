/**
 * End-to-end check of the studio and the clip versions: real server, built client, headless Chrome
 * with a fake microphone. Records phrases and checks each carries its raw copy in step with the
 * filtered one, reloads and finds them again, works the editor's Original / Cleaned / Only my voice
 * switch, has the studio make a version of one clip, exports with the deep clean and the voice step,
 * and gives up on the studio's wait with the button. Where this machine has no studio
 * (`npm run studio` not run) the switches must be greyed out with the reason, and the export must
 * run as before.
 *
 *   npm run e2e:studio
 *   tsx packages/e2e/src/studio.ts --out /tmp/one-take-studio
 */
import fs from 'node:fs';
import os from 'node:os';
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
import { makePdf, makeStudioWav } from './make-fixtures.js';

const { values } = parseArgs({
  options: { out: { type: 'string' }, port: { type: 'string' } },
});
const OUT = path.resolve(values.out ?? path.join(ROOT, 'packages/e2e/studio-out'));
const PORT = Number(values.port ?? 4703);
const CDP_PORT = PORT + 1;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'fixtures'), { recursive: true });
const pdf = path.join(OUT, 'fixtures', 'slides.pdf');
const wav = path.join(OUT, 'fixtures', 'speech.wav');
fs.writeFileSync(pdf, makePdf(['One', 'Two', 'Three']));
fs.writeFileSync(wav, makeStudioWav());
const exportsDir = path.join(OUT, 'exports');
fs.mkdirSync(exportsDir, { recursive: true });
// the server keeps its data next to the test's output; the studio environment, when this machine has
// one, is lent to it through a link, so the real models are what the export runs
const dataDir = path.join(OUT, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const realStudio = path.join(process.env.ONE_TAKE_DATA_DIR ?? path.join(os.homedir(), '.one-take'), 'studio');
if (fs.existsSync(realStudio)) fs.symlinkSync(realStudio, path.join(dataDir, 'studio'));

/* ------------------------------------------------------------ the server */
await startServer(PORT, exportsDir);
interface Studio {
  python: string | null;
  device: string | null;
  denoise: boolean;
  voice: boolean;
  note: string;
}
const caps = (await (await fetch(`http://127.0.0.1:${PORT}/api/capabilities`)).json()) as {
  studio: Studio | null;
};
const studio = caps.studio;
const ready = studio !== null && studio.denoise && studio.voice;
console.log(`studio: ${studio ? studio.note : 'off'}`);
check(studio !== null, 'the server reports the studio (on by default)');
if (!ready) check((studio?.note ?? '').includes('npm run studio'), 'the note says how to set the studio up');

/* ------------------------------------------------------------ the page */
const profileDir = path.join(OUT, 'chrome-profile');
startChrome({ cdpPort: CDP_PORT, profileDir, wav, loop: true });
await sleep(1500);
const page = await Page.open(CDP_PORT, OUT);
page.watchdog(15 * 60_000);
const ev = <T = unknown>(expr: string, timeoutMs?: number) => page.ev<T>(expr, timeoutMs);
await page.navigate(`http://127.0.0.1:${PORT}/`);
await page.waitForApp();
page.step('loading slides');
await page.setFiles('#fileIn', [pdf]);
for (let i = 0; i < 100 && (await ev<number>('__onetake.state.slides.length')) < 3; i++) await sleep(200);
check((await ev<number>('__onetake.state.slides.length')) === 3, 'three slides rendered');
await ev('__onetake.setCamera("off")'); // the fake camera has no face; the lip check is not what is tested here

/* ------------------------------------------------------------ recording: the raw copy */
page.step('recording');
await ev('void __onetake.startMic()');
// the first start offers the voice enrollment; it is skipped here
if (await page.waitFor('document.getElementById("enrollSkip")', 30, 100)) {
  await ev('document.getElementById("enrollSkip").click()');
}
check(await page.waitFor('__onetake.state.armed', 100, 100), 'mic armed');
check(await page.waitFor('__onetake.state.segments.length >= 3', 300, 100), 'three phrases recorded');
await ev('__onetake.stopMic()');
await ev('__onetake.settled()', 60_000);
const engine = await ev<string>(
  '__onetake.mic.engine === "off" ? __onetake.prefs().noiseFilter : __onetake.mic.engine',
);
console.log(`noise filter wanted: ${engine}`);
const segs = await ev<{ pcm: number; raw: number | null; faces: number | null; video: boolean }[]>(
  '__onetake.state.segments.map((s) => ({ pcm: s.pcm.length, raw: s.raw ? s.raw.length : null, faces: s.faces ? s.faces.frames : null, video: !!s.video }))',
);
console.log('phrases:', JSON.stringify(segs));
check(
  segs.every((s) => s.raw !== null && s.raw === s.pcm),
  'every phrase carries its raw copy, as long as the filtered one',
);
const lags = await ev<({ lag: number; peak: number } | null)[]>(
  '__onetake.state.segments.map((_, i) => __onetake.rawLag(i))',
);
console.log('raw lags:', JSON.stringify(lags));
check(
  lags.every((l) => l !== null && Math.abs(l.lag) <= 2 && l.peak > 0.5),
  'the raw copy lines up with the filtered phrase to within two samples, by correlation',
);
const differs = await ev<boolean>(
  '(() => { const s = __onetake.state.segments[0]; let d = 0; for (let i = 0; i < s.pcm.length; i += 7) if (s.pcm[i] !== s.raw[i]) d++; return d > s.pcm.length / 70; })()',
);
check(differs, 'the raw copy is not the filtered one (the filter changed something)');

/* ------------------------------------------------------------ reload: the versions survive */
page.step('reloading');
await page.reload();
await page.waitForApp();
check(
  await page.waitFor('document.getElementById("restore").classList.contains("on")', 100, 100),
  'the resume banner shows',
);
await ev('document.getElementById("btnRestore").click()');
check(await page.waitFor('__onetake.state.segments.length >= 3', 100, 100), 'phrases restored');
check(
  await ev<boolean>(
    '__onetake.state.segments.every((s) => s.raw instanceof Int16Array && s.raw.length === s.pcm.length)',
  ),
  'the raw copies came back from IndexedDB as Int16Array',
);

/* ------------------------------------------------------------ the editor's switch */
page.step('the editor');
await ev('__onetake.openEditor()');
check(await page.waitFor('document.getElementById("editor").classList.contains("on")'), 'editor open');
check(
  await ev<boolean>('!document.getElementById("edVoicing").hidden'),
  'the sound switch shows for the clip',
);
check(
  (await ev<string>('document.getElementById("edVoicing-cleaned").getAttribute("aria-checked")')) === 'true',
  'Cleaned is the clip’s version by default',
);
const note = await ev<string>('document.getElementById("edVoicingNote").textContent');
console.log('switch note:', note);
check(
  note.includes('Cleaned: live filter') && note.includes('Only my voice: not made yet'),
  'the note says what each version is',
);
check(
  (await ev<boolean>('document.getElementById("edMake-deep").disabled')) === !ready,
  `the deep clean button is ${ready ? 'enabled' : 'greyed out'} as the studio is ${ready ? 'ready' : 'absent'}`,
);
await ev('document.getElementById("edVoicing-original").click()');
await sleep(200);
check(
  (await ev<string>('__onetake.state.segments[0].choice')) === 'original',
  'clicking Original sets the clip’s choice (and it is saved)',
);
check(
  (await ev<string>('document.getElementById("edVoicing-original").getAttribute("aria-checked")')) === 'true',
  'the switch shows Original',
);
await ev('document.getElementById("edVoicingPlay-original").click()');
await sleep(300);
check(
  await ev<boolean>('document.getElementById("edVoicingPlay-original").classList.contains("on")'),
  'the play button plays the version',
);
await ev('document.getElementById("edVoicingPlay-original").click()');
await ev('document.getElementById("edUndo").click()');
await sleep(200);
check(
  (await ev<string>('__onetake.state.segments[0].choice ?? "none"')) === 'none',
  'undo takes the choice back',
);
await page.press('Escape');
check(await page.waitFor('!document.getElementById("editor").classList.contains("on")'), 'editor closed');

/* ------------------------------------------------------------ the studio on one clip */
if (ready) {
  page.step('the studio on one clip');
  const made = await ev<{ deep: number; voice: number }>('__onetake.makeVersion(0, "deep")', 180_000);
  const pcm0 = await ev<number>('__onetake.state.segments[0].pcm.length');
  check(made.deep === pcm0, `the deep clean of clip 1 came back as long as the clip (${made.deep} samples)`);
  const voiced = await ev<{ deep: number; voice: number }>('__onetake.makeVersion(0, "voice")', 180_000);
  check(
    voiced.voice === pcm0,
    `only-my-voice of clip 1 came back as long as the clip (${voiced.voice} samples)`,
  );
  check(
    await ev<boolean>(
      '__onetake.state.segments[0].deep instanceof Int16Array && __onetake.state.segments[0].voice instanceof Int16Array',
    ),
    'both versions are kept with the phrase',
  );
}

/* ------------------------------------------------------------ the export dialog */
page.step('the export dialog');
await ev('__onetake.openExport()');
check(
  await page.waitFor('document.getElementById("exportModal").classList.contains("on")'),
  'export dialog open',
);
check(
  (await ev<boolean>('document.getElementById("studioDenoise").disabled')) === !ready,
  `the deep clean switch is ${ready ? 'enabled' : 'greyed out'}`,
);
check(
  (await ev<boolean>('document.getElementById("studioVoice").disabled')) === !ready,
  `the only-my-voice switch is ${ready ? 'enabled' : 'greyed out'}`,
);
const studioNote = await ev<string>('document.getElementById("studioNote").textContent');
console.log('studio note:', studioNote);
check(
  ready
    ? studioNote.includes('ready')
    : /npm run studio|switched off|needs the local server/.test(studioNote),
  'the Sound section says what the studio can do here',
);
check(
  /Every phrase was your voice|No phrase was judged/.test(
    await ev<string>('document.getElementById("flaggedStatus").textContent'),
  ),
  'with nothing flagged the list says so',
);
// a phrase marked as another voice (as the checks would) shows up in the flagged list with its tick
await ev('__onetake.flag(1, "other")');
await ev('__onetake.exportDialog.refresh()');
check(
  (await ev<number>('document.querySelectorAll("#flaggedList .flag").length')) === 1,
  'the flagged phrase is listed',
);
await ev('document.querySelector("#flaggedList .flag input").click()');
await sleep(100);
check(
  (await ev<string>('document.getElementById("flaggedStatus").textContent')).includes('left out'),
  'unticking a flagged phrase leaves it out',
);
await ev('document.querySelector("#flaggedList .flag input").click()');
check(
  (await ev<number>('document.querySelectorAll("#flaggedList .flag").length')) === 1 &&
    !(await ev<string>('document.getElementById("flaggedStatus").textContent')).includes('left out'),
  'ticking it again keeps it',
);
await ev('document.getElementById("btnCloseExport").click()');

/* ------------------------------------------------------------ the export */
page.step('exporting');
interface Result {
  kind: string;
  job: { state: string; error: string | null; outputs: { path: string }[] };
  timing: { studio: string | null };
}
const exported = await ev<Result>(
  `__onetake.exportWith(${JSON.stringify({
    fileName: 'studio',
    container: 'mp4',
    resolution: { preset: '360p' },
    fps: 5,
    enhance: {
      speed: 1,
      evenLoudness: true,
      fillers: { remove: false, sensitivity: 'medium' },
      captions: { enabled: false, language: 'auto', burnIn: false, sidecar: true, transcript: true },
      studio: { denoise: true, voice: true, findOverlap: false },
      camera: { background: 'keep', backdrop: '#1f2a44', exposure: true },
    },
  })})`,
  10 * 60_000,
);
check(exported.job.state === 'done', `export done${exported.job.error ? ` (${exported.job.error})` : ''}`);
console.log('studio note after the export:', exported.timing.studio);
if (ready) {
  check(
    /deep clean on \d+ phrase/.test(exported.timing.studio ?? '') &&
      (exported.timing.studio ?? '').includes('your voice kept in 1 phrase'),
    'the export ran the deep clean and kept the voice of the flagged phrase',
  );
  check(
    await ev<boolean>('__onetake.state.segments.every((s) => s.deep instanceof Int16Array)'),
    'every phrase now carries its deep clean',
  );
} else {
  check(exported.timing.studio === null, 'without the studio the export runs as before');
}
{
  const out = exported.job.outputs[0]?.path ?? '';
  const p = probe(out);
  check(video(p)?.codec_name === 'h264' && audio(p)?.codec_name === 'aac', 'the file is h264 + aac');
  console.log(`exported ${out} (${p.format.duration} s)`);
}

/* ------------------------------------------------------------ continue without waiting */
if (ready) {
  page.step('skipping the studio');
  await ev('__onetake.exportDialog.refresh()');
  // a second export with the deep clean asked for again: the button to give up on the wait shows while it runs
  await ev('__onetake.state.segments.forEach((s) => { delete s.deep; })');
  await ev('__onetake.openExport()');
  check(
    await ev<boolean>('document.getElementById("studioDenoise").checked'),
    'the deep clean is on by default when the studio is ready',
  );
  await ev('document.getElementById("btnStartExport").click()');
  const shown = await page.waitFor('!document.getElementById("skipStudio").hidden', 100, 50);
  check(shown, 'the "continue without waiting" button shows while the studio works');
  if (shown) await ev('document.getElementById("skipStudio").click()');
  check(
    await page.waitFor(
      '__onetake.exportDialog.progress && __onetake.exportDialog.progress.stage === "done"',
      600,
      500,
    ),
    'the export goes on and finishes after the skip',
  );
  const after = await ev<string>('document.getElementById("exportStatus").textContent');
  console.log('status after the skip:', after);
  check(!/failed/i.test(after), 'the export did not fail');
  await ev('document.getElementById("btnCloseExport").click()');
}

await page.screenshot('studio.png');
finish('the studio and the clip versions work end to end');
