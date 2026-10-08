/**
 * End-to-end check: real server (with ffmpeg), built client, headless Chrome with a fake microphone.
 * Records a lecture with slide changes mid-speech, exports to MP4, HLS, DASH, WebM and an in-memory MP4,
 * verifies every output with ffprobe, then reloads, resumes and plays the preview.
 *
 *   npm run e2e            (builds first)
 *   tsx packages/e2e/src/run.ts --out /tmp/one-take-e2e
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { Cdp } from './cdp.js';
import { writeFixtures } from './make-fixtures.js';

const { values } = parseArgs({
  options: { out: { type: 'string' }, port: { type: 'string' }, keep: { type: 'boolean' } },
});
const ROOT = path.resolve(new URL('../../..', import.meta.url).pathname);
const OUT = path.resolve(values.out ?? path.join(ROOT, 'packages/e2e/out'));
const PORT = Number(values.port ?? 4399);
const CDP_PORT = PORT + 1;
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  console.log(`${condition ? '  ok ' : ' FAIL'} ${message}`);
  if (!condition) failures.push(message);
}

interface Probe {
  streams: {
    codec_type: string;
    codec_name: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    sample_rate?: string;
  }[];
  format: { duration?: string; format_name?: string };
}
function probe(file: string): Probe {
  const out = execFileSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate',
    '-show_entries',
    'format=duration,format_name',
    '-of',
    'json',
    file,
  ]);
  return JSON.parse(out.toString()) as Probe;
}
function video(p: Probe) {
  return p.streams.find((s) => s.codec_type === 'video');
}
function audio(p: Probe) {
  return p.streams.find((s) => s.codec_type === 'audio');
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const fixtures = writeFixtures(path.join(OUT, 'fixtures'));
const exportsDir = path.join(OUT, 'exports');
fs.mkdirSync(exportsDir, { recursive: true });

const children: ChildProcess[] = [];
process.on('exit', () => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
});

// 1. server with the built client
const server = spawn(
  process.execPath,
  [
    path.join(ROOT, 'packages/server/dist/index.js'),
    '--port',
    String(PORT),
    '--dir',
    exportsDir,
    '--log-level',
    'warn',
  ],
  { stdio: ['ignore', 'inherit', 'inherit'] },
);
children.push(server);
let healthy = false;
for (let i = 0; i < 100 && !healthy; i++) {
  try {
    healthy = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok;
  } catch {
    await sleep(100);
  }
}
check(healthy, 'server is up');
const caps = (await (await fetch(`http://127.0.0.1:${PORT}/api/capabilities`)).json()) as {
  ffmpeg: { version: string } | null;
};
check(caps.ffmpeg !== null, `server found ffmpeg ${caps.ffmpeg?.version ?? ''}`);

// 2. headless Chrome with the WAV as microphone
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(OUT, 'profile')}`,
    '--no-first-run',
    '--hide-scrollbars',
    '--window-size=1400,900',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${fixtures.wav}%noloop`,
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=AudioServiceSandbox',
  ],
  { stdio: 'ignore' },
);
children.push(chrome);
const cdp = new Cdp(CDP_PORT);
await cdp.connect();
const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
const { sessionId: S } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
  targetId,
  flatten: true,
});
const logs: string[] = [];
cdp.on((m) => {
  if (m.sessionId !== S) return;
  if (m.method === 'Runtime.consoleAPICalled') {
    const p = m.params as { type: string; args: { value?: unknown; description?: string }[] };
    const text = p.args
      .map((a) => {
        const v = a.value ?? a.description;
        if (v === undefined) return '';
        return typeof v === 'string' ? v : JSON.stringify(v);
      })
      .join(' ');
    logs.push(`${p.type}: ${text}`);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const p = m.params as { exceptionDetails: { text: string; exception?: { description?: string } } };
    logs.push(`EXCEPTION: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`);
  }
});
await cdp.send('Page.enable', {}, S);
await cdp.send('Runtime.enable', {}, S);
const ev = async <T = unknown>(expression: string): Promise<T> => {
  const r = await cdp.send<{
    result: { value: T };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, S);
  if (r.exceptionDetails)
    throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};
const screenshot = async (name: string) => {
  const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, S);
  fs.writeFileSync(path.join(OUT, name), Buffer.from(shot.data, 'base64'));
};

process.on('uncaughtException', (error) => {
  console.error(error);
  if (logs.length) console.error('console:', logs.join('\n'));
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  console.error(error);
  if (logs.length) console.error('console:', logs.join('\n'));
  process.exit(1);
});

const loaded = cdp.waitFor('Page.loadEventFired', S);
await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }, S);
await loaded;
for (let i = 0; i < 50 && !(await ev<boolean>('Boolean(window.__onetake)')); i++) await sleep(100);
check(await ev<boolean>('Boolean(window.__onetake)'), 'app booted');
for (let i = 0; i < 50 && !(await ev<boolean>('Boolean(__onetake.serverCaps())')); i++) await sleep(100);
check(await ev<boolean>('Boolean(__onetake.serverCaps())'), 'client sees the server');
await cdp.send(
  'Emulation.setDeviceMetricsOverride',
  { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false },
  S,
);

// 3. slides through the file input
const { root } = await cdp.send<{ root: { nodeId: number } }>('DOM.getDocument', {}, S);
const { nodeId } = await cdp.send<{ nodeId: number }>(
  'DOM.querySelector',
  { nodeId: root.nodeId, selector: '#fileIn' },
  S,
);
await cdp.send('DOM.setFileInputFiles', { files: [fixtures.pdf], nodeId }, S);
for (let i = 0; i < 100 && (await ev<number>('__onetake.state.slides.length')) < 4; i++) await sleep(200);
check((await ev<number>('__onetake.state.slides.length')) === 4, 'four slides rendered');
if ((await ev<number>('__onetake.state.slides.length')) !== 4) {
  console.log('loading text:', await ev<string>('document.getElementById("loadingText")?.textContent ?? ""'));
  console.log('toast:', await ev<string>('document.getElementById("toast")?.textContent ?? ""'));
}

// 4. record with slide changes; the fake microphone plays speech.wav from the moment the mic starts
await ev('__onetake.startMic()');
const t0 = Date.now();
const at = async (sec: number, fn: () => Promise<unknown>) => {
  const d = t0 + sec * 1000 - Date.now();
  if (d > 0) await sleep(d);
  await fn();
};
await at(4.0, () => ev('__onetake.goTo(1)')); // during a pause
await at(10.0, () => ev('__onetake.goTo(2)')); // in the middle of the third phrase
await at(12.3, () => ev('__onetake.goTo(0)')); // back to the first slide, in silence
await at(16.5, () => Promise.resolve());
await ev('__onetake.stopMic()');
const segs = await ev<{ slide: number; sec: number; joined: boolean }[]>(
  '__onetake.state.segments.map(s=>({slide:s.slide, sec:+(s.pcm.length/s.sampleRate).toFixed(2), joined:s.joined}))',
);
console.log('segments:', JSON.stringify(segs));
check(segs.length === 4, 'four phrases recorded (one split by the slide change)');
check(
  segs[0]?.slide === 0 && segs[1]?.slide === 1 && segs[2]?.slide === 1 && segs[3]?.slide === 2,
  'phrases sit on the right slides',
);
check(segs[3]?.joined === true, 'the split phrase continues on the next slide');
check(
  (segs[0]?.sec ?? 0) > 1.8 && (segs[0]?.sec ?? 0) < 2.6,
  'first phrase keeps its length plus pre-roll and tail',
);
await screenshot('recording.png');

// 5. exports through the server
const tl = await ev<{ total: number; items: number }>(
  '(()=>{const t=__onetake.timeline("recorded");return {total:+t.total.toFixed(2), items:t.items.length}})()',
);
console.log('timeline:', JSON.stringify(tl));
const browserCaps = await ev<{ videoCodecs: string[]; audioCodecs: string[] }>('__onetake.browserCaps()');
console.log('browser codecs:', JSON.stringify(browserCaps));

interface ServerResult {
  kind: 'server';
  job: {
    state: string;
    outputs: { path: string; kind: string; bytes: number }[];
    command: string | null;
    error: string | null;
  };
  plan: { browser: { container: string; videoCodec: string }; processing: unknown };
}
const exportServer = (overrides: Record<string, unknown>) =>
  ev<ServerResult>(`__onetake.exportWith(${JSON.stringify(overrides)})`);

// a. MP4: fragmented upload, faststart remux
const mp4 = await exportServer({
  fileName: 'lecture',
  container: 'mp4',
  resolution: { preset: '720p' },
  fps: 5,
});
console.log('mp4 plan:', mp4.plan.browser.container, '->', JSON.stringify(mp4.plan.processing));
check(mp4.job.state === 'done', `mp4 export done${mp4.job.error ? ` (${mp4.job.error})` : ''}`);
{
  const file = mp4.job.outputs[0]?.path ?? '';
  check(file.endsWith('lecture.mp4'), `mp4 saved as ${file}`);
  const p = probe(file);
  const v = video(p);
  check(
    v?.codec_name === 'h264' && v.width === 1280 && v.height === 720,
    `mp4 is h264 1280x720 (${v?.codec_name ?? '?'} ${v?.width ?? 0}x${v?.height ?? 0})`,
  );
  check(v?.r_frame_rate === '5/1', `mp4 frame rate is 5 fps (${v?.r_frame_rate ?? '?'})`);
  check(audio(p)?.codec_name === 'aac', 'mp4 has aac audio');
  const dur = Number(p.format.duration);
  check(
    Math.abs(dur - (tl.total + 0.25)) < 0.3,
    `mp4 duration ${dur.toFixed(2)} s matches timeline ${tl.total} s`,
  );
  const head = fs.readFileSync(file).subarray(0, 64).toString('latin1');
  check(head.includes('moov'), 'mp4 has the index at the front (faststart)');
}

// b. HLS by copying, 2 s segments
const hls = await exportServer({
  fileName: 'stream',
  container: 'hls',
  resolution: { preset: '480p' },
  fps: 10,
  streaming: { segmentSeconds: 2, hlsSegmentType: 'fmp4', ladder: false },
});
check(hls.job.state === 'done', `hls export done${hls.job.error ? ` (${hls.job.error})` : ''}`);
{
  const dir = hls.job.outputs[0]?.path ?? '';
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  check(
    files.includes('index.m3u8') && files.includes('init.mp4'),
    `hls folder has playlist and init segment (${files.length} files)`,
  );
  check(files.filter((f) => f.endsWith('.m4s')).length >= 4, 'hls has several segments');
  const p = probe(path.join(dir, 'index.m3u8'));
  check(video(p)?.codec_name === 'h264' && video(p)?.height === 480, 'hls plays as h264 480p');
  check(
    Math.abs(Number(p.format.duration) - (tl.total + 0.25)) < 0.5,
    `hls duration ${Number(p.format.duration).toFixed(2)} s`,
  );
}

// c. DASH with server compression (h264 crf, fps and size change)
const dash = await exportServer({
  fileName: 'adaptive',
  container: 'dash',
  resolution: { preset: '720p' },
  fps: 15,
  compression: {
    enabled: true,
    codec: 'h264',
    crf: 30,
    preset: 'ultrafast',
    tune: 'stillimage',
    outputFps: 10,
    maxBitrateKbps: 800,
    height: 360,
    hardware: false,
  },
  streaming: { segmentSeconds: 2, hlsSegmentType: 'fmp4', ladder: false },
});
check(dash.job.state === 'done', `dash export done${dash.job.error ? ` (${dash.job.error})` : ''}`);
{
  const dir = dash.job.outputs[0]?.path ?? '';
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  check(
    files.includes('manifest.mpd') && files.some((f) => f.endsWith('.m4s')),
    `dash folder has manifest and segments (${files.length} files)`,
  );
  check(
    (dash.job.command ?? '').includes('-crf 30') && (dash.job.command ?? '').includes('tune stillimage'),
    'dash was compressed with crf 30 + stillimage',
  );
  // ffprobe may lack a DASH demuxer, so probe the init segment plus the first chunk instead.
  const joined = path.join(OUT, 'dash-probe.mp4');
  fs.writeFileSync(
    joined,
    Buffer.concat([
      fs.readFileSync(path.join(dir, 'init-0.m4s')),
      fs.readFileSync(path.join(dir, 'chunk-0-00001.m4s')),
    ]),
  );
  const v = video(probe(joined));
  check(
    v?.height === 360 && v.r_frame_rate === '10/1',
    `dash re-encoded to 360p 10 fps (${v?.height ?? 0}p ${v?.r_frame_rate ?? '?'})`,
  );
  const mpd = fs.readFileSync(path.join(dir, 'manifest.mpd'), 'utf8');
  check(
    mpd.includes('mediaPresentationDuration="PT7.') &&
      mpd.includes('codecs="avc1') &&
      mpd.includes('codecs="mp4a'),
    'dash manifest lists h264 and aac representations',
  );
}

// d. WebM straight from the browser (VP9 + Opus) when the browser can encode it
if (browserCaps.videoCodecs.includes('vp9')) {
  const webm = await exportServer({
    fileName: 'web',
    container: 'webm',
    resolution: { preset: '360p' },
    fps: 10,
  });
  check(webm.job.state === 'done', `webm export done${webm.job.error ? ` (${webm.job.error})` : ''}`);
  check(webm.plan.processing === null, 'webm needed no ffmpeg');
  const p = probe(webm.job.outputs[0]?.path ?? '');
  check(
    video(p)?.codec_name === 'vp9' && audio(p)?.codec_name === 'opus',
    `webm is vp9/opus (${video(p)?.codec_name ?? '?'}/${audio(p)?.codec_name ?? '?'})`,
  );
}

// e. compressed MP4 with HEVC and a frame-rate change
const hevc = await exportServer({
  fileName: 'small',
  container: 'mp4',
  resolution: { preset: '480p' },
  fps: 15,
  compression: {
    enabled: true,
    codec: 'h265',
    crf: 32,
    preset: 'ultrafast',
    tune: 'none',
    outputFps: 5,
    maxBitrateKbps: null,
    height: null,
    hardware: false,
  },
});
check(hevc.job.state === 'done', `hevc export done${hevc.job.error ? ` (${hevc.job.error})` : ''}`);
{
  const p = probe(hevc.job.outputs[0]?.path ?? '');
  check(
    video(p)?.codec_name === 'hevc' && video(p)?.r_frame_rate === '5/1',
    `hevc mp4 at 5 fps (${video(p)?.codec_name ?? '?'} ${video(p)?.r_frame_rate ?? '?'})`,
  );
  const big = mp4.job.outputs[0]?.bytes ?? 0;
  const small = hevc.job.outputs[0]?.bytes ?? 0;
  console.log(`sizes: mp4 ${big} bytes, compressed hevc ${small} bytes`);
}

// f. overwrite protection: a second export with the same name gets a new name
const again = await exportServer({
  fileName: 'lecture',
  container: 'mp4',
  resolution: { preset: '360p' },
  fps: 5,
});
check(
  (again.job.outputs[0]?.path ?? '').endsWith('lecture (2).mp4'),
  `second export kept the first file (${path.basename(again.job.outputs[0]?.path ?? '')})`,
);

// g. in-memory export in the browser (no server involved)
const mem = await ev<{ kind: string; name: string; base64: string }>(
  `__onetake.exportWith(${JSON.stringify({ fileName: 'browser', destination: { kind: 'browser' }, container: 'mp4', resolution: { preset: '360p' }, fps: 5 })}, true)`,
);
check(mem.kind === 'blob', 'browser export produced a file in memory');
{
  const file = path.join(OUT, mem.name);
  fs.writeFileSync(file, Buffer.from(mem.base64, 'base64'));
  const p = probe(file);
  check(video(p)?.codec_name === 'h264' && video(p)?.width === 640, 'browser mp4 is h264 640x360');
}

check(
  !fs.readdirSync(exportsDir).some((f) => f.includes('.uploading') || f.includes('.processing')),
  'no temporary files left behind',
);
console.log('exports folder:', fs.readdirSync(exportsDir).join(', '));

// 6. reload and resume
const loaded2 = cdp.waitFor('Page.loadEventFired', S);
await cdp.send('Page.reload', {}, S);
await loaded2;
await sleep(800);
check(
  await ev<boolean>('document.getElementById("restore").classList.contains("on")'),
  'restore banner offered after reload',
);
await ev('document.getElementById("btnRestore").click()');
for (let i = 0; i < 100 && (await ev<number>('__onetake.state.segments.length')) === 0; i++) await sleep(200);
await sleep(500);
check(
  (await ev<number>('__onetake.state.segments.length')) === 4 &&
    (await ev<number>('__onetake.state.slides.length')) === 4,
  'session restored with phrases and slides',
);
await screenshot('restored.png');

// 7. preview walks through slides and stops; delete/undo round-trips
await ev('document.getElementById("btnPreview").click()');
const seen: string[] = [];
for (let i = 0; i < 24; i++) {
  await sleep(400);
  seen.push(await ev<string>('__onetake.state.current + (__onetake.state.previewing ? "" : "x")'));
}
console.log('preview slides over time:', seen.join(' '));
check(
  seen.some((s) => s.startsWith('2')) && seen[seen.length - 1]?.endsWith('x') === true,
  'preview reached slide 3 and stopped by itself',
);
await ev('__onetake.deleteLast()');
const afterDelete = await ev<number>('__onetake.state.segments.length');
await ev('__onetake.undoDelete()');
check(
  afterDelete === 3 && (await ev<number>('__onetake.state.segments.length')) === 4,
  'delete and undo round-trip',
);

// 8. the export dialog opens and plans without blockers
await ev('__onetake.openExport()');
await sleep(300);
check(
  await ev<boolean>('document.getElementById("exportModal").classList.contains("on")'),
  'export dialog opens',
);
check(
  (await ev<number>('document.querySelectorAll("#exportModal ul.blockers li").length')) === 0,
  'export dialog shows no blockers',
);
await screenshot('export-dialog.png');

const bad = logs.filter((l) => l.startsWith('EXCEPTION') || l.startsWith('error'));
check(bad.length === 0, `no page errors${bad.length ? `: ${bad.join(' | ')}` : ''}`);
if (logs.length) console.log('console:', logs.join('\n'));

cdp.close();
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`\nall checks passed; outputs in ${OUT}`);
process.exit(0);
