# One Take

Turn a slide deck plus your voice into a lecture video, without ever pressing pause.

Load your slides, start the mic and talk. Only the moments you speak are kept. When you stop to think, nothing is recorded; when you speak again it is appended right after the last phrase, so the finished video sounds like one continuous take. Move through the slides whenever you like; the video follows your navigation.

Everything runs on your own computer: the browser records and encodes, and a small local server saves the result into any folder you choose and packages it with ffmpeg.

## What you get

- **Any container**: MP4, fragmented MP4, QuickTime MOV, Matroska MKV, WebM, HLS (`index.m3u8` + segments) and MPEG-DASH (`manifest.mpd` + segments).
- **Any quality**: resolution presets from 360p to 4K or a custom size, frame rate from 1 to 120 fps, quality levels or an exact bitrate, H.264 / H.265 / VP9 / AV1, AAC or Opus audio, key-frame spacing.
- **Compression** on the server with ffmpeg: CRF quality target, x264/x265 presets, the `stillimage` tune for slides, output frame rate, scaling, bitrate caps, hardware encoders when present.
- **Adaptive streaming**: HLS or DASH ladders (1080p/720p/480p/360p) with a master playlist.
- **Save anywhere**: a folder picker browses the computer running the server; files never leave the machine.
- **Built for long lectures**: streaming writes, encoder back-pressure, free-space checks, crash-safe fragments, cancel at any stage, no in-memory assembly (see [Large exports](#large-exports)).
- **Nothing lost**: every phrase is saved to IndexedDB the moment it ends. Close the tab and resume later.

## Quick start

Requirements: Node 22 or newer, Chrome or Edge, and [ffmpeg](https://ffmpeg.org) on the `PATH` for HLS, DASH, compression and faststart MP4 (everything else works without it).

```sh
npm install
npm run build
npm start          # http://127.0.0.1:4317
```

Open the address in Chrome, load a PDF, a PowerPoint file (`.pptx`, `.ppsx`, `.pptm`) or a set of images, click **Start mic** and talk. Keynote and Google Slides: export as PDF or `.pptx` first.

Server options: `npm start -- --port 4317 --dir ~/Movies/One\ Take --ffmpeg /opt/homebrew/bin/ffmpeg --fonts ~/Fonts/MonaSans`. Environment variables `ONE_TAKE_PORT`, `ONE_TAKE_DIR`, `FFMPEG_PATH`, `FFPROBE_PATH`, `ONE_TAKE_FONTS` and `ONE_TAKE_LOG_LEVEL` do the same. The server answers only requests addressed to localhost; pass `--allow-remote` to change that on a trusted network.

### PowerPoint files

A `.pptx` dropped on the page goes to the local server, which turns it into a PDF with plain JavaScript ([pptxtojson](https://github.com/pipipi-pikachu/pptxtojson) reads the deck, [pdfkit](https://pdfkit.org) draws it) and sends the PDF back; the browser then renders it like any other PDF. Nothing else has to be installed and no application opens. Text keeps its font, size, colour, bold/italic, bullets, alignment and spacing; shapes, pictures (PNG and JPEG), tables, simple bar, line and pie charts, groups and slide backgrounds are drawn where the deck put them. Things PDF drawing cannot do faithfully (3-D effects, soft shadows, embedded video, SmartArt animation, GIF or SVG pictures) are approximated or skipped, and the app shows how many such notes the renderer made; the details are in the browser console.

Fonts come from the system font folders (plus Office's bundled fonts on a Mac). A font the deck uses but the machine does not have is replaced by a stand-in with the same weight and style, which changes line breaks slightly. Put the font files in a folder and pass it with `--fonts` (several folders separated by `:`) to use the real thing. Rendering happens in a worker thread, so exports keep streaming progress while a deck converts.

## How to use it

1. **Load slides.** A PDF or a PowerPoint file; images are ordered by file name.
2. **Start mic.** The level meter shows your voice against the white *speech line*. Your voice should go clearly past it; room noise should stay under it. Adjust *Speech threshold* if not.
3. **Talk.** While you speak a red *RECORDING* flag shows and the phrase grows in the timeline. Pause as long as you like.
4. **Change slides** with `→` `←`, `PageDown` `PageUp`, `Space`, a presenter clicker, or by clicking a thumbnail. Changing slides mid-sentence keeps the sentence intact across both slides.
5. **Fix a flub:** `Backspace` removes the phrase you are saying (or the last finished one). `Cmd/Ctrl+Z` brings a removed phrase back.
6. **Preview** plays the lecture with the slides switching at the right moments. `▶` on a phrase plays from there, `✕` deletes it, drag to reorder.
7. **Export video.** Pick a destination, container and quality. The dialog shows the two-stage plan (what the browser encodes, what the server does afterwards), an estimate of the size, and any reason the export cannot run. Progress covers encoding, upload and ffmpeg, and can be cancelled at any point.

Keys: `→` `←` slides · `Home` `End` first/last slide · `Backspace` undo last phrase · `M` mute · `R` mic on/off · `Esc` stop preview.

## How an export works

1. **The browser encodes** the timeline with WebCodecs through [mediabunny](https://github.com/Vanilagy/mediabunny): slides are drawn on a canvas at the chosen size and frame rate, audio is joined with short fades and resampled to 48 kHz, and the muxer writes the container in positioned chunks. A key frame is forced on every slide change.
2. **The server receives** those chunks (`PUT /api/exports/:id/data?offset=`), writes them at their byte offset (so a re-sent chunk is harmless) and, once the upload is complete, either moves the file into place or runs ffmpeg:
   - **MP4** is uploaded as crash-safe fragments and remuxed with `+faststart` (no re-encode).
   - **HLS / DASH** are packaged by copying the streams into segments; key frames are aligned to the segment length so segments are exact.
   - **Compression** re-encodes with CRF; the browser first encodes at a high "mezzanine" quality so nothing is lost twice.
   - **WebM** is written by the browser directly (VP9 + Opus) when it can, otherwise ffmpeg transcodes.

The planner (`packages/shared/src/plan.ts`) is a pure function, so the dialog can show the exact pipeline, and the same decisions are unit-tested.

Saving in the browser (no server) uses the File System Access API to stream to a file in Chrome and Edge; other browsers assemble the file in memory (keep those under 2 GB) and download it. Browsers without WebCodecs get a real-time WebM recording as a fallback.

## Large exports

A three-hour lecture is the normal case, so the pipeline is built around it:

- **No in-memory assembly.** The muxer streams 4 MB chunks to the server or straight to disk; memory use does not grow with the video length.
- **Back-pressure everywhere.** Every encoded frame and audio chunk awaits the encoder queue; every chunk awaits the upload. Nothing piles up.
- **Exact timestamps.** Frame and sample timestamps come from integer counters, not accumulated floats, so hours of video stay in sync.
- **Free-space check** before anything starts, counting the temporary copy ffmpeg needs. Files over 4 GB are fine (64-bit box sizes).
- **Crash-safe fragments.** The upload is a fragmented MP4, so an interrupted export still leaves a playable file on the server side.
- **Retries.** A dropped connection retries the chunk with back-off; positioned writes make duplicates harmless.
- **Cancel** stops the encoder, aborts the upload, kills ffmpeg and removes partial files. A failed job cleans up too.
- **Screen stays awake** during an export (Wake Lock), and closing the tab asks for confirmation.
- **Collisions** never overwrite: `lecture (2).mp4` unless you tick *replace*. Folders are replaced only when they contain nothing but a previous One Take export.
- **Slides** are rasterised once (up to 2560×1440), cached as bitmaps during the export, and re-used; decks with hundreds of pages are fine.
- **Audio from different microphones** (different sample rates) is resampled to one rate.

Tips: slides are still images, so 10–15 fps looks identical to 30 and exports faster. For the smallest files turn on *Compress* with x264 `stillimage` and CRF 26–30.

## Project layout

```
packages/shared   types, zod schemas for the API, container/codec catalog, presets, the export planner
packages/server   Fastify server: job manager, chunk uploads, ffmpeg detection and command builder, SSE progress, folder browsing,
                  PowerPoint-to-PDF renderer (services/pptx: text html → paragraphs, line layout, font lookup, pdfkit drawing, worker thread)
packages/client   Vite + TypeScript app: AudioWorklet capture, energy VAD, timeline, preview, WebCodecs export, UI
packages/e2e      end-to-end runner: real server, headless Chrome with a synthetic microphone, ffprobe checks
```

API (all JSON unless noted): `GET /api/capabilities`, `GET /api/fs/list?path=`, `POST /api/fs/mkdir`, `POST /api/convert?name=deck.pptx` (octet-stream in, `application/pdf` out, notes in the `x-one-take-warnings` header), `POST /api/exports`, `PUT /api/exports/:id/data?offset=` (octet-stream), `POST /api/exports/:id/finish`, `GET /api/exports/:id/events` (server-sent events), `DELETE /api/exports/:id`, `POST /api/exports/:id/reveal`.

## Development

```sh
npm run dev        # shared (tsc --watch) + server (tsx watch, :4317) + client (vite, :5173 with /api proxied)
npm run check      # typecheck + lint + format check + unit tests
npm test           # vitest: shared, server (incl. real ffmpeg jobs when installed), client core
npm run e2e        # builds, then drives the built app in headless Chrome (needs Chrome, ffmpeg, ffprobe)
npm run lint:fix && npm run format
```

Tooling: TypeScript 6 (strict, `noUncheckedIndexedAccess`), ESLint 10 with typescript-eslint `strictTypeChecked` + `stylisticTypeChecked` and import ordering, Prettier, Vitest, Vite 8, npm workspaces with project references.

## What counts as speech

The detector listens in 10 ms blocks and compares the level with the speech line (your threshold, raised automatically if the room is noisy).

- A phrase starts after 30 ms above the line; 200 ms from before that moment is kept so the first syllable is never clipped.
- A phrase ends after *Phrase ends after* (default 0.7 s) of silence. Shorter pauses stay in the recording.
- Of the trailing silence only 150 ms is kept. Phrases are joined with *Pause between phrases* (default 0.15 s), plus 0.25 s on a slide change.
- Bursts shorter than 200 ms (a click, a cough) are dropped.

A headset or USB microphone gives the cleanest cut. Mute (`M`) when you need to talk to someone in the room.
