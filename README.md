# One Take

Turn a slide deck plus your voice into a lecture video, without ever pressing pause.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node 22+](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6.svg)

Load your slides, start the mic and talk. Only the moments you speak are kept. When you stop to think, nothing is recorded. When you speak again, the new phrase is appended right after the last one, so the finished video sounds like one continuous take. Move through the slides whenever you like and the video follows you.

Everything runs on your own computer. The browser records and encodes, and a small local server saves the result into any folder you choose and packages it with ffmpeg. Nothing leaves your machine.

## Contents

- [What you get](#what-you-get)
- [What you need](#what-you-need)
- [Quick start](#quick-start)
- [How to use it](#how-to-use-it)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Output formats](#output-formats)
- [Quality and encoding settings](#quality-and-encoding-settings)
- [How an export works](#how-an-export-works)
- [Large exports](#large-exports)
- [System check and performance mode](#system-check-and-performance-mode)
- [What counts as speech](#what-counts-as-speech)
- [Saving your work and resuming](#saving-your-work-and-resuming)
- [Design system](#design-system)
- [The server](#the-server)
- [HTTP API](#http-api)
- [Project layout](#project-layout)
- [Development](#development)
- [Browser support](#browser-support)
- [Troubleshooting](#troubleshooting)
- [Privacy](#privacy)
- [License](#license)

## What you get

- **Pauses cut automatically.** A voice detector listens in 10 ms blocks. A phrase starts when you speak and ends when you've been quiet for a moment. The gaps in between never make it into the video.
- **PDF, PowerPoint or images.** Drop a PDF, a `.pptx` / `.ppsx` / `.pptm` deck or a set of images. PowerPoint files are turned into PDF on the local server in plain JavaScript; no Office, Keynote or LibreOffice needed.
- **Slides follow your navigation.** Change slides with the arrow keys, a presenter clicker, or a click on a thumbnail. If you change slides mid-sentence, the sentence stays intact across both slides.
- **Any container.** MP4, fragmented MP4, QuickTime MOV, Matroska MKV, WebM, HLS (`index.m3u8` plus segments) and MPEG-DASH (`manifest.mpd` plus segments).
- **Any quality.** Resolution presets from 360p to 4K or a custom size, frame rate from 1 to 120 fps, four quality levels or an exact bitrate, H.264 / H.265 / VP9 / AV1 video, AAC or Opus audio, and key-frame spacing.
- **Compression on the server.** ffmpeg re-encodes with a CRF quality target, x264 / x265 speed presets, the `stillimage` tune for slides, a different output frame rate, scaling, a bitrate cap, and hardware encoders when your machine has them.
- **Adaptive streaming.** HLS or DASH ladders (1080p / 720p / 480p / 360p) with a master playlist.
- **Save anywhere.** A folder picker browses the computer running the server. Files never leave the machine.
- **Built for long lectures.** Streaming writes, encoder back-pressure, free-space checks, crash-safe fragments, cancel at any stage, and no in-memory assembly. See [Large exports](#large-exports).
- **Knows your machine.** A start-up system check (CPU, memory, GPU, disk, ffmpeg hardware encoders, each one self-tested) and measured encoder races pick the fastest path. A *Fastest / Balanced / Smallest file* performance mode and a resource map show what each export stage will cost.
- **Nothing lost.** Every phrase is saved to IndexedDB the moment it ends. Close the tab and come back later. The slides, the phrases and your settings are all still there.
- **Works without the server too.** In Chrome and Edge the browser can stream the file straight to disk. Other browsers assemble it in memory and download it.

## What you need

| What                       | Why                                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js 22 or newer        | Runs the local save server and the build. The repo's `.nvmrc` pins Node 24.                                                                                                 |
| Chrome or Edge             | The full experience: WebCodecs for fast encoding, the File System Access API for streaming to disk, AudioWorklet for the mic. See [Browser support](#browser-support).      |
| ffmpeg (optional)          | HLS, DASH, compression, the faststart MP4 remux and transcoding. Without it you still get MP4, MOV, MKV and WebM written directly by the browser.                           |
| ffprobe (optional)         | Only the end-to-end test needs it.                                                                                                                                          |
| A microphone               | A headset or USB microphone gives the cleanest cut. The built-in laptop mic works too; you may need to raise the speech threshold.                                         |

Install ffmpeg with your package manager:

```sh
brew install ffmpeg            # macOS
sudo apt install ffmpeg        # Debian / Ubuntu
winget install Gyan.FFmpeg     # Windows
```

The server looks for `ffmpeg` on your `PATH` and in the usual places (`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `C:\ffmpeg\bin`, `C:\Program Files\ffmpeg\bin`). You can also point it at a binary with `--ffmpeg`.

## Quick start

```sh
git clone https://github.com/mishrsoumitra/one-take.git
cd one-take
npm install
npm run build
npm start          # http://127.0.0.1:4317
```

Open the address in Chrome, load a PDF, a PowerPoint file (`.pptx`, `.ppsx`, `.pptm`) or a set of images, click **Start mic** and talk. Keynote and Google Slides: export as PDF or `.pptx` first.

Server options, if you need them:

```sh
npm start -- --port 4317 --dir ~/Movies/One\ Take --ffmpeg /opt/homebrew/bin/ffmpeg --fonts ~/Fonts/MonaSans
```

The full list is under [The server](#the-server). `npm run doctor` checks the machine without starting the server (see [System check and performance mode](#system-check-and-performance-mode)).

For development, `npm run dev` starts the server on port 4317 and a Vite dev server on port 5173 with hot reload. Open http://localhost:5173; API calls are proxied to the server.

### PowerPoint files

A `.pptx` dropped on the page goes to the local server, which turns it into a PDF with plain JavaScript ([pptxtojson](https://github.com/pipipi-pikachu/pptxtojson) reads the deck, [pdfkit](https://pdfkit.org) draws it) and sends the PDF back; the browser then renders it like any other PDF. Nothing else has to be installed and no application opens. Text keeps its font, size, colour, bold/italic, bullets, alignment and spacing; shapes, pictures (PNG and JPEG), tables, simple bar, line and pie charts, groups and slide backgrounds are drawn where the deck put them. Things PDF drawing cannot do faithfully (3-D effects, soft shadows, embedded video, SmartArt animation, GIF or SVG pictures) are approximated or skipped, and the app shows how many such notes the renderer made; the details are in the browser console.

Fonts come from the system font folders (plus Office's bundled fonts on a Mac). A font the deck uses but the machine does not have is replaced by a stand-in with the same weight and style, which changes line breaks slightly. Put the font files in a folder and pass it with `--fonts` (several folders separated by `:`) to use the real thing. Rendering happens in a worker thread, so exports keep streaming progress while a deck converts.

## How to use it

The first time you open the app, a short welcome tour lists the three steps: load slides, start the mic and talk, preview and export. Click **Help** in the top bar to see it again at any time. The top bar shows the same three steps as numbered badges: the next thing to do is blue, finished steps get a green tick. While you work, a tip at the bottom of the stage says what to do next; close it with its ✕ (or untick *Show tips while I work* in the tour) if you don't need it. The app opens in a dark theme; the sun / moon button at the right of the top bar switches to the light one and back, and the choice is remembered.

### 1. Load your slides

Drop a PDF or a PowerPoint file (`.pptx`, `.ppsx`, `.pptm`) anywhere on the page, or click **Load slides** (or **Choose a file…** on the empty stage) and pick one. Every page becomes one slide. A PowerPoint file goes through the local server first (see [PowerPoint files](#powerpoint-files)); Keynote and Google Slides decks should be exported as PDF or `.pptx`. You can also pick a set of PNG or JPG images; they are ordered by file name, with numbers sorted naturally (`slide2` comes before `slide10`). If a PDF and images are selected together, the PDF wins.

Slides are rasterised once, at up to 2560×1440, and kept as JPEGs. Decks with hundreds of pages are fine.

### 2. Start the mic and find your speech line

Click **Start mic**. Chrome asks for microphone permission the first time. Pick a different microphone from the **Microphone** list if you have more than one.

The **Mic level** meter shows your voice against a white line, the *speech line*. Your voice should go clearly past it, and room noise should stay under it. If not, move the **Speech line** slider until it does. The line also rises by itself when the room gets noisy, so a fan or an air conditioner won't trigger a phrase.

### 3. Talk, pause, talk again

While you speak, a red **RECORDING** flag shows and the phrase grows in the timeline. Pause as long as you like; nothing is recorded while you're quiet. When you speak again, the new phrase is placed right after the last one with a short gap. The total recorded time is shown at the top.

Press `M` to mute while you talk to someone in the room. Press `R` or **Stop** to turn the mic off.

### 4. Move through the slides

Use `→` and `←`, `PageDown` and `PageUp`, `Space`, a presenter clicker, or click a thumbnail in the film strip. Each thumbnail shows how many seconds you've recorded on that slide.

If you change slides while speaking, the sentence is split at that moment and continues on the new slide without a gap or a fade. In the video the slide changes exactly where you pressed the key.

### 5. Fix a mistake

- `Backspace` or `Delete` removes the phrase you're saying right now, or the last finished one if you're quiet.
- `Cmd/Ctrl+Z` brings a removed phrase back.
- `✕` on any phrase in the timeline deletes it.

### 6. Preview and reorder

**Preview** plays the lecture with the slides switching at the right moments. `▶` on a phrase plays from there. Drag phrases to reorder them. Press `Esc` to stop.

### 7. Export the video

Click **Export video**. In the dialog you choose:

- **Save to**: a folder on this computer (through the server) or **Save in browser**.
- **File name**, **Container**, **Resolution**, **Frame rate**, **Quality**, **Video codec**, **Audio** codec and bitrate, **Key frame every**, and **Order**.
- **Compression (server, ffmpeg)** and, for HLS and DASH, **Segment length**, **Segment type** and **Adaptive bitrate**.

The **Plan** panel shows the two stages (what the browser encodes, what the server does afterwards), an estimate of the upload size and the final size, warnings, and any reason the export cannot run. Progress covers encoding, upload and ffmpeg, and you can cancel at any point. When it's done, **Show in folder** opens Finder or Explorer at the file.

To start a new lecture, click **New**. It discards the slides and all phrases.

## Keyboard shortcuts

| Keys                                   | What happens                                             |
| -------------------------------------- | -------------------------------------------------------- |
| `→` `PageDown` `Space` `Enter` `↓`     | Next slide                                               |
| `←` `PageUp` `↑`                       | Previous slide                                           |
| `Home` / `End`                         | First / last slide                                       |
| `Backspace` / `Delete`                 | Remove the phrase being spoken, or the last finished one |
| `Cmd/Ctrl+Z`                           | Bring back the last removed phrase                       |
| `M`                                    | Mute / unmute                                            |
| `R`                                    | Mic on / off                                             |
| `Esc`                                  | Stop the preview                                         |

Shortcuts are ignored while you type in a field or while a dialog is open. Most presenter clickers send `PageDown` and `PageUp`, so they work out of the box.

## Output formats

| Container                    | Extension | Video codecs            | Audio codecs | Needs ffmpeg | Notes                                                                                         |
| ---------------------------- | --------- | ----------------------- | ------------ | ------------ | --------------------------------------------------------------------------------------------- |
| MP4                          | `.mp4`    | H.264, H.265, AV1, VP9  | AAC, Opus    | No\*         | Plays everywhere. With ffmpeg the index is moved to the front so it plays while downloading.  |
| Fragmented MP4               | `.mp4`    | H.264, H.265, AV1, VP9  | AAC, Opus    | No           | Written in small fragments. If the export is interrupted, what was written stays playable.    |
| QuickTime MOV                | `.mov`    | H.264, H.265            | AAC          | No           | For Final Cut, iMovie and other Apple tools.                                                  |
| Matroska MKV                 | `.mkv`    | H.264, H.265, VP9, AV1  | AAC, Opus    | No           | Holds any codec. Good for archiving; not every player supports it.                            |
| WebM                         | `.webm`   | VP9, AV1                | Opus         | No\*\*       | Royalty-free. Plays in browsers; smaller files for the same quality.                          |
| HLS                          | `.m3u8`   | H.264, H.265            | AAC          | Yes          | A folder with `index.m3u8` and short segments for a web player or a streaming server.         |
| MPEG-DASH                    | `.mpd`    | H.264, H.265, VP9, AV1  | AAC, Opus    | Yes          | A folder with `manifest.mpd` and segments for dash.js, Shaka Player or a CDN.                 |

\* Without ffmpeg the server stores the browser's file as is. With ffmpeg it is uploaded as crash-safe fragments and remuxed with `+faststart` (no re-encode).

\*\* The browser writes WebM directly when it can encode VP9 or AV1 with Opus. Otherwise the server transcodes it with ffmpeg.

Which codecs you actually get depends on what your browser can encode with WebCodecs; the export dialog lists them. **Automatic** picks the first one the container allows and the browser supports: H.264, then H.265, then AV1, then VP9 for the MP4 family; VP9, then AV1 for WebM.

## Quality and encoding settings

### Resolution

| Preset | Size      |
| ------ | --------- |
| 2160p  | 3840×2160 |
| 1440p  | 2560×1440 |
| 1080p  | 1920×1080 |
| 720p   | 1280×720  |
| 480p   | 854×480   |
| 360p   | 640×360   |

**Custom size…** takes any width and height from 16 to 7680. Odd numbers are rounded down to even, because H.264 and H.265 need that. Slides are drawn centred on a black canvas at the chosen size, keeping their aspect ratio. Above 4K the plan warns you that many hardware encoders refuse to run.

### Frame rate

The list offers 1, 2, 5, 10, 12, 15, 24, 25, 30, 50 and 60 fps, and **Custom…** accepts 1 to 120. Slides are still images, so 10 to 15 fps looks identical to 30 and exports faster with smaller files. The default is 15.

### Video quality

Four levels, defined as a bitrate at 1080p30 and scaled to your size and frame rate (pixel count linearly, frame rate by its square root). These are upper bounds; static slides compress far below them.

| Level                       | At 1080p30  |
| --------------------------- | ----------- |
| Low · smallest file         | 1200 kbit/s |
| Medium · good for slides    | 2500 kbit/s |
| High · crisp text (default) | 5000 kbit/s |
| Very high · near lossless   | 10000 kbit/s|

**Custom bitrate…** takes 100 to 200 000 kbit/s.

### Audio

AAC or Opus (or **Automatic**), at 48, 64, 96, 128 or 192 kbit/s. The default is 96 kbit/s, which is plenty for a single voice. Audio is mono, resampled to 48 kHz, and phrases are joined with short fades.

### Key frames

**Key frame every** 0.5 to 60 s (default 4 s). Smaller values seek faster and make bigger files. A key frame is also forced on every slide change, so scrubbing lands on a clean slide. For HLS and DASH the interval is adjusted to divide the segment length evenly, so segments are exactly as long as you asked.

### Compression (server, ffmpeg)

Turn on **Compress** to have the server re-encode the video with ffmpeg. The browser then encodes at a high "mezzanine" quality first, so nothing is lost twice.

| Setting               | Choices                                                         | Notes                                                                                       |
| --------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Codec                 | H.264, H.265, VP9, AV1                                          | H.264 and H.265 go into MP4, MOV, MKV, HLS and DASH. VP9 and AV1 go into MP4, MKV, WebM and DASH. |
| Quality (CRF)         | H.264 0–51 (default 23), H.265 0–51 (28), VP9 0–63 (32), AV1 0–63 (35) | Lower is better quality and a bigger file. For slides, 26–30 with H.264 is still crisp.  |
| Speed preset          | ultrafast, veryfast, fast, medium, slow, slower, veryslow       | Slower presets squeeze out a smaller file for the same quality. Mapped onto the equivalent for VP9, SVT-AV1, libaom and NVENC. |
| Tune                  | none, stillimage                                                | `stillimage` is applied with x264 only. It suits slides well.                               |
| Output frame rate     | 1–120 or empty                                                  | Change the frame rate while re-encoding. Empty keeps the recorded rate.                     |
| Max bitrate           | 100–200 000 kbit/s or empty                                     | Caps the bitrate (with a buffer of twice that) for streaming-friendly output.               |
| Scale to height       | 16–7680 or empty                                                | Scales while re-encoding, keeping the aspect ratio.                                         |
| Hardware encoder      | on / off                                                        | Prefers VideoToolbox, NVENC, QSV or VAAPI when ffmpeg has them. Faster, but larger files than x264/x265 at the same quality. Falls back to software with a warning. |

The ffmpeg command that ran is kept on the job (`command` in the API) so you can see exactly what happened.

### Streaming (HLS and DASH)

| Setting            | Choices                 | Notes                                                                                                        |
| ------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| Segment length     | 2, 4, 6 or 10 s (default 4) | Key frames are aligned so each segment is exactly this long.                                             |
| Segment type (HLS) | fMP4 (default), MPEG-TS | MPEG-TS has the widest player support but needs AAC audio.                                                   |
| Adaptive bitrate   | on / off                | Produces several renditions and a master playlist instead of one stream. Always re-encodes.                  |

The adaptive ladder uses every rung at or below your source height:

| Rung  | Video       | Audio      |
| ----- | ----------- | ---------- |
| 1080p | 4500 kbit/s | 128 kbit/s |
| 720p  | 2500 kbit/s | 96 kbit/s  |
| 480p  | 1200 kbit/s | 64 kbit/s  |
| 360p  | 700 kbit/s  | 48 kbit/s  |

HLS writes `master.m3u8` with one folder per rendition (for example `720p/index.m3u8` and `720p/seg_00001.m4s`). Single-rendition HLS writes `index.m3u8`, `init.mp4` (fMP4) and `seg_00001.m4s` or `seg_00001.ts`. DASH writes `manifest.mpd`, `init-0.m4s` style init segments and `chunk-0-00001.m4s` style media segments with a timeline and template.

### Phrase order

**As recorded (slides may repeat)** keeps the order you spoke in, so if you went back to slide 3 later, slide 3 appears twice. **Grouped by slide number** sorts phrases by slide, keeping the spoken order within each slide. Phrases are joined with **Pause between phrases** (default 0.15 s), plus 0.25 s on every slide change.

## How an export works

### Stage 1: the browser encodes

The browser renders the timeline with WebCodecs through [mediabunny](https://github.com/Vanilagy/mediabunny), faster than real time:

1. Slides are drawn on a canvas at the chosen size and frame rate. Up to eight slide bitmaps are cached so going back and forth is cheap.
2. Audio is joined with short fades, resampled to 48 kHz, and fed to the encoder in 100 ms chunks.
3. The muxer writes the container as positioned 4 MB chunks to wherever the file is going: the server, a file on disk, or memory.
4. Every encoded frame and every audio chunk awaits the encoder's queue, so memory stays flat however long the lecture is.
5. Frame and sample timestamps come from integer counters, not accumulated floats, so hours of video stay in sync.

The last slide stays on screen for 0.25 s after the last word.

### Stage 2: the server packages or re-encodes

When you save to a folder, the server receives the chunks (`PUT /api/exports/:id/data?offset=`) and writes each one at its byte offset, so a re-sent chunk is harmless. When the upload is complete it does one of these:

- **Move** the file into place (fMP4, MOV, MKV, WebM, or MP4 without ffmpeg).
- **Remux** an MP4 with `+faststart` so the index sits at the front. No re-encode.
- **Package** HLS or DASH by copying the streams into segments.
- **Re-encode** with CRF for compression, adaptive ladders, or when the browser could not produce the container's codecs.

The browser follows the job over server-sent events and falls back to polling if the stream drops.

### What runs where

The planner in `packages/shared/src/plan.ts` is a pure function. The export dialog calls it to show the plan before anything runs, and the same decisions are unit-tested.

| You ask for                                                      | The browser writes                          | The server does                                     |
| ---------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------- |
| MP4 to a folder, ffmpeg present                                  | Fragmented MP4                              | Remuxes to MP4 with faststart (stream copy)         |
| MP4 to a folder, no ffmpeg                                       | MP4                                         | Moves it into place                                 |
| Fragmented MP4, MOV, MKV or WebM to a folder                     | That container                              | Moves it into place                                 |
| Any single-file container, saved in the browser                  | That container, straight to disk or memory  | Nothing                                             |
| WebM to a folder, browser cannot encode VP9/AV1 with Opus        | Fragmented MP4 mezzanine                    | Transcodes to VP9 + Opus (warned in the plan)       |
| HLS or DASH, no compression, no ladder                           | Fragmented MP4 with key frames aligned to the segment length | Copies the streams into segments   |
| HLS or DASH with adaptive bitrate                                | High-quality fragmented MP4 mezzanine       | Re-encodes every rung and writes the master playlist|
| Anything with Compress on                                        | High-quality fragmented MP4 mezzanine       | Re-encodes with CRF and your settings               |

A mezzanine is encoded at the higher of your chosen bitrate and the "very high" level, with audio at no less than 128 kbit/s.

### Saving in the browser without the server

Choose **Save in browser**. In Chrome and Edge the File System Access API streams the file to a location you pick in a save dialog, so size is not a concern. Other browsers assemble the file in memory and download it; keep those exports under about 2 GB. The plan warns you which case you're in.

Browsers without WebCodecs get a different path: **Record in real time (WebM)** plays the lecture into a MediaRecorder. It takes as long as the lecture and produces WebM only, but it works wherever the microphone works.

### Estimates and blockers

Before an export starts, the dialog shows an estimate of the upload size, the final size and the number of frames. On the server the free space in the destination is checked against the estimate, doubled when ffmpeg will need a temporary copy. The plan also lists blockers, such as a missing server, a missing ffmpeg, an ffmpeg without the right encoder or muxer, or a codec the browser cannot produce. An export with blockers cannot start.

## System check and performance mode

Video work is heavy, so the app looks at the machine before it does any. The server runs a pre-flight check at start-up, and the export dialog turns the result into a mode and a resource map.

**At start-up** (`npm start`) the server prints what it found and serves it at `GET /api/system`:

```
One Take 1.0.0: system check
  CPU      Apple M2 Max, 12 cores (8 performance, 4 efficiency), arm64
  Memory   96 GB total, 69 GB available now
  GPU      Apple M2 Max, 38 cores, shared memory
  Disk     412 GB free in /Users/me/Movies/One Take
  ffmpeg   8.1.2 at /opt/homebrew/bin/ffmpeg
           hardware encoders: h264_videotoolbox, hevc_videotoolbox
           fastest for slides at 1080p: libx264 (libx264 910 fps, h264_videotoolbox 400 fps); decoding in software; hwaccels listed: videotoolbox
  Node     v24.14.0
  Mode     gpu: GPU encoding available; up to 2 ffmpeg re-encodes at a time
  Renderer 32.0 GB heap for PowerPoint conversion
```

- CPU model, core count and the performance/efficiency split (Apple silicon), total and available memory, the GPU (`system_profiler` on macOS, `nvidia-smi`/`lspci` on Linux, PowerShell on Windows) and free disk space where exports go.
- Every hardware encoder ffmpeg lists (`*_videotoolbox`, `*_nvenc`, `*_qsv`, `*_vaapi`) is **self-tested** with a third of a second of synthetic video. One that is compiled in but has no device behind it is dropped, so the export dialog never offers an encoder that would fail. `--no-self-test` skips this (about 0.2 s per encoder).
- The **tier** follows: `gpu` when a hardware encoder works, `cpu-fast` with eight or more cores, `cpu`, or `constrained` (under 4 cores or 8 GB). It decides how many ffmpeg re-encodes may run at once (software encoders already use every core, so a second job would only slow both down).
- Once the server is up it **races the H.264 encoders** it has (each verified hardware encoder against `libx264 veryfast`) on six seconds of slide-like 1080p video, about a second each, and records the winner. That decides whether the *Fastest* mode ticks *hardware encoder* for compression. On an M2 Max the answer is no: slide video is mostly unchanged blocks, which x264 skips almost for free (910 fps) while the VideoToolbox encoder runs every frame through a fixed pipeline (400 fps). `--no-benchmark` skips the race.
- Decoding stays on the CPU. The upload is slide video, and software decoding of eleven minutes of it took 1.5 s where `-hwaccel videotoolbox` took 33 s.
- The PowerPoint renderer runs in a worker with a heap limit of half the machine's memory (`--renderer-memory 4096` to change it); a deck that needs more fails with a clear message instead of taking the server down.

**`npm run doctor`** runs the same check without starting the server and prints which process needs which resource for a one-hour 1080p lecture: recording, slide rendering, PowerPoint conversion, and every export stage (browser encode, upload, packaging, compression) with its memory, whether it runs on the GPU or the CPU, and a rough time. `npm run bench` (`doctor --bench`, `--height 2160` for 4K) runs the encoder race in the open, adds `libx264 medium` and `libx265 veryfast` for comparison, and says which encoder is really the fastest on this machine.

**In the browser** the app probes WebCodecs once: which codecs it can encode, and for each whether `prefer-hardware` is accepted at 1080p and at 4K, plus thread count, visible memory and the GPU name (WebGPU or WebGL). It then races the GPU and the software H.264 encoder on 150 frames of a 1080p slide (about half a second; the answer is kept for a week in `localStorage`). The export dialog's *This computer* section shows both sides.

**Performance mode** (in the export dialog, saved with the project):

| Mode | Browser stage | Server compression |
| --- | --- | --- |
| **Fastest** (default) | whichever H.264 encoder won the browser's race (`prefer-software` when it beat the GPU by 15 % or more, else `prefer-hardware` at sizes the probe confirmed); the codec the GPU can encode goes first when the codec is *auto*; unmeasured software encoders run in `realtime` latency mode | whichever H.264 encoder won the server's race (hardware or `libx264`), `veryfast` preset |
| **Balanced** | browser defaults | `libx264`/`libx265`, `medium` |
| **Smallest file** | browser defaults, `quality` latency | software encoders, `slow` preset, `stillimage` tune for x264 |

The latency choice is measured, not assumed: on an M2 Max the VideoToolbox encoder drops from 374 to 166 fps in `realtime` mode, while Chrome's software H.264 encoder runs at about 400 fps in either, so `realtime` is reserved for software codecs. A mode only sets the starting point; every field stays editable. The *Plan* section then lists the resource map for the chosen settings (GPU/CPU/disk per stage, memory, rough time) and warns when the export would take more than 40 % of the machine's memory, when a software codec was chosen although the GPU could do H.264, or when the job will take over half an hour.

**What else was done, and what it is worth.** Slides are still images, so each slide is captured once and every video frame of that slide is a reference clone with a new timestamp. For a software encoder the capture is a planar I420 frame in CPU memory (`core/yuv.ts`, BT.709, about 30 ms per slide). This matters more than it sounds: a canvas-backed frame is RGBA on the GPU and Chrome converts it again for every `encode()` call, which pinned every encoder, hardware or software, H.264 or VP9, at about 370 fps for 1080p on an M2 Max. With planar frames Chrome's software H.264 encoder reaches 570 fps in a real export (700 fps in a bare encoder loop) while the VideoToolbox encoder stays near 380 fps whatever it is fed (that is its pipeline rate; ffmpeg's `h264_videotoolbox` tops out at the same figure), which is why the browser races the two and picks the software encoder on that machine; a GPU encoder keeps the canvas frame, which is already in its memory. Slide bitmaps are decoded already scaled to the output size, the encode runs on an `OffscreenCanvas`, and the preview reuses one timeline instead of rebuilding it every animation frame. Measured on an M2 Max with Chrome: eleven minutes of 1080p at 15 fps encode in 17 s (38× real time, against 27 s before), so an hour-long lecture exports in about a minute and a half; compression on the server adds about a minute per hour with `libx264 veryfast`. Fewer frames is the one lever that always works: 10 fps is a third faster than 15 and looks the same on slides.

## Large exports

A three-hour lecture is the normal case, so the pipeline is built around it:

- **No in-memory assembly.** The muxer streams 4 MB chunks to the server or straight to disk. Memory use does not grow with the video length.
- **Back-pressure everywhere.** Every encoded frame and audio chunk awaits the encoder queue, and every chunk awaits the upload. Nothing piles up.
- **Exact timestamps.** Integer counters, not accumulated floats, so hours of video stay in sync.
- **Free-space check** before anything starts, counting the temporary copy ffmpeg needs. Files over 4 GB are fine (64-bit box sizes).
- **Crash-safe fragments.** The upload is a fragmented MP4, so an interrupted export still leaves a playable file on the server side.
- **Retries.** A dropped connection retries the chunk up to six times with exponential back-off (0.8 s doubling to a cap of 8 s). Positioned writes make duplicates harmless. A 4xx answer stops retrying, because the job is gone.
- **Cancel** stops the encoder, aborts the upload, kills ffmpeg and removes partial files. A failed job cleans up too.
- **Screen stays awake** during an export (Wake Lock), and closing the tab while recording or exporting asks for confirmation.
- **Collisions** never overwrite: you get `lecture (2).mp4` unless you tick *replace*. Folders are replaced only when they contain nothing but a previous One Take export (`.m3u8`, `.mpd`, `.ts`, `.m4s`, `.mp4`, `.tmp`).
- **Slides** are rasterised once (up to 2560×1440), cached as bitmaps during the export, and re-used.
- **Audio from different microphones** (different sample rates) is resampled to one rate.

Tips: 10 to 15 fps looks identical to 30 for slides and exports faster. For the smallest files turn on **Compress** with H.264, tune `stillimage` and CRF 26 to 30.

## System check and performance mode

Video work is heavy, so the app looks at the machine before it does any. The server runs a pre-flight check at start-up, and the export dialog turns the result into a mode and a resource map.

**At start-up** (`npm start`) the server prints what it found and serves it at `GET /api/system`:

```
One Take 1.0.0: system check
  CPU      Apple M2 Max, 12 cores (8 performance, 4 efficiency), arm64
  Memory   96 GB total, 69 GB available now
  GPU      Apple M2 Max, 38 cores, shared memory
  Disk     412 GB free in /Users/me/Movies/One Take
  ffmpeg   8.1.2 at /opt/homebrew/bin/ffmpeg
           hardware encoders: h264_videotoolbox, hevc_videotoolbox
           fastest for slides at 1080p: libx264 (libx264 910 fps, h264_videotoolbox 400 fps); decoding in software; hwaccels listed: videotoolbox
  Node     v24.14.0
  Mode     gpu: GPU encoding available; up to 2 ffmpeg re-encodes at a time
  Renderer 32.0 GB heap for PowerPoint conversion
```

- CPU model, core count and the performance/efficiency split (Apple silicon), total and available memory, the GPU (`system_profiler` on macOS, `nvidia-smi`/`lspci` on Linux, PowerShell on Windows) and free disk space where exports go.
- Every hardware encoder ffmpeg lists (`*_videotoolbox`, `*_nvenc`, `*_qsv`, `*_vaapi`) is **self-tested** with a third of a second of synthetic video. One that is compiled in but has no device behind it is dropped, so the export dialog never offers an encoder that would fail. `--no-self-test` skips this (about 0.2 s per encoder).
- The **tier** follows: `gpu` when a hardware encoder works, `cpu-fast` with eight or more cores, `cpu`, or `constrained` (under 4 cores or 8 GB). It decides how many ffmpeg re-encodes may run at once (software encoders already use every core, so a second job would only slow both down).
- Once the server is up it **races the H.264 encoders** it has (each verified hardware encoder against `libx264 veryfast`) on six seconds of slide-like 1080p video, about a second each, and records the winner. That decides whether the *Fastest* mode ticks *hardware encoder* for compression. On an M2 Max the answer is no: slide video is mostly unchanged blocks, which x264 skips almost for free (910 fps) while the VideoToolbox encoder runs every frame through a fixed pipeline (400 fps). `--no-benchmark` skips the race.
- Decoding stays on the CPU. The upload is slide video, and software decoding of eleven minutes of it took 1.5 s where `-hwaccel videotoolbox` took 33 s.
- The PowerPoint renderer runs in a worker with a heap limit of half the machine's memory (`--renderer-memory 4096` to change it); a deck that needs more fails with a clear message instead of taking the server down.

**`npm run doctor`** runs the same check without starting the server and prints which process needs which resource for a one-hour 1080p lecture: recording, slide rendering, PowerPoint conversion, and every export stage (browser encode, upload, packaging, compression) with its memory, whether it runs on the GPU or the CPU, and a rough time. `npm run bench` (`doctor --bench`, `--height 2160` for 4K) runs the encoder race in the open, adds `libx264 medium` and `libx265 veryfast` for comparison, and says which encoder is really the fastest on this machine.

**In the browser** the app probes WebCodecs once: which codecs it can encode, and for each whether `prefer-hardware` is accepted at 1080p and at 4K, plus thread count, visible memory and the GPU name (WebGPU or WebGL). It then races the GPU and the software H.264 encoder on 150 frames of a 1080p slide (about half a second; the answer is kept for a week in `localStorage`). The export dialog's *This computer* section shows both sides.

**Performance mode** (in the export dialog, saved with the project):

| Mode | Browser stage | Server compression |
| --- | --- | --- |
| **Fastest** (default) | whichever H.264 encoder won the browser's race (`prefer-software` when it beat the GPU by 15 % or more, else `prefer-hardware` at sizes the probe confirmed); the codec the GPU can encode goes first when the codec is *auto*; unmeasured software encoders run in `realtime` latency mode | whichever H.264 encoder won the server's race (hardware or `libx264`), `veryfast` preset |
| **Balanced** | browser defaults | `libx264`/`libx265`, `medium` |
| **Smallest file** | browser defaults, `quality` latency | software encoders, `slow` preset, `stillimage` tune for x264 |

The latency choice is measured, not assumed: on an M2 Max the VideoToolbox encoder drops from 374 to 166 fps in `realtime` mode, while Chrome's software H.264 encoder runs at about 400 fps in either, so `realtime` is reserved for software codecs. A mode only sets the starting point; every field stays editable. The *Plan* section then lists the resource map for the chosen settings (GPU/CPU/disk per stage, memory, rough time) and warns when the export would take more than 40 % of the machine's memory, when a software codec was chosen although the GPU could do H.264, or when the job will take over half an hour.

**What else was done, and what it is worth.** Slides are still images, so each slide is captured once and every video frame of that slide is a reference clone with a new timestamp. For a software encoder the capture is a planar I420 frame in CPU memory (`core/yuv.ts`, BT.709, about 30 ms per slide). This matters more than it sounds: a canvas-backed frame is RGBA on the GPU and Chrome converts it again for every `encode()` call, which pinned every encoder, hardware or software, H.264 or VP9, at about 370 fps for 1080p on an M2 Max. With planar frames Chrome's software H.264 encoder reaches 570 fps in a real export (700 fps in a bare encoder loop) while the VideoToolbox encoder stays near 380 fps whatever it is fed (that is its pipeline rate; ffmpeg's `h264_videotoolbox` tops out at the same figure), which is why the browser races the two and picks the software encoder on that machine; a GPU encoder keeps the canvas frame, which is already in its memory. Slide bitmaps are decoded already scaled to the output size, the encode runs on an `OffscreenCanvas`, and the preview reuses one timeline instead of rebuilding it every animation frame. Measured on an M2 Max with Chrome: eleven minutes of 1080p at 15 fps encode in 17 s (38× real time, against 27 s before), so an hour-long lecture exports in about a minute and a half; compression on the server adds about a minute per hour with `libx264 veryfast`. Fewer frames is the one lever that always works: 10 fps is a third faster than 15 and looks the same on slides.

## What counts as speech

The detector (`packages/client/src/core/vad.ts`) listens in 10 ms blocks and compares the level with the speech line.

| Setting                                  | Default  | What it does                                                                                   |
| ---------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| Speech line (threshold)                  | −45 dBFS | Sound above this counts as speech. The effective line is this or the noise floor plus 6 dB, whichever is higher. |
| Phrase ends after                        | 0.7 s    | Silence this long ends the phrase. Shorter pauses stay in the recording.                       |
| Pause between phrases                    | 0.15 s   | Silence inserted between phrases in the video. Plus 0.25 s on a slide change.                  |
| Pre-roll (fixed)                         | 200 ms   | Audio from before the trigger that is kept, so the first syllable is never clipped.            |
| Tail (fixed)                             | 150 ms   | How much of the trailing silence is kept.                                                       |
| Minimum phrase (fixed)                   | 200 ms   | Bursts shorter than this (a click, a cough) are dropped.                                        |

How it decides:

- The noise floor follows the quiet parts of the room: it drops quickly and rises slowly, and is clamped between −90 and −30 dBFS.
- A phrase starts after 30 ms (three blocks) above the line.
- Changing slides mid-phrase splits it. The part spoken so far is stored on the old slide and the rest continues on the new slide, joined without a gap. A continuation is always kept, even if it is short.
- Muting, stopping the mic, previewing or exporting ends the current phrase.

The microphone is opened in mono with echo cancellation, noise suppression and automatic gain control turned on. Capture runs in an AudioWorklet, with a ScriptProcessor fallback for browsers that lack it.

A headset or USB microphone gives the cleanest cut. Mute (`M`) when you need to talk to someone in the room.

## Saving your work and resuming

Everything is written to IndexedDB (database `one-take`) the moment it exists:

- the slide source (the PDF or the image files), so slides can be re-rendered,
- every phrase as 16-bit PCM with its slide index, sample rate and whether it continues the previous phrase,
- the project state: phrase order, current slide, your detector settings and the last export settings.

Reload the tab or close it and come back, and you continue where you left off. **New** clears all of it. If IndexedDB is unavailable (some private windows), the app still works but nothing is persisted; a warning goes to the console.

## Design system

The interface is built on [grauity](https://github.com/Newton-School/grauity), Newton School's design system (`@newtonschool/grauity` on npm), and carries the Newton School mark.

- **Colours, spacing, radii and type** come from grauity's token stylesheet (`@newtonschool/grauity/tokens.css`), which defines the primitives (`--brand-500`, `--neutral-900`, `--spacing-8px`, `--corner-radius-8px`, …) and the semantic tokens (`--bg-subtle-primary-default`, `--text-emphasis-brand-default`, `--border-subtle-primary-default`, …) for a light and a dark theme. The class on `<html>` (`grauity-theme-dark` or `grauity-theme-light`) picks the theme; nothing else changes. `packages/client/src/styles/theme.css` gives the handful of tokens the app uses most a short name (`--panel`, `--accent`, `--rec`, `--ok`, …) so the layout stylesheet reads plainly.
- **Components.** grauity ships React components, which this framework-free app cannot mount, so `packages/client/src/styles/grauity.css` carries the same recipes in plain CSS: the button variants and sizes (`NSButton`, `NSIconButton`), status pills (`NSPill`), chips (`NSChip`), the dialog and its overlay (`NSModal`, `NSOverlay`), the slider (`NSRangeInput`), text fields and selects, alerts and the progress bar. The class names are the app's own (`button.primary`, `.pill`, `.modal`), the colours and measurements are grauity's.
- **Icons** are grauity's icon font (`@newtonschool/grauity/css/grauity-icons.scss`, compiled by Vite with `sass-embedded`): `<i class="grauity-icon-mic">`. `packages/client/src/ui/icon.ts` lists the names the app uses.
- **The Newton School mark** in the top bar, the welcome tour and the browser tab is the outline of that font's `nst` glyph, so it is the same drawing the design system uses.
- **Mona Sans**, grauity's typeface, is bundled in `packages/client/public/fonts/` (variable weight, SIL Open Font License) so the app never fetches a font from the network.
- **The stage and the level meter stay dark in both themes.** Slides are projected on black, and the meter is an instrument whose white speech line should stay white.

To restyle, change the aliases in `theme.css` or upgrade `@newtonschool/grauity`; the app has no colour values of its own apart from the black stage.

## The server

The server (`packages/server`) is a small [Fastify](https://fastify.dev) app. It serves the built client, browses folders for the picker, receives uploads, and runs ffmpeg.

### Starting it

```sh
npm start                                  # after npm run build
node packages/server/dist/index.js         # the same
```

On start it prints the system check (see [System check and performance mode](#system-check-and-performance-mode)), then logs the address, the ffmpeg it found (or that HLS, DASH and compression are disabled), where the client is served from, and the default output folder, which it creates if needed.

### Options

Every flag has an environment variable with the same meaning. A flag wins over the variable.

| Flag                  | Variable                | Default                | What it does                                                               |
| --------------------- | ----------------------- | ---------------------- | -------------------------------------------------------------------------- |
| `--host`              | `ONE_TAKE_HOST`         | `127.0.0.1`            | Address to listen on.                                                      |
| `--port`, `-p`        | `ONE_TAKE_PORT`         | `4317`                 | Port.                                                                      |
| `--dir`, `-d`         | `ONE_TAKE_DIR`          | `~/Movies/One Take`    | Suggested output folder. Created on start.                                 |
| `--ffmpeg`            | `FFMPEG_PATH`           | found on `PATH`        | Path to the ffmpeg binary.                                                 |
| `--ffprobe`           | `FFPROBE_PATH`          | found on `PATH`        | Path to ffprobe (reported in capabilities; used by the e2e test).          |
| `--static`            | `ONE_TAKE_STATIC`       | `packages/client/dist` | Folder with the built client.                                              |
| `--no-static`         |                         | off                    | API only; do not serve the client.                                         |
| `--log-level`         | `ONE_TAKE_LOG_LEVEL`    | `info`                 | Fastify log level. `debug` or `trace` also logs every request.             |
| `--allow-remote`      | `ONE_TAKE_ALLOW_REMOTE=1` | off                  | Accept requests from other machines. See Security.                         |
| `--fonts`             | `ONE_TAKE_FONTS`        | none                   | Extra font folders (separated by `:`) for drawing PowerPoint slides, searched before the system fonts. |
| `--renderer-memory`   | `ONE_TAKE_RENDERER_MEMORY_MB` | half of RAM      | Heap limit in MB for the PowerPoint renderer worker.                       |
| `--no-self-test`      | `ONE_TAKE_SELF_TEST=0`  | off                    | Skip the start-up test of each hardware encoder.                           |
| `--no-benchmark`      | `ONE_TAKE_BENCHMARK=0`  | off                    | Skip the H.264 encoder race after start-up.                                |

### Where files go

Inside the folder you chose, an export passes through three names:

1. `lecture.1a2b3c4d.uploading.mp4` while the browser uploads (the eight characters are the start of the job id).
2. `lecture.1a2b3c4d.processing.mp4`, or a `lecture.1a2b3c4d.processing` folder for HLS and DASH, while ffmpeg runs.
3. `lecture.mp4`, or a `lecture` folder, when it is done.

File names are sanitised: path separators and characters that are illegal on Windows or macOS become `-`, reserved names such as `con` fall back to `lecture`, and names are cut at 120 characters. If the target exists you get `lecture (2).mp4` unless you asked to replace it. Cancelled and failed jobs remove their temporary files.

Jobs live in memory. The last 50 finished jobs stay in the list; a server restart forgets in-flight uploads, and the client tells you to export again.

### Security

The server is meant for one person on one machine.

- It listens on `127.0.0.1` only.
- Every request must carry a loopback `Host` header (`localhost`, `127.0.0.1`, `[::1]` or anything ending in `.localhost`). Anything else gets `403 forbidden_host`. This stops DNS-rebinding attacks.
- Every request other than `GET` and `HEAD` must carry a loopback `Origin` (or none, for non-browser clients). Anything else gets `403 forbidden_origin`. This stops cross-site requests.
- JSON bodies are limited to 4 MB. Uploads are raw `application/octet-stream` streams and are not limited.
- Folder listing hides dot-files and reports whether a folder exists and is writable. It can list any folder the server's user can read, which is why the server only answers localhost.

Pass `--allow-remote` to switch the `Host` and `Origin` checks off, for example to record from a laptop and save on a desktop. Do that only on a network you trust, and combine it with `--host 0.0.0.0`.

### ffmpeg detection and encoders

On start the server runs `ffmpeg -version`, `ffmpeg -encoders` and `ffmpeg -muxers` and reports the result in `/api/capabilities`. The planner uses the lists to decide what is possible.

| Codec | Software encoders           | Hardware encoders (with **Hardware encoder** on)                      |
| ----- | --------------------------- | --------------------------------------------------------------------- |
| H.264 | `libx264`                   | `h264_videotoolbox`, `h264_nvenc`, `h264_qsv`, `h264_vaapi`           |
| H.265 | `libx265`                   | `hevc_videotoolbox`, `hevc_nvenc`, `hevc_qsv`, `hevc_vaapi`           |
| VP9   | `libvpx-vp9`                |                                                                       |
| AV1   | `libsvtav1`, then `libaom-av1` | `av1_nvenc`, `av1_qsv`, `av1_videotoolbox`                         |
| AAC   | `aac`, `aac_at`, `libfdk_aac` |                                                                     |
| Opus  | `libopus`                   |                                                                       |

The first encoder in the preferred order that your ffmpeg has is used. The CRF value is mapped onto each encoder's own quality scale (VideoToolbox's 1 to 100, NVENC's `-cq`, QSV's `-global_quality`). H.265 output is tagged `hvc1` so Apple players accept it.

## HTTP API

All endpoints are under `/api`. Bodies and answers are JSON unless noted. The zod schemas in `packages/shared/src/api.ts` are the source of truth; the server validates every request against them and the TypeScript types are inferred from them, so client and server cannot drift apart.

### Endpoints

| Method   | Path                          | What it does                                                                                     |
| -------- | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET`    | `/api/health`                 | `{ ok, name, version }`.                                                                         |
| `GET`    | `/api/capabilities`           | Server version, platform, home and default folders, ffmpeg info (path, version, encoders, muxers), ffprobe path, and shortcut folders for the picker. |
| `GET`    | `/api/system`                 | The system check: CPU, memory, GPU, disk, verified hardware encoders, benchmark winner and tier.  |
| `POST`   | `/api/convert?name=deck.pptx` | A PowerPoint file as `application/octet-stream`; answers with `application/pdf`. Renderer notes come in the `x-one-take-warnings` header. |
| `GET`    | `/api/fs/list?path=&files=1`  | Lists a folder: entries, parent, whether it exists and is writable, and free bytes. `files=1` includes files. Defaults to the home folder. |
| `POST`   | `/api/fs/mkdir`               | `{ path }`. Creates a folder (and parents) and returns its listing.                              |
| `GET`    | `/api/exports`                | All jobs the server remembers, newest first.                                                     |
| `POST`   | `/api/exports`                | Creates a job. Returns `201` with the job.                                                       |
| `GET`    | `/api/exports/:id`            | One job.                                                                                         |
| `PUT`    | `/api/exports/:id/data?offset=` | A chunk as `application/octet-stream`, written at that byte offset. Returns `{ received }`.    |
| `POST`   | `/api/exports/:id/finish`     | `{ totalBytes }`. Closes the upload, checks the size, and starts processing.                     |
| `GET`    | `/api/exports/:id/events`     | Server-sent events: the current job first, then every change until it finishes.                  |
| `DELETE` | `/api/exports/:id`            | Cancels the job and removes partial files.                                                       |
| `POST`   | `/api/exports/:id/reveal`     | Opens the file manager at the result (`open -R`, `explorer /select`, or `xdg-open`).             |

### Export job lifecycle

```
POST /api/exports ──▶ uploading ──▶ processing ──▶ done
                         │              │
                         └──────────────┴──────▶ failed / cancelled
```

While `uploading`, the progress stage is `upload` and the percent is bytes received against the estimate. While `processing`, the stage is `process` with ffmpeg's percent and speed (relative to real time), then `finalize` while the result is moved into place. A job without ffmpeg work goes straight from `uploading` to `finalize`.

### Creating a job

```json
{
  "fileName": "lecture",
  "directory": "/Users/you/Movies/One Take",
  "overwrite": false,
  "upload": {
    "container": "fmp4",
    "videoCodec": "avc",
    "audioCodec": "aac",
    "width": 1920,
    "height": 1080,
    "fps": 15,
    "durationSec": 5400,
    "estimatedBytes": 3500000000
  },
  "processing": {
    "container": "mp4",
    "video": { "mode": "copy" },
    "audio": { "mode": "copy" },
    "segmentSeconds": 4,
    "hlsSegmentType": "fmp4",
    "ladder": null
  }
}
```

`processing` is `null` when the server should store the upload as is. For a re-encode, `video` is `{ "mode": "encode", "codec": "h264", "crf": 23, "preset": "medium", "tune": "stillimage", "fps": null, "height": null, "maxBitrateKbps": null, "keyFrameIntervalSec": 4, "hardware": false }` and `audio` is `{ "mode": "encode", "codec": "aac", "bitrateKbps": 96 }`. `ladder` is a list of `{ name, height, videoBitrateKbps, audioBitrateKbps }` for adaptive output.

Before the job is created the server checks that the folder is writable, that ffmpeg exists when `processing` is set, and that the free space covers `estimatedBytes` (doubled when ffmpeg runs).

### The job object

```json
{
  "id": "6c1f…",
  "createdAt": "2026-10-08T12:00:00.000Z",
  "updatedAt": "2026-10-08T12:04:10.000Z",
  "fileName": "lecture.mp4",
  "directory": "/Users/you/Movies/One Take",
  "state": "processing",
  "bytesReceived": 3498211328,
  "progress": { "stage": "process", "percent": 42, "message": "Packaging as MP4…", "speed": 310.5 },
  "outputs": [],
  "error": null,
  "upload": { "...": "the upload spec you sent" },
  "processing": { "...": "the processing spec you sent" },
  "command": "ffmpeg -hide_banner -nostdin -y … -movflags +faststart -f mp4 lecture.6c1f0a2b.processing.mp4"
}
```

When the job is `done`, `outputs` holds `[{ path, kind: "file" | "directory", bytes }]`.

### Events

`GET /api/exports/:id/events` sends one `data:` line per event, each a JSON object:

- `{ "type": "job", "job": { … } }` whenever the job changes (at most every 250 ms during ffmpeg).
- `{ "type": "log", "line": "…" }` for each line ffmpeg prints to stderr.

A `: ping` comment goes out every 15 s to keep the connection alive. The stream ends when the job reaches `done`, `failed` or `cancelled`.

### Errors

Every error is `{ "error": { "code", "message", "details"? } }`.

| Status | Code                      | When                                                                  |
| ------ | ------------------------- | --------------------------------------------------------------------- |
| 400    | `bad_request`             | The body or query failed validation (`details` lists the zod issues). |
| 400    | `directory_not_writable`  | The destination folder does not exist or cannot be written.           |
| 400    | `ffmpeg_missing`          | The job needs ffmpeg and the server has none.                         |
| 400    | `disk_full`               | Not enough free space for the estimate.                               |
| 400    | `folder_not_empty`        | You asked to replace a folder that holds files One Take did not make. |
| 403    | `forbidden_host`          | The `Host` header is not loopback.                                    |
| 403    | `forbidden_origin`        | A non-GET request came from a non-loopback origin.                    |
| 404    | `job_not_found`           | Unknown job, usually because the server restarted.                    |
| 404    | `not_found`               | No such route.                                                        |
| 409    | `not_uploading`           | Data or finish arrived for a job that is no longer uploading.         |
| 409    | `no_output`               | Reveal was asked for a job that has no result yet.                    |
| 500    | `internal`, `reveal_failed`, `too_many_files` | Something went wrong on the server.               |

## Project layout

npm workspaces with TypeScript project references. `shared` is built first; `server` and `client` depend on it.

```
one-take/
├── package.json              scripts, workspaces, dev tooling
├── tsconfig.base.json        strict compiler options shared by every package
├── eslint.config.js          typescript-eslint strictTypeChecked + stylisticTypeChecked, import order
├── vitest.config.ts          three test projects: shared, server, client
└── packages/
    ├── shared/               types and logic used by both sides (no DOM, no Node APIs)
    │   └── src/
    │       ├── api.ts            zod schemas and inferred types for every request and response
    │       ├── containers.ts     container and codec catalog, which combinations are valid, ffmpeg names
    │       ├── presets.ts        resolution presets, frame rates, quality levels, CRF ranges, ladder rungs
    │       ├── plan.ts           planExport(): request + capabilities → browser plan + server spec + warnings + blockers
    │       ├── estimate.ts       size and frame estimates from a plan
    │       ├── presentations.ts  accepted slide file types (PDF, PowerPoint, images)
    │       ├── system.ts         SystemProfile types and the machine tier
    │       ├── performance.ts    performance modes, browser capability probe results, applyPerformanceMode()
    │       ├── resources.ts      resource map per export stage and performance warnings
    │       └── util.ts           formatBytes, formatDuration, sanitizeFileName
    ├── server/               Fastify server (Node 22+)
    │   └── src/
    │       ├── index.ts          entry: config, system check, ffmpeg detection, start, graceful shutdown
    │       ├── doctor.ts         `npm run doctor` / `npm run bench`: system check and encoder race without the server
    │       ├── config.ts         flags and environment variables
    │       ├── app.ts            app factory: loopback checks, error handler, static client, routes
    │       ├── routes/           capabilities and system, fs, convert (.pptx → PDF), exports (chunk upload, finish, SSE, cancel, reveal)
    │       ├── services/
    │       │   ├── jobs.ts       JobManager: positioned writes, finish, process, cancel, cleanup
    │       │   ├── ffmpeg.ts     detection, pure buildFfmpegArgs(), progress parsing, runFfmpeg()
    │       │   ├── filesystem.ts listing, mkdir, free space, unique names, shortcuts
    │       │   ├── system.ts     detectSystem(): CPU/RAM/GPU/disk, hardware encoder self-tests, benchmarkEncoders()
    │       │   ├── convert.ts    PptxConverter: runs the renderer in a worker thread with a heap limit
    │       │   └── pptx/         PowerPoint → PDF: html (text runs → paragraphs), layout (line breaking), fonts, geometry, render (pdfkit), worker
    │       └── util/             errors.ts (ApiError with stable codes), semaphore.ts (limits concurrent re-encodes)
    ├── client/               Vite + TypeScript app, no framework
    │   └── src/
    │       ├── main.ts           boot; exposes window.__onetake test hooks
    │       ├── app/              App controller, Store (state + event bus), types and defaults
    │       ├── audio/            MicCapture (AudioWorklet), capture processor, preview playback
    │       ├── core/             VoiceActivityDetector, timeline builder, PCM helpers, I420 slide frames (yuv.ts)
    │       ├── slides/           PDF (pdf.js) and image rasterisation, natural sort
    │       ├── storage/          IndexedDB project store (idb)
    │       ├── export/           capabilities, encoder (mediabunny), sinks (server / file / memory), runner, real-time fallback
    │       ├── api/              typed client for the server API with SSE and polling
    │       ├── ui/               layout, export dialog, folder picker, film strip, timeline list, meter, keyboard, toast, icon (grauity icons + the Newton School mark)
    │       └── styles/           theme.css (Mona Sans, token aliases), grauity.css (grauity components in plain CSS), app.css (layout)
    │   └── public/fonts/         Mona Sans (variable weight, OFL)
    └── e2e/                  end-to-end runner (no test framework, no dependencies)
        └── src/
            ├── run.ts            boots server + headless Chrome, records, exports, probes with ffprobe
            ├── cdp.ts            minimal Chrome DevTools Protocol client on Node's WebSocket
            └── make-fixtures.ts  writes a 4-page PDF and a WAV that imitates speech with pauses
```

Dependencies are few on purpose. Client: `mediabunny` (muxing and WebCodecs), `pdfjs-dist` (PDF rendering), `idb` (IndexedDB), `@newtonschool/grauity` (design tokens and the icon font; only its CSS is bundled, the React components are not used). Server: `fastify`, `@fastify/static`, `zod`, `pptxtojson` (reads PowerPoint files), `pdfkit` (draws the PDF). Shared: `zod`.

## Development

### Scripts

| Command                | What it does                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `npm run dev`          | Builds `shared` once, then watches it, runs the server with `tsx watch` on 4317, and Vite on 5173 with `/api` proxied. |
| `npm run build`        | Builds `shared`, `server` and `client` in order.                                                           |
| `npm start`            | Runs the built server, which serves the built client.                                                      |
| `npm run typecheck`    | `tsc -b` across all four packages.                                                                         |
| `npm run lint`         | ESLint. `npm run lint:fix` fixes what it can.                                                              |
| `npm run format`       | Prettier. `npm run format:check` only checks.                                                              |
| `npm test`             | Unit tests with Vitest (`npm run test:watch` to keep them running).                                        |
| `npm run e2e`          | Builds, then drives the built app in headless Chrome. See below.                                           |
| `npm run check`        | Typecheck, lint, format check and unit tests. Run this before you commit.                                  |
| `npm run doctor`       | System check and resource map for a one-hour 1080p lecture, without starting the server.                    |
| `npm run bench`        | `doctor --bench`: races the H.264 encoders on this machine (`--height 2160` for 4K).                        |

### Tooling

- **TypeScript 6**, strict, with `noUncheckedIndexedAccess`, `verbatimModuleSyntax` and `isolatedModules`. Each package is a composite project.
- **ESLint 10** with `typescript-eslint` `strictTypeChecked` and `stylisticTypeChecked`, `eslint-plugin-import-x` ordering (builtin, external, internal, parent, sibling, index, type, alphabetised with blank lines between groups), inline type imports, `eqeqeq`, exhaustive switches, no floating promises.
- **Prettier** with a print width of 110, single quotes and trailing commas.
- **Vitest 5** with three projects. Server tests have a 60 s timeout because some of them run real ffmpeg.
- **Vite 8** for the client, targeting ES2022, with `pdfjs` and `mediabunny` split into their own chunks and the AudioWorklet loaded through `?worker&url`. `sass-embedded` is there only to compile grauity's icon stylesheet.
- **npm 11** blocks dependency install scripts unless `allowScripts` in the root `package.json` approves them. The three that have one (`esbuild`, `unrs-resolver`, `fsevents`) are approved there, pinned to the versions reviewed; after upgrading one of them, run `npm install-scripts ls`, read what changed, and `npm install-scripts approve <pkg>` again. `overrides` keeps `image-size` on the patched 2.x line: `pptxgenjs` (used only to build test decks) still declares the vulnerable 1.x but never loads it. `npm install` should finish with `found 0 vulnerabilities` and no warnings; if it does not, `npm audit` names the package.

### Unit tests

```sh
npm test
```

- `shared`: the planner (every branch of what-runs-where), key-frame alignment, ladders, size and frame estimates for a three-hour lecture, even-size rounding, file name sanitising, formatting.
- `server`: the ffmpeg argument builder and capability parsing, the job manager (unique names, short uploads, cancel during upload and during ffmpeg, replace rules, faststart remux, HLS and DASH packaging), and the HTTP app (loopback checks, validation, the SPA fallback, a full export through the API). Tests that need ffmpeg run only when it is installed.
- `client`: the voice detector, the timeline builder and the PCM helpers (these are pure, so they run in Node).

### End-to-end run

```sh
npm run e2e
# or, without rebuilding:
npx tsx packages/e2e/src/run.ts --out /tmp/one-take-e2e --port 4399 --keep
```

The runner needs Chrome, ffmpeg and ffprobe. It:

1. writes a 4-page PDF and a WAV that imitates speech with thinking pauses,
2. starts the real server on port 4399 with the built client,
3. starts headless Chrome with the WAV as a fake microphone (`--use-file-for-fake-audio-capture`) and drives it over the DevTools Protocol,
4. loads the slides, records with a slide change mid-sentence, and checks that four phrases exist and one continues across slides,
5. exports MP4 (checks faststart, 5 fps and AAC), HLS by stream copy at 480p with 2 s segments (checks the playlist, the init segment, the segment count and H.264), DASH with compression (checks that the ffmpeg command carried CRF 30 and the `stillimage` tune), WebM (checks no ffmpeg was needed), a compressed HEVC file (checks it is smaller than the MP4) and an in-memory MP4 saved in the browser, probing each with ffprobe,
6. reloads the page, checks the project resumed, and plays the preview.

Set `CHROME` to the path of your Chrome binary if it is not at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. `--keep` leaves the output folder in place for inspection.

The app exposes `window.__onetake` with the store, the detector, slide loading, navigation, deletion, undo and `exportWith(overrides, inMemory)`, so you can script the same checks from the DevTools console.

## Browser support

| Browser                 | Recording | Export with the server | Export in the browser                             |
| ----------------------- | --------- | ---------------------- | ------------------------------------------------- |
| Chrome, Edge (desktop)  | Yes       | Yes, full speed        | Yes, streamed to disk through a save dialog       |
| Other Chromium browsers | Yes       | Yes, full speed        | Usually the same as Chrome                        |
| Safari, Firefox         | Yes       | Depends on WebCodecs support in that version | In memory, up to about 2 GB, then downloaded. Without WebCodecs, real-time WebM only. |

The export dialog tells you what your browser can encode. Codec availability also depends on the operating system: H.265 and AV1 encoding, for example, are often only available with hardware support.

## Troubleshooting

**Nothing is recorded when I talk.** Watch the **Mic level** meter. Your voice must cross the white line. Lower the **Speech line** slider until it does, or move closer to the microphone. Check that the right microphone is selected and that the page is not muted (`M`).

**The recording starts on its own.** Room noise is crossing the line. Raise the **Speech line** slider, or wait a few seconds: the noise floor adapts and the line rises with it.

**Phrases are cut off at the end.** Raise **Phrase ends after**. The default 0.7 s treats a longer pause as the end of a phrase.

**The export dialog says the server is not reachable.** Start it with `npm start` and check that the page is open on the same host and port the server logs. In development the Vite page on 5173 proxies to the server on 4317; both must be running. Or choose **Save in browser**.

**ffmpeg not found.** Install it (see [What you need](#what-you-need)) or pass `--ffmpeg /path/to/ffmpeg`. The capabilities endpoint shows what the server found. Without ffmpeg, MP4, MOV, MKV and WebM still work; HLS, DASH and compression do not.

**"This browser cannot encode …".** The container needs a codec your browser does not have. Pick another container, set the codec to **Automatic**, or save to a folder with ffmpeg installed and let the server transcode.

**MPEG-TS segments need AAC audio.** HLS with `.ts` segments cannot carry Opus. Choose AAC, or fMP4 segments.

**Unknown export job after a restart.** Jobs live in memory. Restarting the server during an upload loses the job; export again.

**The folder cannot be replaced.** Replacing a folder is allowed only when it holds nothing but a previous One Take export. Choose another name or empty the folder yourself.

**A PowerPoint slide looks a little different.** Fonts the machine lacks are replaced by a stand-in with the same weight and style, which shifts line breaks. Pass the real fonts with `--fonts`. 3-D effects, soft shadows, embedded video, SmartArt animation and GIF or SVG pictures are approximated or skipped; the browser console lists what the renderer changed. For a pixel-exact result, export the deck as PDF.

**Hardware encoder refused above 4K.** Many hardware encoders cap at 4096×2304. Turn **Hardware encoder** off or pick a smaller size.

**Export in Safari or Firefox fails for a long lecture.** Those browsers assemble the file in memory. Use the server, or split the lecture.

**The mic works but the level meter is flat in headless Chrome.** You need `--use-fake-device-for-media-stream`, `--use-file-for-fake-audio-capture=<wav>` and `--disable-features=AudioServiceSandbox`. The e2e runner sets these.

## Privacy

Audio never leaves your computer. The browser keeps phrases in IndexedDB, the server writes only to the folder you pick, and no network request goes anywhere but `localhost`. There is no analytics, no account, and no cloud.

## License

MIT. See [LICENSE](LICENSE).
