/**
 * End-to-end check: real server (with ffmpeg), built client, headless Chrome with a fake microphone.
 * Records a lecture with slide changes mid-speech in auto mode, then in press-to-speak mode with the
 * real Space key, exports to MP4, HLS, DASH, WebM and an in-memory MP4, verifies every output with
 * ffprobe, then reloads, resumes and plays the preview.
 *
 *   npm run e2e            (builds first)
 *   tsx packages/e2e/src/run.ts --out /tmp/one-take-e2e
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
import { writeFixtures } from './make-fixtures.js';

const { values } = parseArgs({
  options: { out: { type: 'string' }, port: { type: 'string' }, keep: { type: 'boolean' } },
});
const OUT = path.resolve(values.out ?? path.join(ROOT, 'packages/e2e/out'));
const PORT = Number(values.port ?? 4399);
const CDP_PORT = PORT + 1;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const fixtures = await writeFixtures(path.join(OUT, 'fixtures'));
const exportsDir = path.join(OUT, 'exports');
fs.mkdirSync(exportsDir, { recursive: true });

// 1. server with the built client
await startServer(PORT, exportsDir);
const caps = (await (await fetch(`http://127.0.0.1:${PORT}/api/capabilities`)).json()) as {
  ffmpeg: { version: string } | null;
  presentations: { extensions: string[]; renderer: string };
};
check(caps.ffmpeg !== null, `server found ffmpeg ${caps.ffmpeg?.version ?? ''}`);
check(
  caps.presentations.extensions.includes('pptx'),
  `server converts PowerPoint files with ${caps.presentations.renderer}`,
);

// 1b. the pre-flight check: the server knows the machine and which hardware encoders work
interface SystemProfile {
  cpu: { model: string; cores: number; performanceCores: number | null };
  memory: { totalBytes: number; availableBytes: number | null };
  gpu: { name: string | null; cores: number | null };
  disk: { freeBytes: number | null };
  ffmpeg: {
    encoders: string[];
    brokenEncoders: string[];
    hwaccels: string[];
    benchmark: Record<string, number> | null;
    fastestEncoder: string | null;
  } | null;
  tier: string;
  maxEncodeJobs: number;
  notes: string[];
}
const system = (await (await fetch(`http://127.0.0.1:${PORT}/api/system`)).json()) as SystemProfile;
console.log(
  `system: ${system.cpu.model}, ${system.cpu.cores} cores, ${(system.memory.totalBytes / 1024 ** 3).toFixed(0)} GB, GPU ${system.gpu.name ?? '?'}; tier ${system.tier}; hw encoders ${system.ffmpeg?.encoders.join(',') ?? 'none'}; benchmark ${system.ffmpeg?.fastestEncoder ?? 'pending'}`,
);
check(system.cpu.cores > 0 && system.memory.totalBytes > 0, 'system check reports CPU and memory');
check(system.disk.freeBytes !== null && system.disk.freeBytes > 0, 'system check reports free disk space');
check(
  ['gpu', 'cpu-fast', 'cpu', 'constrained'].includes(system.tier),
  `system check picked a tier (${system.tier})`,
);
check(
  system.ffmpeg !== null && system.ffmpeg.brokenEncoders.length === 0,
  'every listed hardware encoder passed its self-test',
);
const serverHw = system.ffmpeg?.encoders.find((e) => e.startsWith('h264_')) ?? null;
if (process.platform === 'darwin') {
  check(system.gpu.name !== null, `GPU identified (${system.gpu.name ?? 'none'})`);
  check(serverHw === 'h264_videotoolbox', 'VideoToolbox H.264 encoder verified on this Mac');
}

// 2. headless Chrome with the WAV as microphone, played once from the moment the mic starts
startChrome({ cdpPort: CDP_PORT, profileDir: path.join(OUT, 'profile'), wav: fixtures.wav, loop: false });
const page = await Page.open(CDP_PORT, OUT);
page.watchdog(25 * 60_000); // the whole run, exports included
page.step('loading the decks');
const ev = <T = unknown>(expression: string, timeoutMs?: number) => page.ev<T>(expression, timeoutMs);
await page.navigate(`http://127.0.0.1:${PORT}/`);
await page.waitForApp();

// 3. a PowerPoint deck goes through the server's JavaScript renderer, then the PDF replaces it
await page.setFiles('#fileIn', [fixtures.pptx]);
for (let i = 0; i < 300 && (await ev<number>('__onetake.state.slides.length')) < 3; i++) await sleep(200);
check((await ev<number>('__onetake.state.slides.length')) === 3, 'pptx converted into three slides');
const origin = await ev<{ name: string; warnings: string[] } | null>(
  '__onetake.state.slideSource?.origin ?? null',
);
check(origin?.name === 'deck.pptx', `converted slides remember the deck (${origin?.name ?? 'no origin'})`);
check(
  (origin?.warnings.length ?? 0) === 0,
  `renderer made no notes${origin?.warnings.length ? `: ${origin.warnings.join(' | ')}` : ''}`,
);
check(
  (await ev<string>('document.getElementById("dropHint")?.textContent ?? ""')).includes('.pptx'),
  'drop zone says .pptx files are accepted',
);
await page.screenshot('pptx-slide.png');
{
  const slide = await ev<{ width: number; height: number }>(
    '(()=>{const s=__onetake.slides()[0];return {width:s.width,height:s.height}})()',
  );
  check(
    Math.abs(slide.width / slide.height - 16 / 9) < 0.01,
    `converted slide keeps the 16:9 shape (${slide.width}x${slide.height})`,
  );
}

await page.setFiles('#fileIn', [fixtures.pdf]);
for (let i = 0; i < 100 && (await ev<number>('__onetake.state.slides.length')) < 4; i++) await sleep(200);
check((await ev<number>('__onetake.state.slides.length')) === 4, 'four slides rendered');
if ((await ev<number>('__onetake.state.slides.length')) !== 4) {
  console.log('loading text:', await ev<string>('document.getElementById("loadingText")?.textContent ?? ""'));
  console.log('toast:', await ev<string>('document.getElementById("toast")?.textContent ?? ""'));
}

// 4. record with slide changes; the fake microphone plays speech.wav from the moment the mic starts
check((await ev<string>('__onetake.state.mode')) === 'auto', 'the app starts in auto mode');
check(
  (await ev<string>('document.getElementById("modeAuto").getAttribute("aria-checked")')) === 'true',
  'the mode switch shows Auto',
);
page.step('recording in auto mode');
check(await page.startMic(), 'mic started');
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
await page.screenshot('recording.png');

// 4b. press to speak: the mic is on but hears nothing until Space is held. The WAV played once and is
// now silent, so the mic is restarted (which rewinds the file) with the key work timed to its speech.
await ev('document.getElementById("modeHold").click()');
check((await ev<string>('__onetake.state.mode')) === 'hold', 'clicking Press to speak switches the mode');
check(
  (await ev<string>('document.getElementById("modeHold").getAttribute("aria-checked")')) === 'true' &&
    (await ev<string>('document.getElementById("modeAuto").getAttribute("aria-checked")')) === 'false',
  'the mode switch shows Press to speak',
);
check(
  await ev<boolean>('JSON.parse(localStorage.getItem("one-take.prefs")).captureMode === "hold"'),
  'the mode is remembered in the browser',
);
await ev('__onetake.goTo(3)');
const before = segs.length;
page.step('recording in press to speak');
check(await page.startMic(), 'mic started again for press to speak');
const t1 = Date.now();
const at1 = async (sec: number, fn: () => Promise<unknown>) => {
  const d = t1 + sec * 1000 - Date.now();
  if (d > 0) await sleep(d);
  await fn();
};
check(
  (await ev<string>('document.getElementById("statusText").textContent')) === 'Hold Space to speak',
  'status says to hold Space',
);
check(
  !(await ev<boolean>('document.getElementById("btnHold").hidden')),
  'the Hold to speak button is on the stage',
);
check(await ev<boolean>('document.getElementById("btnMute").hidden'), 'Mute is hidden in press to speak');
check(
  !(await ev<boolean>('document.getElementById("keyHold").hidden')) &&
    (await ev<boolean>('document.getElementById("keyMute").hidden')),
  'the shortcut legend shows Space and not M',
);
// the first phrase of the WAV (1.0-3.0 s) plays with the key up: nothing may be recorded
await at1(3.6, () => Promise.resolve());
check(
  (await ev<number>('__onetake.state.segments.length')) === before,
  'speech with the key up is not recorded',
);
// the second phrase (4.5-5.7 s) is caught by holding Space, with auto-repeat and a slide change inside
await at1(4.2, () => page.key(' ', 'keyDown'));
await at1(4.3, async () => {
  check(await ev<boolean>('__onetake.state.held'), 'Space down: the key is held');
  check(
    await ev<boolean>('document.getElementById("btnHold").classList.contains("held")'),
    'the stage button shows it is held',
  );
  check((await ev<number>('__onetake.state.current')) === 3, 'Space did not change the slide');
  for (let i = 0; i < 4; i++) await page.key(' ', 'keyDown', { repeat: true });
  check((await ev<number>('__onetake.state.current')) === 3, 'auto-repeat of Space does nothing');
});
await at1(5.1, () => page.press('ArrowLeft'));
await at1(6.1, () => page.key(' ', 'keyUp'));
await at1(6.3, async () => {
  check(!(await ev<boolean>('__onetake.state.held')), 'Space up: the key is released');
  const held = await ev<{ slide: number; joined: boolean; sec: number }[]>(
    `__onetake.state.segments.slice(${before}).map(s=>({slide:s.slide, joined:s.joined, sec:+(s.pcm.length/s.sampleRate).toFixed(2)}))`,
  );
  console.log('held phrases:', JSON.stringify(held));
  check(held.length === 2, 'one press with a slide change inside gives two joined parts');
  check(
    held[0]?.slide === 3 && held[1]?.slide === 2 && held[1].joined,
    'the parts sit on slide 4 then slide 3 and continue each other',
  );
  const total = held.reduce((a, s) => a + s.sec, 0);
  check(total > 1.0 && total < 2.2, `the press kept the phrase without its dead air (${total.toFixed(2)} s)`);
});
// the third phrase (8.7-11.2 s) is caught by holding the stage button with the mouse
await at1(8.4, async () => check(await page.mouseDown('#btnHold'), 'mouse down on the stage button'));
await at1(8.6, async () => check(await ev<boolean>('__onetake.state.held'), 'the stage button holds'));
await at1(11.6, () => page.mouseUp('#btnHold'));
await at1(11.8, async () => {
  check(!(await ev<boolean>('__onetake.state.held')), 'mouse up releases');
  check((await ev<number>('__onetake.state.segments.length')) === before + 3, 'the mouse press was recorded');
});
await page.screenshot('press-to-speak.png');
await ev('__onetake.stopMic()');
check(await ev<boolean>('document.getElementById("btnHold").hidden'), 'the stage button leaves with the mic');
await ev('document.getElementById("modeAuto").click()');
await ev('__onetake.goTo(0)');
// In auto mode Space is the next-slide key again
await page.press(' ');
check((await ev<number>('__onetake.state.current')) === 1, 'in auto mode Space moves to the next slide');
await ev('__onetake.goTo(0)');
// the three press-to-speak phrases are removed so the export checks below see the original recording
for (let i = 0; i < 3; i++) await ev('__onetake.deleteLast()');
check((await ev<number>('__onetake.state.segments.length')) === 4, 'back to the four auto-mode phrases');

// 5. exports through the server
const tl = await ev<{ total: number; items: number }>(
  '(()=>{const t=__onetake.timeline("recorded");return {total:+t.total.toFixed(2), items:t.items.length}})()',
);
console.log('timeline:', JSON.stringify(tl));
const browserCaps = await ev<{
  videoCodecs: string[];
  audioCodecs: string[];
  hardware: Record<string, number>;
  benchmark: { avc: { hardwareFps: number | null; softwareFps: number | null } } | null;
  hardwareConcurrency: number | null;
  gpu: string | null;
  browser: string | null;
}>('__onetake.browserCaps()');
console.log('browser codecs:', JSON.stringify(browserCaps));
check(
  typeof browserCaps.hardware.avc === 'number' && browserCaps.hardwareConcurrency !== null,
  `browser probed GPU encoders (avc up to ${browserCaps.hardware.avc}p) and ${browserCaps.hardwareConcurrency ?? '?'} threads`,
);
const bench = browserCaps.benchmark?.avc ?? null;
check(
  bench !== null && bench.softwareFps !== null && bench.softwareFps > 0,
  `browser raced its H.264 encoders (GPU ${bench?.hardwareFps ?? 'n/a'} fps, software ${bench?.softwareFps ?? 'n/a'} fps)`,
);
const browserHw = (browserCaps.hardware.avc ?? 0) >= 720;
const softwareWins =
  bench !== null &&
  bench.softwareFps !== null &&
  (bench.hardwareFps === null || bench.softwareFps > bench.hardwareFps * 1.15);
const expectedAcceleration = softwareWins
  ? 'prefer-software'
  : browserHw
    ? 'prefer-hardware'
    : 'no-preference';

interface ServerResult {
  kind: 'server';
  job: {
    state: string;
    outputs: { path: string; kind: string; bytes: number }[];
    command: string | null;
    error: string | null;
  };
  plan: {
    browser: {
      container: string;
      videoCodec: string;
      hardwareAcceleration: string;
      latencyMode: string;
      hardware: boolean;
    };
    processing: unknown;
  };
  encoder: { hardwareAcceleration: string; latencyMode: string } | null;
  timing: { elapsedMs: number; encodeMs: number; videoSeconds: number };
}
const exportServer = (overrides: Record<string, unknown>) => {
  page.step(`exporting ${JSON.stringify(overrides)}`);
  return ev<ServerResult>(`__onetake.exportWith(${JSON.stringify(overrides)})`, 10 * 60_000);
};
const speed = (r: ServerResult) =>
  `${(r.timing.videoSeconds / (r.timing.encodeMs / 1000)).toFixed(1)}× real time encode, ${(r.timing.elapsedMs / 1000).toFixed(1)} s in all`;

// a. MP4: fragmented upload, faststart remux
const mp4 = await exportServer({
  fileName: 'lecture',
  container: 'mp4',
  resolution: { preset: '720p' },
  fps: 5,
});
console.log('mp4 plan:', mp4.plan.browser.container, '->', JSON.stringify(mp4.plan.processing));
console.log(`mp4 encoder: ${JSON.stringify(mp4.encoder)}; ${speed(mp4)}`);
check(mp4.job.state === 'done', `mp4 export done${mp4.job.error ? ` (${mp4.job.error})` : ''}`);
check(
  mp4.plan.browser.hardwareAcceleration === expectedAcceleration &&
    mp4.encoder?.hardwareAcceleration === expectedAcceleration,
  `fastest mode used the measured winner (${mp4.encoder?.hardwareAcceleration ?? 'none'}, expected ${expectedAcceleration})`,
);
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
  check(
    !(dash.job.command ?? '').includes('-hwaccel'),
    'dash re-encode decodes in software (faster on slides)',
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

// e2. compressed MP4 through the server's hardware encoder, as the fastest mode picks it
if (serverHw) {
  const gpu = await exportServer({
    fileName: 'gpu',
    container: 'mp4',
    resolution: { preset: '720p' },
    fps: 10,
    performance: { mode: 'fastest' },
    compression: {
      enabled: true,
      codec: 'h264',
      crf: 28,
      preset: 'veryfast',
      tune: 'none',
      outputFps: null,
      maxBitrateKbps: null,
      height: null,
      hardware: true,
    },
  });
  console.log(`gpu export: ${speed(gpu)}`);
  check(gpu.job.state === 'done', `gpu-compressed export done${gpu.job.error ? ` (${gpu.job.error})` : ''}`);
  check((gpu.job.command ?? '').includes(serverHw), `server compressed with ${serverHw}`);
  const p = probe(gpu.job.outputs[0]?.path ?? '');
  check(
    video(p)?.codec_name === 'h264' && video(p)?.height === 720 && audio(p)?.codec_name === 'aac',
    `gpu-compressed mp4 is h264 720p with aac (${video(p)?.codec_name ?? '?'} ${video(p)?.height ?? 0}p)`,
  );
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
page.step('exporting in memory');
const mem = await ev<{ kind: string; name: string; base64: string }>(
  `__onetake.exportWith(${JSON.stringify({ fileName: 'browser', destination: { kind: 'browser' }, container: 'mp4', resolution: { preset: '360p' }, fps: 5 })}, true)`,
  10 * 60_000,
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
page.step('reloading and resuming');
await page.reload();
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
check((await ev<string>('__onetake.state.mode')) === 'auto', 'the recording mode survived the reload');
await page.screenshot('restored.png');

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
await page.press('Backspace');
const afterDelete = await ev<number>('__onetake.state.segments.length');
await page.press('z', MODIFIER.ctrl);
check(
  afterDelete === 3 && (await ev<number>('__onetake.state.segments.length')) === 4,
  'Backspace and Ctrl+Z round-trip a phrase',
);

// 7b. the editor: scrub, select a stretch of a clip and cut it, split, move to another slide, delete,
// undo each one, and check that a change reaches IndexedDB. (Takes need the microphone, which the
// fake device has already played out; verify-editor in the job notes covers re-recording.)
page.step('editing');
const mouseAt = async (type: 'mousePressed' | 'mouseReleased' | 'mouseMoved', x: number, y: number) =>
  page.send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1,
  });
const along = async (selector: string, from: number, to: number) => {
  const r = await ev<{ x: number; y: number; w: number; h: number }>(
    `(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`,
  );
  const y = r.y + r.h / 2;
  await mouseAt('mouseMoved', r.x + r.w * from, y);
  await mouseAt('mousePressed', r.x + r.w * from, y);
  if (from !== to) await mouseAt('mouseMoved', r.x + r.w * to, y);
  await mouseAt('mouseReleased', r.x + r.w * to, y);
  await sleep(120);
};
const clipLens = () => ev<number[]>('__onetake.state.segments.map(s => s.pcm.length)');
await ev('__onetake.openEditor()');
check(
  await ev<boolean>('document.getElementById("editor").classList.contains("on")'),
  'editor opens from the test hook',
);
check(
  (await ev<number>('document.querySelectorAll("#edClips .seg").length')) === 4 &&
    (await ev<number>('document.querySelectorAll("#edScrub .blk").length')) === 4,
  'editor lists the four clips and draws one scrub block each',
);
await along('#edScrub .blocks', 0.6, 0.6);
const edTime = await ev<string>('document.getElementById("edTime").textContent');
check(/^0:0[3-6] \/ 0:0\d$/.test(edTime), `scrub bar moved the playhead (${edTime})`);
await ev('document.querySelector("#edClips .seg[data-i=\\"1\\"]").click()');
const lensBefore = await clipLens();
await along('#edWave', 0.25, 0.75);
check(
  !(await ev<boolean>('document.getElementById("edCut").disabled')),
  `dragging across the waveform selects a stretch (${await ev<string>('document.getElementById("edWaveHint").textContent')})`,
);
await ev('document.getElementById("edCut").click()');
await sleep(100);
const lensCut = await clipLens();
check(
  lensCut.length === 4 && Math.abs((lensCut[1] ?? 0) / (lensBefore[1] ?? 1) - 0.5) < 0.06,
  `cut removed half of clip 2 (${lensBefore[1]} -> ${lensCut[1]} samples)`,
);
await page.press('z', MODIFIER.ctrl);
await sleep(100);
check((await clipLens())[1] === lensBefore[1], 'Ctrl+Z in the editor restores the cut audio');
await along('#edWave', 0.5, 0.5);
await ev('document.getElementById("edSplit").click()');
await sleep(100);
const split = await ev<{ n: number; joined: boolean; sum: number }>(
  '(() => { const s = __onetake.state.segments; return { n: s.length, joined: s[2].joined && s[2].prevId === s[1].id, sum: s[1].pcm.length + s[2].pcm.length }; })()',
);
check(
  split.n === 5 && split.joined && split.sum === lensBefore[1],
  'split makes two halves that still play back to back',
);
await page.press('z', MODIFIER.ctrl);
await sleep(100);
await ev(
  '(() => { const s = document.getElementById("edSlide"); s.value = "3"; s.dispatchEvent(new Event("change")); })()',
);
await sleep(100);
check(
  (await ev<number>('__onetake.state.segments[1].slide')) === 3,
  'the Slide list moves a clip to another slide',
);
await page.press('Delete');
await sleep(100);
check((await ev<number>('__onetake.state.segments.length')) === 3, 'Delete removes the selected clip');
await ev('document.getElementById("edUndo").click()');
await sleep(100);
check(
  (await ev<number>('__onetake.state.segments.length')) === 4 &&
    (await ev<number>('__onetake.state.segments[1].slide')) === 3,
  'Undo brings the clip back, still on the new slide',
);
await page.screenshot('editor.png');
await page.press('Escape');
await sleep(100);
check(
  !(await ev<boolean>('document.getElementById("editor").classList.contains("on")')) &&
    (await ev<string>('document.querySelector("#segs .seg[data-i=\\"1\\"] .meta b").textContent')) ===
      'Slide 4',
  'Escape closes the editor and the main timeline shows the moved clip',
);
const stored = await ev<number | null>(
  `new Promise((resolve) => { const req = indexedDB.open('one-take'); req.onerror = () => resolve(null); req.onsuccess = () => { const db = req.result; const id = __onetake.state.segments[1].id; const get = db.transaction('segments').objectStore('segments').get(id); get.onsuccess = () => { db.close(); resolve(get.result ? get.result.slide : null); }; get.onerror = () => resolve(null); }; })`,
);
check(stored === 3, 'the edit was written to IndexedDB');

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
const sysLine = await ev<string>('document.getElementById("sysLine")?.textContent ?? ""');
console.log('dialog system line:', sysLine);
check(
  sysLine.includes('cores') && sysLine.includes('RAM') && sysLine.includes('GPU encoding'),
  'export dialog describes the server machine and the browser encoders',
);
check(
  (await ev<string>('document.querySelector("#perfModes input:checked")?.value ?? ""')) === 'fastest',
  'export dialog starts in the fastest mode',
);
const resourceLines = await ev<string[]>(
  '[...document.querySelectorAll("#resources .stage")].map(e => e.textContent)',
);
console.log('resource map:', resourceLines.join(' | '));
check(
  resourceLines.length >= 3 && resourceLines[0] === 'Browser encodes',
  'plan shows which stage runs on what',
);
// every control in a section starts at the same left edge and fills the control column
const controlEdges = await ev<{ lefts: number[]; widths: number[] }>(
  `(() => { const cs = [...document.querySelectorAll('#exportModal .col:first-child .row .ctl > select, #exportModal .col:first-child .row .ctl > input[type=text]')].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 0); return { lefts: cs.map((r) => Math.round(r.left)), widths: cs.map((r) => Math.round(r.width)) }; })()`,
);
check(
  controlEdges.lefts.length >= 5 &&
    new Set(controlEdges.lefts).size === 1 &&
    new Set(controlEdges.widths).size === 1,
  `dropdowns and fields line up (${controlEdges.lefts.length} controls at x=${controlEdges.lefts[0] ?? '?'}, ${controlEdges.widths[0] ?? '?'} px wide)`,
);
await page.screenshot('export-dialog.png');
// Browse… opens the folder picker on top of the export dialog, not behind it
await ev('document.getElementById("btnBrowse").click()');
await sleep(400);
const pickerOnTop = await ev<boolean>(
  `(() => { const p = document.querySelector('.modal.picker'); if (!p || !p.classList.contains('on')) return false; const r = p.querySelector('.box').getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + 20); return top !== null && p.contains(top); })()`,
);
check(pickerOnTop, 'Browse… opens the folder picker in front of the export dialog');
await page.screenshot('export-browse.png');
await ev('document.querySelector(".modal.picker .actions button:not(.ghost):not(.primary)").click()');
await sleep(200);
check(
  !(await ev<boolean>('document.querySelector(".modal.picker").classList.contains("on")')),
  'Cancel closes the picker',
);
// switching to "smallest file" turns the server GPU encoder off and picks a slow preset
await ev('document.querySelector("#perfModes input[value=quality]").click()');
await sleep(100);
const qualityReq = await ev<{
  performance: { mode: string };
  compression: { hardware: boolean; preset: string };
}>('JSON.parse(JSON.stringify(__onetake.exportDialog.currentRequest))');
check(
  qualityReq.performance.mode === 'quality' &&
    !qualityReq.compression.hardware &&
    qualityReq.compression.preset === 'slow',
  'quality mode switches compression to slow software presets',
);
await ev('document.querySelector("#perfModes input[value=fastest]").click()');
await sleep(100);
const fastReq = await ev<{ compression: { hardware: boolean; preset: string } }>(
  'JSON.parse(JSON.stringify(__onetake.exportDialog.currentRequest))',
);
// By now the background encoder race has finished; the dialog re-read the profile when it opened.
const systemNow = (await (await fetch(`http://127.0.0.1:${PORT}/api/system`)).json()) as SystemProfile;
console.log(
  `encoder benchmark: ${JSON.stringify(systemNow.ffmpeg?.benchmark)} → ${systemNow.ffmpeg?.fastestEncoder ?? 'none'}`,
);
check(
  systemNow.ffmpeg?.fastestEncoder !== null && systemNow.ffmpeg?.benchmark !== null,
  'server raced its H.264 encoders after start-up',
);
const winnerIsHardware = /_(videotoolbox|nvenc|qsv|vaapi|amf)$/.test(systemNow.ffmpeg?.fastestEncoder ?? '');
check(
  fastReq.compression.hardware === winnerIsHardware && fastReq.compression.preset === 'veryfast',
  `fastest mode picks the measured winner for compression (${systemNow.ffmpeg?.fastestEncoder ?? '?'}, hardware=${winnerIsHardware}) and veryfast`,
);

// 8b. an export started from the dialog itself: the settings give way to the exporting view with a
// time left, the steps and the live meters, then the result, and "Back to settings" returns
page.step('exporting from the dialog');
await ev(
  `(() => { const d = __onetake.exportDialog; const q = d.currentRequest; q.fileName = 'from-dialog'; q.destination = { kind: 'server', directory: ${JSON.stringify(exportsDir)}, overwrite: true }; q.container = 'mp4'; q.resolution = { preset: '360p' }; q.fps = 5; q.compression.enabled = false; d.refresh(); })()`,
);
await ev('document.getElementById("btnStartExport").click()');
await sleep(150);
check(
  (await ev<boolean>('document.getElementById("exportProgress").hidden === false')) &&
    (await ev<boolean>('document.querySelector("#exportModal .settings").hidden === true')),
  'the export dialog switches to the exporting view',
);
const etaTrace: { stage: string; remainingSec: number | null; basis: string | null; overall: number }[] = [];
for (let i = 0; i < 600; i++) {
  const p = await ev<{
    stage: string;
    remainingSec: number | null;
    basis: string | null;
    overall: number;
  } | null>(
    '(() => { const p = __onetake.exportDialog.progress; return p ? { stage: p.stage, remainingSec: p.remainingSec, basis: p.basis, overall: p.overall } : null; })()',
  );
  if (p) etaTrace.push(p);
  if (await ev<boolean>('document.getElementById("btnCancelExport").hidden')) break;
  await sleep(100);
}
const dialogExportSec = etaTrace.length * 0.1;
const highest = Math.max(...etaTrace.map((p) => p.remainingSec ?? 0));
console.log(
  `dialog export: ${etaTrace.length} updates, time left first ${etaTrace.find((p) => p.remainingSec !== null)?.remainingSec?.toFixed(1) ?? 'none'} s, highest ${highest.toFixed(1)} s, bases ${[...new Set(etaTrace.map((p) => p.basis))].join(', ')}`,
);
check(
  etaTrace.some((p) => p.remainingSec !== null),
  'the exporting view shows a time left',
);
check(
  highest <= Math.max(30, dialogExportSec * 3),
  `the time left never claimed more than three times the real time (${highest.toFixed(0)} s against ${dialogExportSec.toFixed(0)} s)`,
);
const steps = await ev<string[]>(
  '[...document.querySelectorAll("#exportSteps li")].map((li) => li.dataset.step + ":" + li.className)',
);
check(
  steps.length >= 2 && steps.every((s) => s.endsWith(':done')),
  `every step is shown done after the export (${steps.join(', ')})`,
);
check(
  (await ev<string>('document.getElementById("etaFigure").textContent')) === 'Done' &&
    (await ev<string>('document.getElementById("kOverall").textContent')) === '100 %',
  'the hero figure reads Done at 100 %',
);
const resultText = await ev<string>('document.getElementById("result").textContent ?? ""');
check(
  resultText.includes('Saved') && resultText.includes('from-dialog.mp4'),
  'the result names the saved file',
);
const liveFacts = await ev<string>(
  '[...document.querySelectorAll("#cpuText, #memText, #factBrowser")].map((e) => e.textContent).join(" | ")',
);
console.log('live meters:', liveFacts);
check(
  /\d+ % of \d+ cores/.test(liveFacts) && /GB of .*GB/.test(liveFacts),
  'the live meters show CPU and memory',
);
await page.screenshot('export-done.png');
await ev('document.getElementById("btnBackToSettings").click()');
await sleep(100);
check(
  (await ev<boolean>('document.querySelector("#exportModal .settings").hidden === false')) &&
    (await ev<boolean>('document.getElementById("exportProgress").hidden === true')),
  '"Back to settings" returns to the settings',
);

// 9. closing the slides: the × after the deck name asks first while phrases exist, Escape and
// "Keep working" back out, confirming clears the slides, the phrases and the saved copy
page.step('closing the slides');
await ev('__onetake.exportDialog.close()');
const confirmOpen = () => ev<boolean>('document.getElementById("confirm").classList.contains("on")');
const phrasesBefore = await ev<number>('__onetake.state.segments.length');
check(
  !(await ev<boolean>('document.getElementById("btnClose").hidden')),
  'the × after the deck name is shown',
);
await ev('document.getElementById("btnClose").click()');
await sleep(150);
check(await confirmOpen(), 'closing with phrases on the slides asks first');
check(
  (await ev<string>('document.activeElement?.id ?? ""')) === 'confirmNo',
  'the safe answer (Keep working) has the focus',
);
await page.screenshot('close-confirm.png');
// Escape as a page event: the dialog's handler is on the document and does not check isTrusted.
// (Twice, an Escape injected through CDP with this dialog open was followed by the renderer
// freezing for good, even to Debugger.pause; the key itself is covered above, on the editor.)
await ev(
  '(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }))',
);
await sleep(100);
check(
  !(await confirmOpen()) && (await ev<number>('__onetake.state.segments.length')) === phrasesBefore,
  'Escape keeps the session',
);
await ev('document.getElementById("btnClose").click()');
await sleep(150);
await ev('document.getElementById("confirmNo").click()');
await sleep(100);
check(
  !(await confirmOpen()) && (await ev<number>('__onetake.state.segments.length')) === phrasesBefore,
  'Keep working keeps the session',
);
await ev('document.getElementById("btnClose").click()');
await sleep(150);
await ev('document.getElementById("confirmYes").click()');
check(
  await page.waitFor('__onetake.state.slides.length === 0 && __onetake.state.segments.length === 0'),
  'Close and delete clears the slides and the phrases',
);
check(
  (await ev<boolean>('document.getElementById("btnClose").hidden')) &&
    (await ev<string>('getComputedStyle(document.getElementById("empty")).display')) !== 'none',
  'the stage is back to "Load your slides" and the × is gone',
);
await page.reload();
await page.waitForApp();
await sleep(800);
check(
  !(await ev<boolean>('document.getElementById("restore").classList.contains("on")')),
  'nothing is offered to resume after closing',
);

const bad = page.errors();
check(bad.length === 0, `no page errors${bad.length ? `: ${bad.join(' | ')}` : ''}`);
if (page.logs.length) console.log('console:', page.logs.join('\n'));

page.close();
finish(`outputs in ${OUT}`);
