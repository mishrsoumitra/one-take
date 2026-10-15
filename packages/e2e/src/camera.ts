/**
 * Camera overlay check: headless Chrome with a fake camera and a WAV microphone. Turns the camera
 * on, places and resizes it, records phrases with slide changes, checks every phrase carries its
 * picture, exports an MP4 and looks for the picture in a frame, plays the preview and the editor,
 * reloads and checks the pictures survived.
 *
 *   npm run e2e:camera          (builds first)
 *   tsx packages/e2e/src/camera.ts --out /tmp/one-take-camera --port 4599
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  audio,
  check,
  finish,
  Page,
  ROOT,
  probe,
  sleep,
  startChrome,
  startServer,
  video,
} from './harness.js';
import { writeFixtures } from './make-fixtures.js';

const { values } = parseArgs({ options: { out: { type: 'string' }, port: { type: 'string' } } });
const OUT = path.resolve(values.out ?? path.join(ROOT, 'packages/e2e/camera-out'));
const PORT = Number(values.port ?? 4599);
const CDP_PORT = PORT + 1;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const fixtures = await writeFixtures(path.join(OUT, 'fixtures'));
const exportsDir = path.join(OUT, 'exports');
fs.mkdirSync(exportsDir, { recursive: true });

await startServer(PORT, exportsDir);
startChrome({ cdpPort: CDP_PORT, profileDir: path.join(OUT, 'profile'), wav: fixtures.wav, loop: true });
const page = await Page.open(CDP_PORT, OUT);
page.watchdog(12 * 60_000);
const ev = <T = unknown>(expression: string, timeoutMs?: number) => page.ev<T>(expression, timeoutMs);

page.step('boot');
await page.navigate(`http://127.0.0.1:${PORT}/`);
await page.waitForApp();
await sleep(1500);
// the welcome tour closes when slides are chosen
await page.setFiles('#fileIn', [fixtures.pdf]);
for (let i = 0; i < 100 && (await ev<number>('__onetake.state.slides.length')) < 4; i++) await sleep(200);
check((await ev<number>('__onetake.state.slides.length')) === 4, 'four slides rendered');

/* ------------------------------------------------------------ the switch and the live picture */
page.step('camera on');
check(
  await ev<boolean>('!document.getElementById("camOn").disabled'),
  'the camera switch is enabled (WebCodecs present)',
);
check(
  await ev<boolean>('document.getElementById("camRow").hidden'),
  'the camera row is hidden while the camera is off',
);
await ev('document.getElementById("camOn").click()');
check(await page.waitFor('__onetake.camera.on', 100, 100), 'the camera opened');
check(await ev<boolean>('!document.getElementById("camRow").hidden'), 'the camera row appears');
check(await ev<boolean>('__onetake.prefs().camera === true'), 'the switch is remembered');
const info = await ev<{ label: string; width: number; height: number; codec: string }>(
  '__onetake.camera.info',
);
console.log('camera:', JSON.stringify(info));
check(info.height === 360 && info.width % 2 === 0, `picture stored at ${info.width}x${info.height}`);
check(/^avc1|^vp8/.test(info.codec), `encoder codec ${info.codec}`);
await sleep(800);

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
const rects = () =>
  ev<{ img: Box; box: Box; hidden: boolean; video: boolean; canvas: boolean }>(
    `(() => { const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
      const layer = document.querySelector('#stage .cam-layer'); const box = document.querySelector('#stage .cam-box');
      return { img: r(document.getElementById('slideImg')), box: r(box), hidden: layer.hidden,
        video: !box.querySelector('video').hidden, canvas: !box.querySelector('canvas').hidden }; })()`,
  );
{
  const r = await rects();
  console.log('live rects:', JSON.stringify(r));
  check(!r.hidden && r.video, 'the live picture shows on the stage');
  const inside =
    r.box.x >= r.img.x - 1 &&
    r.box.y >= r.img.y - 1 &&
    r.box.x + r.box.w <= r.img.x + r.img.w + 1 &&
    r.box.y + r.box.h <= r.img.y + r.img.h + 1;
  check(inside, 'the picture sits inside the slide');
  check(
    Math.abs(r.box.w / r.img.w - 0.24) < 0.01,
    `default size is 24 % of the slide width (${(r.box.w / r.img.w).toFixed(3)})`,
  );
  const margin = 0.025 * r.img.w;
  check(
    Math.abs(r.box.x + r.box.w - (r.img.x + r.img.w - margin)) < 2 &&
      Math.abs(r.box.y + r.box.h - (r.img.y + r.img.h - margin)) < 2,
    'the default corner is bottom right',
  );
  check(
    Math.abs(r.box.w / r.box.h - info.width / info.height) < 0.02,
    `the box keeps the camera's shape (${(r.box.w / r.box.h).toFixed(3)} vs ${(info.width / info.height).toFixed(3)})`,
  );
  const playing = await ev<boolean>(
    '(() => { const v = document.querySelector("#stage .cam-box video"); return v.readyState >= 2 && v.videoWidth > 0; })()',
  );
  check(playing, 'the live video element is playing the camera');
}
await page.screenshot('camera-live.png');

/* ------------------------------------------------------------ corners, size, drag */
page.step('placing the picture');
await ev('document.getElementById("cam-top-left").click()');
await sleep(100);
{
  const l = await ev<{ x: number; y: number; size: number }>('__onetake.cameraLayout()');
  check(l.x === 0 && l.y === 0, 'the Top left button moves the picture to the top left');
  check(
    await ev<boolean>('document.getElementById("cam-top-left").getAttribute("aria-pressed") === "true"'),
    'the pressed corner button is marked',
  );
  const r = await rects();
  const margin = 0.025 * r.img.w;
  check(
    Math.abs(r.box.x - (r.img.x + margin)) < 2 && Math.abs(r.box.y - (r.img.y + margin)) < 2,
    'the box is in the top-left corner on the stage',
  );
}
await ev(
  '(() => { const s = document.getElementById("camSize"); s.value = "40"; s.dispatchEvent(new Event("input", { bubbles: true })); })()',
);
await sleep(100);
{
  const r = await rects();
  check(
    Math.abs(r.box.w / r.img.w - 0.4) < 0.01,
    `the size slider makes the picture 40 % wide (${(r.box.w / r.img.w).toFixed(3)})`,
  );
  check(
    await ev<boolean>('document.getElementById("camSizeV").textContent === "40 %"'),
    'the slider shows 40 %',
  );
  check(
    await ev<boolean>('JSON.parse(localStorage.getItem("one-take.prefs")).cameraLayout.size === 0.4'),
    'the size is remembered',
  );
}
await ev('__onetake.setCameraLayout({ x: 1, y: 1, size: 0.2 })');
await sleep(100);
{
  // drag the box from the bottom-right towards the middle of the slide
  const r = await rects();
  const from = { x: r.box.x + r.box.w / 2, y: r.box.y + r.box.h / 2 };
  const to = { x: r.img.x + r.img.w * 0.5, y: r.img.y + r.img.h * 0.5 };
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: from.x,
    y: from.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  for (let i = 1; i <= 8; i++) {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x + ((to.x - from.x) * i) / 8,
      y: from.y + ((to.y - from.y) * i) / 8,
      button: 'left',
      buttons: 1,
    });
    await sleep(20);
  }
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: to.x,
    y: to.y,
    button: 'left',
    clickCount: 1,
  });
  await sleep(100);
  const l = await ev<{ x: number; y: number; size: number }>('__onetake.cameraLayout()');
  console.log('after drag:', JSON.stringify(l));
  check(
    l.x > 0.2 && l.x < 0.8 && l.y > 0.2 && l.y < 0.8,
    'dragging puts the picture anywhere (here near the middle)',
  );
  check(
    await ev<boolean>(
      '[...document.querySelectorAll("#camRow .corner")].every(b => b.getAttribute("aria-pressed") === "false")',
    ),
    'no corner button is marked for a dragged position',
  );
  const r2 = await rects();
  check(
    Math.abs(r2.box.x + r2.box.w / 2 - to.x) < 3 && Math.abs(r2.box.y + r2.box.h / 2 - to.y) < 3,
    'the box follows the pointer',
  );
  check(
    await ev<boolean>(
      'Math.abs(JSON.parse(localStorage.getItem("one-take.prefs")).cameraLayout.x - __onetake.cameraLayout().x) < 1e-9',
    ),
    'the dragged position is remembered',
  );
  check(
    (await ev<string>('document.getElementById("camNote").textContent')).includes('Where you dragged it'),
    'the note says the picture was dragged',
  );
}
await page.screenshot('camera-dragged.png');
// resize with the handle: it sits on the corner of the box that is free to move (here the top-left,
// since the box is anchored at its centre), so pulling it away from the box grows the picture
{
  const r = await rects();
  const hb = await ev<Box>(
    '(() => { const b = document.querySelector("#stage .cam-box .handle").getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()',
  );
  const handle = { x: hb.x + hb.w / 2, y: hb.y + hb.h / 2 };
  const left = hb.x < r.box.x + r.box.w / 2;
  const top = hb.y < r.box.y + r.box.h / 2;
  const sx = left ? -20 : 20;
  const sy = top ? -10 : 10;
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x, y: handle.y });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: handle.x,
    y: handle.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  for (let i = 1; i <= 6; i++) {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: handle.x + sx * i,
      y: handle.y + sy * i,
      button: 'left',
      buttons: 1,
    });
    await sleep(20);
  }
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: handle.x + sx * 6,
    y: handle.y + sy * 6,
    button: 'left',
    clickCount: 1,
  });
  await sleep(100);
  const l = await ev<{ x: number; y: number; size: number }>('__onetake.cameraLayout()');
  console.log(
    'after resize:',
    JSON.stringify(l),
    'handle was',
    left ? 'left' : 'right',
    top ? 'top' : 'bottom',
  );
  check(l.size > 0.2 + 100 / r.img.w && l.size <= 0.5, `the handle grows the picture (${l.size.toFixed(3)})`);
  check(Math.abs(l.x - 0.5) < 0.02 && Math.abs(l.y - 0.5) < 0.02, 'resizing keeps the picture where it was');
}
await ev('__onetake.setCameraLayout({ x: 1, y: 1, size: 0.28 })');

/* ------------------------------------------------------------ recording with the camera */
page.step('recording with the camera');
check(await page.startMic(), 'mic started');
check(await page.waitFor('__onetake.camera.recording', 30, 100), 'the camera records while the mic is on');
const t0 = Date.now();
const at = async (sec: number, fn: () => Promise<unknown>) => {
  const d = t0 + sec * 1000 - Date.now();
  if (d > 0) await sleep(d);
  await fn();
};
await at(4.0, () => ev('__onetake.goTo(1)'));
await at(10.0, () => ev('__onetake.goTo(2)'));
await at(13.0, () => Promise.resolve());
{
  const held = await ev<number>('__onetake.camera.heldBytes');
  console.log(`camera holds ${(held / 1024).toFixed(0)} KB while recording`);
  check(held > 0, 'frames are being kept');
}
await page.screenshot('camera-recording.png');
await ev('__onetake.stopMic()');
await ev('__onetake.settled()');
await sleep(300);
interface SegInfo {
  slide: number;
  sec: number;
  joined: boolean;
  video: null | {
    codec: string;
    width: number;
    height: number;
    pieces: {
      frames: number;
      firstKey: boolean;
      startUs: number;
      durationUs: number;
      rate: number;
      monotonic: boolean;
      lastTs: number;
      bytes: number;
    }[];
  };
}
const segs = await ev<SegInfo[]>(
  `__onetake.state.segments.map(s => ({ slide: s.slide, sec: +(s.pcm.length / s.sampleRate).toFixed(2), joined: s.joined,
    video: s.video ? { codec: s.video.codec, width: s.video.width, height: s.video.height, pieces: s.video.pieces.map(p => ({
      frames: p.frames.length, firstKey: p.frames[0]?.key ?? false, startUs: p.startUs, durationUs: p.durationUs, rate: p.rate,
      monotonic: p.frames.every((f, i) => i === 0 || f.timestamp > p.frames[i - 1].timestamp),
      lastTs: p.frames[p.frames.length - 1]?.timestamp ?? -1,
      bytes: p.frames.reduce((n, f) => n + f.data.byteLength, 0) })) } : null }))`,
);
console.log('segments:', JSON.stringify(segs));
check(segs.length >= 3, `phrases recorded (${segs.length})`);
check(
  segs.every((s) => s.video !== null && s.video.pieces.length === 1),
  'every phrase carries one piece of picture',
);
for (const [i, s] of segs.entries()) {
  const p = s.video?.pieces[0];
  if (!p) continue;
  check(p.firstKey && p.monotonic, `phrase ${i + 1}: frames start on a key frame and run forward`);
  check(
    Math.abs(p.durationUs / 1e6 - s.sec) < 0.02,
    `phrase ${i + 1}: picture lasts as long as the audio (${(p.durationUs / 1e6).toFixed(2)} vs ${s.sec} s)`,
  );
  check(
    p.startUs > -1.2e6 && p.startUs < 1.2e6,
    `phrase ${i + 1}: audio starts within a key-frame interval of the first frame (${(p.startUs / 1e6).toFixed(2)} s)`,
  );
  // 24 fps at most, and at least a frame every 100 ms over the stretch the audio covers
  const covered = Math.min(p.lastTs, p.startUs + p.durationUs) - Math.max(0, p.startUs);
  const perSec = p.frames / Math.max(0.1, (p.lastTs + 40_000) / 1e6);
  check(perSec > 8 && perSec <= 26, `phrase ${i + 1}: ${perSec.toFixed(1)} frames per second of picture`);
  check(
    covered > p.durationUs * 0.8,
    `phrase ${i + 1}: the frames cover the audio (${(covered / 1e6).toFixed(2)} of ${(p.durationUs / 1e6).toFixed(2)} s)`,
  );
  check(p.bytes > 1000, `phrase ${i + 1}: ${(p.bytes / 1024).toFixed(0)} KB of picture`);
}
check(
  await page.waitFor('!__onetake.camera.recording', 30, 100),
  'the camera lets its frames go once the last phrase is stored',
);
check(await ev<boolean>('__onetake.camera.on'), 'the camera stays on after the mic stops');

/* ------------------------------------------------------------ the preview plays the pictures */
page.step('preview');
await ev('document.getElementById("btnPreview").click()');
await sleep(1800);
{
  const r = await rects();
  check(!r.hidden && r.canvas && !r.video, 'the preview paints recorded frames instead of the live camera');
  const drawn = await ev<boolean>(
    '(() => { const c = document.querySelector("#stage .cam-box canvas"); if (!c.width) return false; const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i+1] + d[i+2]; return s / (d.length / 4) > 30; })()',
  );
  check(drawn, 'the painted frame has a picture in it');
}
await page.screenshot('camera-preview.png');
await ev('document.getElementById("btnStopPreview").click()');
await sleep(200);
{
  const r = await rects();
  check(!r.hidden && r.video, 'after the preview the live camera is back');
}

/* ------------------------------------------------------------ export with the overlay */
page.step('export');
interface ServerResult {
  job: { state: string; error?: string; outputs: { path: string }[] };
  timing: { elapsedMs: number; encodeMs: number; videoSeconds: number };
}
const res = await ev<ServerResult>(
  `__onetake.exportWith(${JSON.stringify({ fileName: 'camera', container: 'mp4', resolution: { preset: '720p' }, fps: 24 })})`,
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
  check(v?.codec_name === 'h264' && v.width === 1280 && v.height === 720, `mp4 is h264 1280x720`);
  check(v?.r_frame_rate === '24/1', `mp4 is 24 fps (${v?.r_frame_rate ?? '?'})`);
  check(audio(p)?.codec_name === 'aac', 'mp4 has aac audio');
  // a frame from inside the first phrase: the bottom-right of the slide should hold the camera picture
  const first = segs[0];
  const t = Math.min(1.0, (first?.sec ?? 1) / 2);
  const frame = path.join(OUT, 'frame.png');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', frame]);
  const stats = (crop: string) => {
    const raw = execFileSync('ffmpeg', [
      '-v',
      'error',
      '-i',
      frame,
      '-vf',
      `crop=${crop},format=gray`,
      '-f',
      'rawvideo',
      '-',
    ]);
    let sum = 0;
    for (const b of raw) sum += b;
    const mean = sum / raw.length;
    let sq = 0;
    for (const b of raw) sq += (b - mean) ** 2;
    return { mean, std: Math.sqrt(sq / raw.length) };
  };
  // the picture: 28 % of 1280 = 358 px wide, 16:9 or 4:3 tall, a 32 px margin from the bottom-right corner
  const w = Math.round(0.28 * 1280);
  const h = Math.round(w / (info.width / info.height));
  const m = Math.round(0.025 * 1280);
  const overlay = stats(`${w - 20}:${h - 20}:${1280 - m - w + 10}:${720 - m - h + 10}`);
  const elsewhere = stats(`${w - 20}:${h - 20}:${m + 10}:${720 - m - h + 10}`);
  console.log('frame stats: overlay', JSON.stringify(overlay), 'bottom-left', JSON.stringify(elsewhere));
  check(
    overlay.std > 20,
    `the exported frame has a picture in the camera's box (std ${overlay.std.toFixed(1)})`,
  );
  check(overlay.std > elsewhere.std + 10, 'the box differs from the plain slide beside it');
  fs.copyFileSync(file, path.join(OUT, 'camera.mp4'));
}

/* ------------------------------------------------------------ the editor */
page.step('editor');
await ev('__onetake.openEditor()');
await sleep(300);
await ev('document.getElementById("edPlay").click()');
await sleep(1500);
{
  const r = await ev<{ hidden: boolean; canvas: boolean }>(
    '(() => { const l = document.querySelector("#editor .cam-layer"); const b = document.querySelector("#editor .cam-box"); return { hidden: l.hidden, canvas: !b.querySelector("canvas").hidden }; })()',
  );
  check(!r.hidden && r.canvas, 'the editor paints the pictures while it plays');
}
await page.screenshot('camera-editor.png');
await ev('document.getElementById("edPlay").click()');
await sleep(100);
// split the first clip in the editor and check both halves keep a picture
await ev('__onetake.editor.select(0, true)');
await ev('__onetake.editor.seek(0.6)');
await ev('document.getElementById("edSplit").click()');
await sleep(200);
{
  const after = await ev<{ n: number; videos: number[]; durs: number[] }>(
    '(() => { const s = __onetake.state.segments; return { n: s.length, videos: s.map(x => x.video ? x.video.pieces.reduce((a, p) => a + p.durationUs, 0) / 1e6 : -1), durs: s.map(x => x.pcm.length / x.sampleRate) }; })()',
  );
  console.log('after split:', JSON.stringify(after));
  check(after.n === segs.length + 1, 'the split made one more clip');
  check(
    after.videos.every((v, i) => Math.abs(v - (after.durs[i] ?? 0)) < 0.02),
    'every clip still has a picture as long as its audio',
  );
}
await ev('__onetake.editor.close()');
await sleep(200);

/* ------------------------------------------------------------ reload: the pictures are kept */
page.step('reload');
await page.reload();
await page.waitForApp();
await sleep(500);
await ev('document.getElementById("btnRestore").click()');
for (let i = 0; i < 100 && (await ev<number>('__onetake.state.segments.length')) === 0; i++) await sleep(200);
{
  const restored = await ev<{ n: number; withVideo: number; frames: number; key: boolean; bytes: boolean }>(
    '(() => { const s = __onetake.state.segments; const v = s[0]?.video; return { n: s.length, withVideo: s.filter(x => x.video).length, frames: v?.pieces[0]?.frames.length ?? 0, key: v?.pieces[0]?.frames[0]?.key ?? false, bytes: v?.pieces[0]?.frames[0]?.data instanceof Uint8Array }; })()',
  );
  console.log('restored:', JSON.stringify(restored));
  check(
    restored.n === segs.length + 1 && restored.withVideo === restored.n,
    'every phrase came back with its picture',
  );
  check(restored.frames > 0 && restored.key && restored.bytes, 'the frames came back as encoded bytes');
  check(
    await ev<boolean>('document.getElementById("camOn").checked'),
    'the camera switch is remembered as on',
  );
  check(await ev<boolean>('!__onetake.camera.on'), 'the camera does not open by itself after a reload');
}
await ev('__onetake.setCameraOn(false)');
await sleep(200);
check(
  await ev<boolean>(
    'document.getElementById("camRow").hidden && document.querySelector("#stage .cam-layer").hidden',
  ),
  'switching the camera off hides the row and the picture',
);
check(page.errors().length === 0, `no page errors (${page.errors().join(' | ')})`);
page.close();
finish(`screenshots and camera.mp4 in ${OUT}`);
