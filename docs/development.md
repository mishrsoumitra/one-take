# Development

This guide is for changing the code: where things are, how to run the tests, how the end-to-end runs drive the real app in headless Chrome, which browsers work, and how the interface is styled.

## Contents

- [Project layout](#project-layout)
- [Scripts](#scripts)
- [Tooling](#tooling)
- [Unit tests](#unit-tests)
- [End-to-end runs](#end-to-end-runs)
- [The stress run](#the-stress-run)
- [Browser support](#browser-support)
- [Design system](#design-system)

## Project layout

npm workspaces with TypeScript project references. `shared` is built first; `server` and `client` depend on it.

```
one-take/
├── package.json              scripts, workspaces, dev tooling
├── tsconfig.base.json        strict compiler options shared by every package
├── eslint.config.js          typescript-eslint strictTypeChecked + stylisticTypeChecked, import order
├── vitest.config.ts          three test projects: shared, server, client
├── scripts/start.mjs         `npm start`: install, build and fetch the models when needed, then the server
├── scripts/fetch-models.mjs  `npm run models`: fetches the speaker and face models into the client's public folder
├── scripts/setup-studio.mjs  `npm run studio`: the studio's Python environment and its model checkpoints
├── docs/                     these guides
└── packages/
    ├── shared/               types and logic used by both sides (no DOM, no Node APIs)
    │   └── src/
    │       ├── api.ts            zod schemas and inferred types for every request and response
    │       ├── containers.ts     container and codec catalog, which combinations are valid, ffmpeg names
    │       ├── presets.ts        resolution presets, frame rates, quality levels, CRF ranges, ladder rungs
    │       ├── plan.ts           planExport(): request + capabilities → browser plan + server spec + warnings + blockers
    │       ├── estimate.ts       size and frame estimates from a plan
    │       ├── eta.ts            time left that starts from the plan and settles on a windowed measured rate
    │       ├── presentations.ts  accepted slide file types (PDF, PowerPoint, images)
    │       ├── system.ts         SystemProfile types and the machine tier
    │       ├── performance.ts    performance modes, browser capability probe results, applyPerformanceMode()
    │       ├── resources.ts      resource map per export stage and performance warnings
    │       ├── models.ts         the model files for the voice and lip checks: names, URLs, checksums
    │       └── util.ts           formatBytes, formatDuration, sanitizeFileName
    ├── server/               Fastify server (Node 22+)
    │   ├── py/studio.py          the studio worker: ClearerVoice's models over JSON lines
    │   └── src/
    │       ├── index.ts          entry: config, system check, ffmpeg detection, start, graceful shutdown
    │       ├── doctor.ts         `npm run doctor` / `npm run bench`: the system check and the races without the server
    │       ├── config.ts         flags and environment variables, where model files are looked for
    │       ├── app.ts            app factory: loopback checks, error handler, static client, routes
    │       ├── routes/           capabilities and system, fs, convert (.pptx → PDF), exports (chunk upload, finish, SSE, cancel, reveal), library, transcribe, studio, models
    │       ├── services/
    │       │   ├── jobs.ts       JobManager: positioned writes, finish, process (with the hardware decoder when the switch is on), cancel, cleanup
    │       │   ├── ffmpeg.ts     detection, pure buildFfmpegArgs(), the test clip, encoder and decoder self-tests, progress parsing, runFfmpeg()
    │       │   ├── models.ts     ModelStore: a client model's verified copy from wherever it is, fetched from its publisher when nowhere
    │       │   ├── library.ts    ExportLibrary: finished exports in exports.json, read back with what the disk says now
    │       │   ├── transcribe.ts detectTranscription() (whisper-cli or openai-whisper), TranscriptionManager
    │       │   ├── studio.ts     detectStudio(), StudioWorker (the long-lived worker process), StudioManager (jobs)
    │       │   ├── filesystem.ts listing, mkdir, free space, unique names, shortcuts, the "only our files" folder check
    │       │   ├── system.ts     detectSystem(): CPU/RAM/GPU/disk, hardware self-tests, benchmarkEncoders(), benchmarkDecoders(), benchmark.json
    │       │   ├── load.ts       LoadMonitor: live CPU and memory for /api/system/load, ffmpeg process sampling
    │       │   ├── convert.ts    PptxConverter: runs the renderer in a worker thread with a heap limit
    │       │   └── pptx/         PowerPoint → PDF: html (text runs → paragraphs), layout (line breaking), fonts, geometry, render (pdfkit), worker
    │       └── util/             errors.ts (ApiError with stable codes), semaphore.ts (limits concurrent re-encodes), desktop.ts (reveal, open)
    ├── client/               Vite + TypeScript app, no framework
    │   ├── public/fonts/         Mona Sans (variable weight, OFL); public/models/ holds the fetched models (not in git)
    │   └── src/
    │       ├── main.ts           boot; exposes window.__onetake test hooks
    │       ├── app/              App controller, Store (state + event bus), types and defaults
    │       ├── audio/            the shared AudioContext (48 kHz), MicCapture (source → DeepFilterNet3 → capture worklet, or the classic filter), the capture processor, preview playback, take recording for the editor
    │       ├── video/            camera.ts (CameraCapture: frames encoded with WebCodecs on the microphone's block clock), reader.ts (ClipReader: a clip's pieces decoded in order)
    │       ├── core/             voice.ts (the voice detector), hindsight.ts (the second listen), vad.ts (the live phrase detector), silence.ts (the cuts), recorder.ts (auto / press to speak, the gate, the review queue), denoise.ts (the classic noise filter), fbank.ts, speaker.ts, lips.ts, identity.ts (the voice and lip checks), fillers.ts, stretch.ts, captions.ts, timeline.ts, edit.ts (cut, split, replace, insert; the picture and the drawing follow), clip-video.ts (a phrase's camera picture as pieces of encoded frames), overlay.ts (where the picture sits), ink.ts (the pen: strokes with their times, the live session, the board, slicing, drawing), pcm.ts, yuv.ts, fft.ts, biquad.ts
    │       ├── slides/           PDF (pdf.js) and image rendering, natural sort
    │       ├── storage/          IndexedDB project store (idb), prefs (localStorage), the voice profile
    │       ├── models/           fetch.ts: a model's bytes from the server, the cache storage or its publisher, checked
    │       ├── speaker/          voice-check.ts: the speaker model in its worker, fed each live phrase, compared with the profile
    │       ├── vision/           lips.ts: the camera into the lip worker; segmenter.ts: the selfie segmenter for the camera cleanup
    │       ├── workers/          speaker.worker.ts (onnxruntime-web), lips.worker.ts (MediaPipe Face Landmarker), segmenter.worker.ts
    │       ├── export/           capabilities, prepare (fillers, volume, speed, the audio for the recogniser), encoder (mediabunny; subtitles, drawings and the camera picture drawn in), overlay and ink-track (what is on screen at each moment), camera-clean, sinks (server / file / memory), runner, studio, the real-time fallback
    │       ├── api/              typed client for the server API with SSE and polling
    │       ├── ui/               layout, cam-stage, ink-stage, pen-bar, editor, export dialog, exports list, folder picker, film strip, timeline list, meter, enroll, keyboard, toast, icon
    │       └── styles/           theme.css (Mona Sans, token aliases), grauity.css (grauity components in plain CSS), app.css (layout)
    └── e2e/                  end-to-end runner (no test framework, no dependencies)
        └── src/
            ├── run.ts            boots server + headless Chrome, records in both modes, exports, probes with ffprobe
            ├── stress.ts         talks through the app for minutes or hours, checking phrases, timelines, heap, resume and export
            ├── camera.ts         the camera with a fake device: placement, size, dragging, a picture on every phrase, the export frame, the editor, the reload
            ├── ink.ts            the pen: a drawing that ends a phrase, one the rest ends, undo and clear, the board per slide, the strokes in the export's frames, the preview, the editor, the reload
            ├── studio.ts         the studio and the clip versions: the raw copy in step, the editor's switch, an export with the deep clean, the skip
            ├── harness.ts        shared: server and Chrome start-up, a page over the DevTools Protocol, real key and mouse input
            ├── cdp.ts            minimal Chrome DevTools Protocol client on Node's WebSocket
            └── make-fixtures.ts  writes the PDFs, the PowerPoint deck and the WAVs of speech (macOS text-to-speech) with pauses, typing and clicks
```

Dependencies are few on purpose. Client: `mediabunny` (muxing and WebCodecs), `pdfjs-dist` (PDF rendering), `idb` (IndexedDB), `@newtonschool/grauity` (design tokens and the icon font; only its CSS is bundled), `@workadventure/noise-suppression` (DeepFilterNet3 as WebAssembly in an AudioWorklet), `onnxruntime-web` (runs the speaker model, WebAssembly backend only), `@mediapipe/tasks-vision` (the Face Landmarker and the selfie segmenter). Server: `fastify`, `@fastify/static`, `zod`, `pptxtojson` (reads PowerPoint files), `pdfkit` (draws the PDF). Shared: `zod`.

## Scripts

| Command              | What it does                                                                                                                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm start`          | Everything, then the server: installs the dependencies when `node_modules` is missing or behind the lockfile, builds when a source changed, fetches the models when any is missing, and runs the server (arguments after `--` go to it). |
| `npm run dev`        | Builds `shared` once, then watches it, runs the server with `tsx watch` on 4317, and Vite on 5173 with `/api` proxied.                                                                                                                   |
| `npm run build`      | Builds `shared`, `server` and `client` in order.                                                                                                                                                                                         |
| `npm run typecheck`  | `tsc -b` across all four packages.                                                                                                                                                                                                       |
| `npm run lint`       | ESLint. `npm run lint:fix` fixes what it can.                                                                                                                                                                                            |
| `npm run format`     | Prettier. `npm run format:check` only checks.                                                                                                                                                                                            |
| `npm test`           | Unit tests with Vitest (`npm run test:watch` to keep them running).                                                                                                                                                                      |
| `npm run check`      | Typecheck, lint, format check and unit tests. Run this before you commit.                                                                                                                                                                |
| `npm run e2e`        | Builds, then drives the built app in headless Chrome. See [End-to-end runs](#end-to-end-runs).                                                                                                                                           |
| `npm run e2e:camera` | Builds, then checks the camera with a fake device.                                                                                                                                                                                       |
| `npm run e2e:ink`    | Builds, then checks the pen with real mouse strokes.                                                                                                                                                                                     |
| `npm run e2e:studio` | Builds, then checks the studio and the clip versions. Where this machine has no studio it checks the greyed-out state.                                                                                                                   |
| `npm run e2e:stress` | Builds, then talks through the app in headless Chrome for minutes or hours, checking as it goes. See [The stress run](#the-stress-run).                                                                                                  |
| `npm run doctor`     | The system check and the resource map for a one-hour 1080p lecture, without starting the server.                                                                                                                                         |
| `npm run bench`      | `doctor --bench`: races the H.264 encoders and the decoders on this machine (`--height 2160` for 4K).                                                                                                                                    |
| `npm run models`     | Fetches the speaker model, the face model and the selfie segmenter (29 MB) into `packages/client/public/models`, checking each against its SHA-256. `npm start` does this too.                                                           |
| `npm run studio`     | Makes the studio's Python environment under the server's data folder and fetches its models (about 1.7 GB plus PyTorch). Run once, then restart the server.                                                                              |

## Tooling

- **TypeScript 6**, strict, with `noUncheckedIndexedAccess`, `verbatimModuleSyntax` and `isolatedModules`. Each package is a composite project.
- **ESLint 10** with `typescript-eslint` `strictTypeChecked` and `stylisticTypeChecked`, `eslint-plugin-import-x` ordering (builtin, external, internal, parent, sibling, index, type, alphabetised with blank lines between groups), inline type imports, `eqeqeq`, exhaustive switches, no floating promises.
- **Prettier** with a print width of 110, single quotes and trailing commas.
- **Vitest 5** with three projects. Server tests have a 60 s timeout because some of them run real ffmpeg.
- **Vite 8** for the client, targeting ES2022, with `pdfjs` and `mediabunny` split into their own chunks and the AudioWorklet loaded through `?worker&url`. `sass-embedded` is there only to compile grauity's icon stylesheet.
- **npm 11** blocks dependency install scripts unless `allowScripts` in the root `package.json` approves them. The three that have one (`esbuild`, `unrs-resolver`, `fsevents`) are approved there, pinned to the versions reviewed. After upgrading one of them, run `npm install-scripts ls`, read what changed, and `npm install-scripts approve <pkg>` again. `overrides` keeps `image-size` on the patched 2.x line. `npm install` should finish with `found 0 vulnerabilities` and no warnings; if it does not, `npm audit` names the package.

## Unit tests

```sh
npm test
```

- **shared**: the planner (every branch of what runs where), key-frame alignment, ladders, size and frame estimates for a three-hour lecture, even-size rounding, file name sanitising, formatting, the time-left arithmetic.
- **server**: the ffmpeg argument builder and capability parsing, the job manager (unique names, short uploads, cancel during upload and during ffmpeg, replace rules, faststart remux, HLS and DASH packaging), the library, transcription, the studio worker protocol, and the HTTP app (loopback checks, validation, the SPA fallback, a full export through the API). Tests that need ffmpeg run only when it is installed.
- **client**, the largest set:
  - the voice detector (`test/voice.test.ts`): spoken fixtures clean and with a fan, a humming fan or white noise under the voice; a fan, hiss, typing, a tone, a fan switching on, gain creeping up and silence;
  - the second listen (`test/hindsight.test.ts`): a woman, a man and a 58 Hz deep voice, a sentence that drops 25 dB, a soft sentence on its own, the voices through a fan, nothing in the sounds of a room;
  - the noise filter (`test/denoise.test.ts`), the live phrase detector, the scoring plumbing and the pause remover;
  - the recorder, in auto and press to speak: the gate, the key, splits, mutes, pauses, the pen's gate, and the review queue and its ordering;
  - the timeline builder and the editor's edit functions;
  - the pen (`test/ink.test.ts`): the session's timing, the board, the cuts, the track;
  - the camera's clip arithmetic and the overlay layout;
  - the filterbank against kaldi-native-fbank, the speaker arithmetic and, when the models are fetched, the real speaker model through onnxruntime-web; the lip maths and the verdict table;
  - the filler detector, the time-stretch, the captions and the PCM helpers;
  - a long-session stress simulation (`test/stress.test.ts`).

The stress simulation drives four virtual hours of speaking through the recorder in a few seconds: thousands of phrases, slides going back and forth with hundreds of changes mid-sentence, auto and press to speak alternating, holds with human reaction times, mutes, preview pauses, coughs, discards, a twenty-minute sentence held the whole time, and an hour of random chaos. Every 10 ms block carries its position, so each phrase is checked exactly: consecutive blocks, all heard with the gate open, none shared, on the slide that was showing, no more than the pre-roll in front and the tail behind. The total kept is bounded by the speech fed, and the timeline built from the result is consistent in both orders.

## End-to-end runs

```sh
npm run e2e
# or, without rebuilding:
npx tsx packages/e2e/src/run.ts --out /tmp/one-take-e2e --port 4399 --keep
```

The runners need Chrome, ffmpeg and ffprobe. Set `CHROME` to the path of your Chrome binary if it is not at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. `--keep` leaves the output folder in place for inspection.

The main run (`run.ts`):

1. writes a 4-page PDF and a WAV that imitates speech with thinking pauses,
2. starts the real server on port 4399 with the built client,
3. starts headless Chrome with the WAV as a fake microphone (`--use-file-for-fake-audio-capture`) and drives it over the DevTools Protocol,
4. loads the slides, skips the voice enrollment it is offered at the first mic start, checks that DeepFilterNet3 is the filter running and that the lip check watches the fake camera, records with a slide change mid-sentence, and checks that four phrases exist and one continues across slides,
5. switches to Press to speak and, with real key and mouse events, checks that speech with the key up records nothing, that holding `Space` records exactly one press with a slide change inside it as two joined parts, that the stage button works with the mouse, and that `Space` never changes slides in that mode,
6. exports MP4, HLS by stream copy, DASH with compression, WebM, a compressed HEVC file and an in-memory MP4 saved in the browser, probing each with ffprobe,
7. reloads the page, checks the project resumed, and plays the preview.

The other runs:

- `camera.ts` opens a fake camera, places and resizes the picture with real drags, records phrases with slide changes, checks every phrase carries its picture, exports an MP4 and looks for the picture in a frame, plays the preview and the editor, and reloads.
- `ink.ts` chooses the pen mode and draws with real mouse events. It checks that the pen ends a phrase and shuts the gate, that a voice and the rest each end a drawing, undo and clear, the board on each slide, the preview, the strokes in the exported frames by colour and position, the editor and a split, and the reload.
- `studio.ts` checks the raw copy against the filtered one, the editor's versions, and an export through the studio.

Neither runner can wait forever. Every call into the browser has a deadline (60 s by default, longer for exports) and each script arms a watchdog for the whole run. When either fires, the script prints the stage it was in, the page's console and a last screenshot (`stall.png`), and exits with a failure. Keys are sent as real DevTools input events, except letter keys (`M`, `R`, `Ctrl+Z`): on this Chrome (headless, macOS) one injected letter key turns into thousands of keydown events a second that never stop, so those are dispatched as `KeyboardEvent`s inside the page, which reach the app's handler the same way. Run the scripts with their output unpiped (not through `tail`), or the progress lines only appear at the end.

The app exposes `window.__onetake` with the store, the detector, the recorder, `setMode`, `hold`, slide loading, navigation, deletion, undo, `exportWith(overrides, inMemory)`, the camera, the pen (`penDown`, `penMove`, `penUp`, `setPen`, `undoStroke`, `clearSlide`), `setRecordMode`, and the checks (`voiceCheck`, `lips`, `enroll`, `setProfile`, `setNoiseFilter`, `setCamera`), so you can script the same checks from the DevTools console.

## The stress run

```sh
npm run e2e:stress                                   # builds, then two minutes
npx tsx packages/e2e/src/stress.ts --minutes 30
npx tsx packages/e2e/src/stress.ts --hours 3 --out /tmp/one-take-stress --no-export
```

The stress runner plays a generated voice as the microphone (bursts of half a second to five seconds at varying loudness, thinking pauses, the odd click) through a twelve-slide deck. It first checks the two modes deterministically. Then it runs a seeded random session: slide moves with real key presses and film-strip jumps, mode switches, presses with slide changes inside them, `Backspace` and `Ctrl+Z`, mutes, mic restarts with `R`, and (with `--preview`) previews stopped with `Esc`. Once a minute it checks every phrase and both timelines, and logs phrases, seconds recorded, PCM bytes and the V8 heap. At the end it stops the mic, checks the detector is idle and that pauses really were removed, reloads, resumes, previews, exports the whole session to MP4 and checks the file's duration against the timeline. `--seed` replays a run, `--no-export` skips the final export for very long runs, and `--verbose` prints every action with its time.

**A known limitation of the headless run.** Previews in the middle of the random session are opt-in (`--preview`). In this headless Chrome with the fake microphone, once a preview has played, a later mic stop wedges the browser's audio stack after about a minute: every call the app makes completes, but the page then stops answering inside native code. The same action list without previews passes, and so does the preview at the end of the run. It has not been reproduced with a real microphone.

## Browser support

| Browser                 | Recording | Export with the server                       | Export in the browser                                                                |
| ----------------------- | --------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| Chrome, Edge (desktop)  | Yes       | Yes, full speed                              | Yes, streamed to disk through a save dialog                                          |
| Other Chromium browsers | Yes       | Yes, full speed                              | Usually the same as Chrome                                                           |
| Safari, Firefox         | Yes       | Depends on WebCodecs support in that version | In memory, up to about 2 GB, then downloaded. Without WebCodecs, real-time WebM only. |

Recording the camera needs WebCodecs and either `MediaStreamTrackProcessor` or `requestVideoFrameCallback`. Chrome and Edge have both; elsewhere the **Voice + camera** option is greyed out with the reason, and the pen still works over the slides alone. The lip check needs Chrome or Edge too; elsewhere the voice check decides alone. The deep noise filter needs AudioWorklet; the ScriptProcessor fallback gets the classic filter.

The export dialog tells you what your browser can encode. Codec availability also depends on the operating system: H.265 and AV1 encoding, for example, are often only available with hardware support.

## Design system

The interface is built on [grauity](https://github.com/Newton-School/grauity), Newton School's design system (`@newtonschool/grauity` on npm), and carries the Newton School mark.

- **Colours, spacing, radii and type** come from grauity's token stylesheet, which defines the primitives (`--brand-500`, `--neutral-900`, `--spacing-8px`, …) and the semantic tokens (`--bg-subtle-primary-default`, `--text-emphasis-brand-default`, …) for a light and a dark theme. The class on `<html>` (`grauity-theme-dark` or `grauity-theme-light`) picks the theme. `packages/client/src/styles/theme.css` gives the tokens the app uses most a short name (`--panel`, `--accent`, `--rec`, `--ok`, …) so the layout stylesheet reads plainly.
- **Components.** grauity ships React components, which this framework-free app cannot mount, so `packages/client/src/styles/grauity.css` carries the same recipes in plain CSS: the button variants and sizes, status pills, chips, the dialog and its overlay, the slider, text fields and selects, alerts and the progress bar. The class names are the app's own, the colours and measurements are grauity's.
- **Icons** are grauity's icon font, compiled by Vite with `sass-embedded`. `packages/client/src/ui/icon.ts` lists the names the app uses.
- **The Newton School mark** in the top bar, the welcome tour and the browser tab is the outline of that font's `nst` glyph.
- **Mona Sans**, grauity's typeface, is bundled in `packages/client/public/fonts/` so the app never fetches a font from the network.
- **The stage and the level meter stay dark in both themes.** Slides are projected on black, and the meter is an instrument whose white speech line should stay white.

To restyle, change the aliases in `theme.css` or upgrade `@newtonschool/grauity`. The app has no colour values of its own apart from the black stage and the pen's colours.
