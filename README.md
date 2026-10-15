# One Take

Turn a slide deck plus your voice into a lecture video, without ever pressing pause.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node 22+](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6.svg)

Load your slides, start the mic and talk. Only the moments you speak are kept. When you stop to think, nothing is recorded. When you speak again, the new phrase is appended right after the last one, so the finished video sounds like one continuous take. Move through the slides whenever you like and the video follows you.

You choose how much the app hears. In **Auto** the mic listens the whole time and the app decides when you are speaking. In **Press to speak** nothing is recorded unless you hold `Space` (or the button on the stage); let go while you think, and the app hears nothing in between.

Everything runs on your own computer. The browser records and encodes, and a small local server saves the result into any folder you choose and packages it with ffmpeg. Nothing leaves your machine.

## Contents

- [What you get](#what-you-get)
- [What you need](#what-you-need)
- [Quick start](#quick-start)
- [How to use it](#how-to-use-it)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Output formats](#output-formats)
- [Quality and encoding settings](#quality-and-encoding-settings)
- [Speed, filler words, transcript and subtitles](#speed-filler-words-transcript-and-subtitles)
- [The studio: deep clean and only your voice](#the-studio-deep-clean-and-only-your-voice)
- [How an export works](#how-an-export-works)
- [Large exports](#large-exports)
- [System check and performance mode](#system-check-and-performance-mode)
- [What counts as speech](#what-counts-as-speech)
- [Who is speaking](#who-is-speaking)
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

- **Pauses cut automatically, and never your voice.** Two listens, both plain signal processing (no model, nothing trained, every rule readable), listen for a human voice 32 ms at a time: sound that stands out from the room's noise, repeats at the rate of a voice's pitch, and changes the way speech does. The first listen runs live and is lenient on purpose: it opens a phrase on the first hint of a voice and holds it open through a soft aside, a sentence that trails off or a low creaky ending, so nothing you say is cut as you say it. Two seconds after you fall silent the phrase is finished and gets a second listen, with the whole of it in view: the room's noise is measured from the quiet moments either side of every frame, the pitch is followed both ways, and only then are the pauses cut out, the dead air at the ends trimmed, and a phrase that turns out to hold no voice at all dropped. A fan, an air conditioner, typing, breathing or a chair never make it into the video, and neither does a pause; a sentence that drops 25 dB in the middle does.
- **Background noise taken out, live.** Before anything hears the microphone, DeepFilterNet3 (a trained noise model, full-band at 48 kHz, running on the audio thread as WebAssembly) takes out fans, typing, traffic, music and other people talking, with about 40 ms of delay. On a machine that cannot keep up it gives way to the classic filter, plain signal processing that learns the room's steady noise (a fan, a hum, hiss) and takes it out; you can also choose the classic filter, or none, from the **Noise filter** list under the level meter. The **Microphone** list next to it picks the mic; both are remembered.
- **Knows whose voice it is.** Two checks run on every phrase while you record. The camera watches your mouth (MediaPipe's Face Landmarker, in a worker): a voice with your lips moving is you, a voice with your lips still is someone else. And each phrase's voice is compared with a profile of yours, made once from twenty seconds of reading (a speaker-embedding model, WeSpeaker's ResNet34, through onnxruntime-web in a worker). A phrase that is another voice is marked in the timeline within a second of ending, with the reasons; one the two checks disagree on is marked as not sure. Nothing is uploaded: the models are fetched once and kept, the profile stays in your browser.
- **Your camera in the picture.** Tick **Record camera** under the level meter and your webcam is recorded along with your voice, phrase by phrase, and laid over the slides in the video. Put the picture in any corner with one click, or drag it anywhere on the slide; set its size with a slider or by dragging its corner, from a small badge up to half the slide's width. What you see on the stage is exactly where it will be in the export. The picture follows every cut, split and re-record in the editor without being re-encoded, and the export dialog can leave it out.
- **Two ways to drive the mic.** *Auto* listens all the time and decides for you. *Press to speak* records only while you hold `Space` or the big button on the stage, so the app is never listening when you have not asked it to; the dead air at either end of a press is still trimmed. Switch at any time, even mid-recording.
- **PDF, PowerPoint or images.** Drop a PDF, a `.pptx` / `.ppsx` / `.pptm` deck or a set of images. PowerPoint files are turned into PDF on the local server in plain JavaScript; no Office, Keynote or LibreOffice needed.
- **Slides follow your navigation.** Change slides with the arrow keys, a presenter clicker, or a click on a thumbnail. If you change slides mid-sentence, the sentence stays intact across both slides.
- **Fix it afterwards.** The editor plays the lecture with a scrub bar and works clip by clip (a clip is one phrase on one slide): re-record a clip and the new voice takes its place, cut a stretch of audio out of one, split it, move it to another slide, delete it, or record a new clip and drop it in anywhere. **Remove pauses** runs the second listen over the whole recording and cuts every stretch where nobody is speaking. Undo steps back through every change.
- **Any container.** MP4, fragmented MP4, QuickTime MOV, Matroska MKV, WebM, HLS (`index.m3u8` plus segments) and MPEG-DASH (`manifest.mpd` plus segments).
- **Any quality.** Resolution presets from 360p to 4K or a custom size, frame rate from 1 to 120 fps, four quality levels or an exact bitrate, H.264 / H.265 / VP9 / AV1 video, AAC or Opus audio, and key-frame spacing.
- **Compression on the server.** ffmpeg re-encodes with a CRF quality target, x264 / x265 speed presets, the `stillimage` tune for slides, a different output frame rate, scaling, a bitrate cap, and hardware encoders when your machine has them.
- **Adaptive streaming.** HLS or DASH ladders (1080p / 720p / 480p / 360p) with a master playlist.
- **Save anywhere.** A folder picker browses the computer running the server. Files never leave the machine.
- **Built for long lectures.** Streaming writes, encoder back-pressure, free-space checks, crash-safe fragments, cancel at any stage, and no in-memory assembly. See [Large exports](#large-exports).
- **Uses your hardware encoder.** The dedicated video encoder (Apple's media engine through VideoToolbox, NVIDIA NVENC, Intel Quick Sync, VAAPI) does the encoding wherever your machine has one, in the browser and in ffmpeg, until you untick **Use the hardware encoder** in the export dialog. A start-up system check (CPU, memory, GPU, disk, ffmpeg hardware encoders, each one self-tested) and measured encoder races show what the machine can do; a *Fastest / Balanced / Smallest file* mode and a resource map show what each export stage will cost.
- **Your exports in one list.** Every video saved to a folder on this computer is listed under **Exports** in the top bar, even after the server restarts: watch it in the app, show it in Finder or Explorer, or delete it.
- **Faster, cleaner, with subtitles.** At export time the lecture can be played at 1.25×, 1.5× or 2× with the voice keeping its pitch (a time-stretch in plain code, no library), the volume evened out from phrase to phrase, and the "um"s and "uh"s cut: a filler is found by its shape in the spectrum, a held, flat, central vowel standing between two pauses, with a list to listen to each one before it goes. With whisper installed, the server transcribes the speech and the export gets subtitles drawn into the picture, `.srt` and `.vtt` files next to the video, and a `.txt` transcript. The audio never leaves the machine.
- **A studio for the export.** Once `npm run studio` has set it up, the local server runs heavy models over the recording as the microphone heard it, before any filter: MossFormer2's deep clean over the whole recording, and AV-MossFormer2's target speaker extraction to keep only your voice in the phrases where another voice was heard (the camera's film of your mouth tells it which voice is yours; without a face, the separation model and your voice profile do). Every clip then has three versions, **Original**, **Cleaned** and **Only my voice**, to hear and choose in the editor, and the flagged phrases get a review list like the filler list. Each wait can be skipped. The camera's picture can get a blurred or plain background and even exposure and colour before it goes into the frame.
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
| Python 3.10 to 3.13, or uv (optional) | The studio: the deep clean and keeping only your voice at export time, set up once with `npm run studio` (about 1.7 GB of models). Without it those switches are greyed out. |

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

Click **Start mic**. Chrome asks for microphone permission the first time. Pick a different microphone from the **Microphone** list under the level meter if you have more than one (the browser only names them once the mic has been allowed, so the list fills after the first start); the choice is remembered. Next to it, **Noise filter** is set to **Deep** by default: DeepFilterNet3 takes fans, typing, traffic, music and other people's voices out from under yours before anything is recorded. Pick **Classic** for the plain filter that only takes out steady noise (a fan, a hum, hiss), or **Off** for nothing beyond what Chrome does on its own; the choice takes effect at once, even mid-recording, and is remembered. The note under the meter says which filter is really running.

The first time you start the mic, One Take asks to learn your voice: read the lines in the box out loud for twenty seconds, in the voice you lecture in, and press nothing else. From then on every phrase is compared with how your voice sounds (see [Who is speaking](#who-is-speaking)). Skip it and the voice check stays off until you click **Learn my voice** under the level meter, which also lets you learn it again. The **Camera** list next to it picks the camera for the lip check, or turns it off; while the camera is watched, a small mirror of it sits in the corner of the stage so you can see you are in the frame.

Next to **Start mic** is the mode switch, **Auto | Press to speak**:

- **Auto** (the default): the mic is live the whole time you are recording. The detector decides when a phrase starts and ends; you never touch anything while you talk.
- **Press to speak**: the mic is on, but nothing is heard until you hold `Space` or the **Hold to speak** button that appears at the bottom of the stage. Hold it while you talk and let go while you think. The status pill reads *Hold Space to speak* while the key is up, *Speak now* once it is down, and *Recording* while you talk. Nothing from before the press or after the release can end up in a phrase, not even as pre-roll. The dead air between pressing and your first word, and between your last word and letting go, is trimmed just like a pause in Auto, and a pause inside one press that is longer than *Phrase ends after* is cut too. Mute is hidden in this mode, because letting go of the key is the mute.

The choice is remembered in this browser. Switching while a phrase is being spoken ends that phrase first.

The **Mic level** meter shows your voice against a white line, the *speech line*. Sound under the line never counts as speech, so a faint voice from the next room can't start a phrase. Above the line, the voice detector decides what is a voice and what is noise, so a fan, an air conditioner or your keyboard won't trigger a phrase either. Your own voice should go clearly past the line; if it doesn't, move the **Speech line** slider until it does. The note under the meter shows how sure the detector is (*voice 92%*).

### 3. Switch on the camera (optional)

Tick **Record camera** next to the **Camera** list under the level meter. The browser asks for camera permission the first time, then your picture appears over the slide, mirrored like a mirror so it is easy to frame yourself (the recording is not mirrored). A row of camera controls appears under the sliders:

- **Camera** (the list next to the switch): which camera to use, if you have more than one. The same camera watches your lips for the lip check (see *Who is speaking*), opened once for both. Like the microphones, the browser names them once one has been allowed.
- **Position**: four buttons put the picture in the top-left, top-right, bottom-left or bottom-right corner of the slide. Or just drag the picture on the slide to wherever you like; it snaps into a corner when it comes close to one, and the note under the row says *Where you dragged it* otherwise.
- **Size**: the picture's width as a share of the slide's width, from 12 % to 50 % (24 % to begin with). Dragging the small handle on the picture's free corner does the same.

The picture always stays on the slide, a small margin in from its edge, and keeps the camera's own shape. The stage shows it exactly where it will be in the finished video, at the same size relative to the slide, whatever resolution you export at.

The camera records only while the mic is on: each phrase takes the stretch of picture that goes with its words, pauses included in neither. Phrases recorded with the camera off (or before you ticked it) simply show the slide alone; you can turn the camera on or off between phrases, or in the middle of a recording. The switch, the camera and the layout are remembered in this browser, but the camera never opens on its own: after a reload it opens when you start the mic, or when you tick the switch again.

Recording the camera needs WebCodecs plus a way to read frames off the camera (Chrome and Edge have both); elsewhere the switch is greyed out and says so.

### 4. Talk, pause, talk again

While you speak, a red **RECORDING** flag shows. The flag stays up for two seconds after you stop, while the app makes sure you have finished rather than dropped your voice; the phrase then appears in the timeline a moment later, with its pauses already cut. Pause as long as you like; nothing of the pause is kept. When you speak again, the new phrase is placed right after the last one with a short gap. The total recorded time is shown at the top.

In Auto, press `M` to mute while you talk to someone in the room. In Press to speak, just let go. Press `R` or **Stop** to turn the mic off.

### 5. Move through the slides

Use `→` and `←`, `PageDown` and `PageUp`, a presenter clicker, or click a thumbnail in the film strip. In Auto, `Space` also moves to the next slide; in Press to speak, `Space` is the talk key and never changes slides. Each thumbnail shows how many seconds you've recorded on that slide.

If you change slides while speaking (in either mode, including during a press), the sentence is split at that moment and continues on the new slide without a gap or a fade. In the video the slide changes exactly where you pressed the key. Skipping straight past a slide mid-sentence stores nothing on it.

### 6. Fix a mistake

- `Backspace` or `Delete` removes the phrase you're saying right now, or the last finished one if you're quiet.
- `Cmd/Ctrl+Z` brings a removed phrase back.
- `✕` on any phrase in the timeline deletes it.

### 7. Preview and reorder

**Preview** plays the lecture with the slides switching at the right moments. `▶` on a phrase plays from there. Drag phrases to reorder them. Press `Esc` to stop.

### 8. Edit the video

Click **Edit** to open the editor. It shows the lecture as a player with a scrub bar on the left and the list of clips on the right. A clip is one phrase on one slide, which is exactly what the timeline on the main screen shows; the editor only gives you more ways to change them.

- **Play and scrub.** `▶` plays from the playhead; click or drag the bar under the slide to move through the lecture, even into the middle of a phrase. `Space` plays and pauses, `←` `→` jump between clips.
- **Re-record a clip.** Select it and click **Re-record**. The mic opens (in the same mode as the top bar: auto, or hold `Space` to speak), you say it again, press **Stop**, listen to the take, and **Use this take**. The new voice replaces the old clip at the same place in the video, on the same slide. Pauses in the take are cut out, as always, so a take with two sentences and a breath in between becomes two clips.
- **Cut a stretch of audio.** Drag across the waveform of the selected clip to select a stretch, then **Cut selection** removes it (the two sides are joined with a short fade) or **Keep only selection** throws away everything else. **Play selection** lets you hear it first.
- **Split a clip.** Put the playhead inside the clip (click on the waveform) and click **Split at playhead**. The two halves still play back to back; now a new clip can go between them.
- **Add a clip.** **Add clip after** records a new clip after the selected one; **Add a clip** under the list lets you pick any slide and any position (at the start, or after any clip). Pick the slide, record, listen, use.
- **Move a clip to another slide.** The **Slide** list next to the clip's name changes which slide it shows; the audio stays the same.
- **Delete a clip** with the **Delete** button or the `Delete` key.
- **Remove pauses.** The second listen goes through every clip and cuts out the stretches where nobody is speaking: a long silence at the end of a clip, or a pause inside one (the clip is split there, just as a live phrase is). Pauses shorter than *Phrase ends after* stay, and so do the pre-roll and tail. It is one change, so one Undo brings everything back. Use it on a recording made before the voice detector was there, or after a session in a room loud enough to keep a phrase open.
- **The picture follows.** A clip recorded with the camera on keeps its picture through every cut, split, keep, move and Remove pauses: the frames are never decoded and encoded again, the clip only remembers which stretch of them to play. The editor's player shows the picture over the slide while it plays, and a take recorded with the camera on gets one too.
- **Original, Cleaned or Only my voice.** Under the waveform, each clip can be switched between the microphone as it was, the cleaned version and only your voice, each with its own ▶, and the studio can be asked to make a version of that one clip. See [Three versions of every clip](#three-versions-of-every-clip).
- **Undo** (`Cmd/Ctrl+Z`) steps back through everything you did since opening the editor.

Every change is saved the moment it is made, so there is no Save button: **Done** (or `Esc`) just closes the editor. The main microphone is turned off while the editor is open, because the editor records its own takes.

### 9. Export the video

Click **Export video**. In the dialog you choose:

- **Save to**: a folder on this computer (through the server) or **Save in browser**.
- **File name**, **Container**, **Resolution**, **Frame rate**, **Quality**, **Video codec**, **Audio** codec and bitrate, **Key frame every**, and **Order**.
- **Compression (server, ffmpeg)** and, for HLS and DASH, **Segment length**, **Segment type** and **Adaptive bitrate**.
- **Sound**: the studio's deep clean and only-your-voice switches with what each will cost on this computer, the check for a second voice, and the list of flagged phrases to listen to, keep or leave out. See [The studio](#the-studio-deep-clean-and-only-your-voice).
- Under **This computer**: what the machine has, the **Use the hardware encoder** switch (on by default; untick it to encode on the CPU, and the choice is remembered in this browser) and the performance mode.
- Under **Camera** (shown when any phrase has a picture): whether to **show the camera picture over the slides**, where it will be, and a reminder to pick 24 or 30 fps so the speaker moves smoothly (slides alone look the same at 15 fps).
- Under **Enhance**: the playback **Speed**, **even out the volume**, **cut filler words** with a list of what was found, and **transcribe the speech and add subtitles**. See [Speed, filler words, transcript and subtitles](#speed-filler-words-transcript-and-subtitles).

The **Plan** panel shows the two stages (what the browser encodes, what the server does afterwards), an estimate of the upload size and the final size, warnings, and any reason the export cannot run. Progress covers encoding, upload and ffmpeg, and you can cancel at any point. When it's done, **Show in folder** opens Finder or Explorer at the file.

To close the slides and start over, click the **×** after the deck's name in the top bar. Slides with nothing recorded on them close at once; otherwise the app asks before deleting the phrases, because they cannot be brought back.

### 10. Find, watch or delete an exported video

Click **Exports** in the top bar (or **Exported videos…** at the bottom of the export dialog). Every video the local server has saved is listed, newest first, with its format, size, duration, where it went and which encoder made it. **Play** streams an MP4, MOV or WebM into a player right there; an HLS or DASH folder opens in the file manager instead. **Show in folder** opens Finder or Explorer at the file. **Delete** asks once, then removes the file from disk and the entry from the list; an HLS or DASH folder is deleted only while it holds nothing but the export. A video you moved or deleted outside the app is shown as *not on disk*, with **Remove from list** in place of Delete.

The list is kept by the server (see [Where files go](#where-files-go)), so it survives restarts. Files saved with **Save in browser** never pass through the server and are not listed.

## Keyboard shortcuts

| Keys                                   | What happens                                             |
| -------------------------------------- | -------------------------------------------------------- |
| `→` `PageDown` `Enter` `↓`             | Next slide                                               |
| `Space`                                | Auto: next slide. Press to speak: hold while you talk    |
| `←` `PageUp` `↑`                       | Previous slide                                           |
| `Home` / `End`                         | First / last slide                                       |
| `Backspace` / `Delete`                 | Remove the phrase being spoken, or the last finished one |
| `Cmd/Ctrl+Z`                           | Bring back the last removed phrase                       |
| `M`                                    | Mute / unmute (Auto only)                                |
| `R`                                    | Mic on / off                                             |
| `Esc`                                  | Stop the preview                                         |

In the editor: `Space` plays and pauses, `←` `→` select the previous or next clip, `Delete` / `Backspace` removes the selected clip, `Cmd/Ctrl+Z` undoes the last change, and `Esc` stops playback, cancels a take, or closes the editor. While a press-to-speak take is recording, `Space` is the talk key.

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

Which encoder does the work follows the **Use the hardware encoder** switch under *This computer* (see [System check and performance mode](#system-check-and-performance-mode)): VideoToolbox, NVENC, QSV or VAAPI when ffmpeg has one and the switch is on, otherwise x264, x265, libvpx or SVT-AV1. The *Smallest file* mode always uses the software encoders, because a hardware encoder makes a larger file at the same quality whatever preset it is given. The plan names the encoder before you start, and the ffmpeg command that ran is kept on the job (`command` in the API) so you can see exactly what happened.

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

## Speed, filler words, transcript and subtitles

The **Enhance** section of the export dialog changes what the video says, not how it is encoded. Everything in it is done in the browser on copies of the phrases before a frame is encoded (the recording itself is never changed), except the transcription, which the local server does with whisper.

### Speed

**Speed** plays the lecture at 1.1×, 1.25×, 1.5×, 1.75× or 2× (or any figure from 0.5× to 3× under *Custom…*). The voice keeps its pitch: the audio is time-stretched by waveform-similarity overlap-add (`packages/client/src/core/stretch.ts`, plain code), which lays 25 ms windows of the recording down at the normal spacing while taking them from the input `speed` times further apart, each one from the spot within a few milliseconds that best continues the window before it, so no pitch period is torn. The pauses between phrases keep their length; only the speech gets faster, and the slides change where the words say they should. An hour of 48 kHz speech takes a few seconds.

### Volume

**Even out the volume from phrase to phrase** brings every phrase's speech level (the loudest fifth of its 50 ms blocks) to −20 dBFS, never more than 18 dB up or 6 dB down and never past the point where a peak would clip. Use it when some phrases were said closer to the microphone than others.

### Filler words

**Cut "um", "uh", "er" and "hmm"** finds hesitations the same way the voice detector finds voices: by arithmetic alone, no model, every rule in `packages/client/src/core/fillers.ts`. A filler is not recognised as a word; it is recognised by its shape, which is much the same in every speaker and language:

1. **It stands apart.** A filler is a hesitation, so there is a real pause, a quarter of a second or so, on at least one side of it and usually both. The brief silence before a "p" or a "t" is far shorter.
2. **It is one long, steady sound.** "Uh" is a neutral vowel held for a quarter of a second or more without the mouth moving: the spectrum of each 32 ms frame (its Fourier transform, read in twenty bands spaced like the ear hears them) hardly changes over 48 ms, where a word's spectrum moves with every consonant.
3. **The vowel is the central one** of "but" and "the": its first two formants, the peaks of the spectrum's envelope, sit near 600 and 1200 Hz, where the vowels of "see", "say" and "saw" peak elsewhere. That is the pattern of a common filler in the transform. An "um" or "hmm" ends in a nasal murmur with its energy under 500 Hz; that tail is part of the same run and goes with it.
4. **The pitch glides, it does not sing.** A filler holds one note or drifts down smoothly; a run of syllables carries the sentence's melody.

Every run of voice between 0.12 and 1.5 s gets a score from 0 to 1 that is the product of those things (and a little extra for being quieter than the rest, as hesitations are). The **sensitivity** picks the score a run needs: *Only the obvious ones* (0.55), *Balanced* (0.35, the default) or *Catch more* (0.2). On synthetic speech from macOS text-to-speech with hesitations spliced in flat and slow, the balanced setting finds half of them with one false alarm in two minutes of ordinary sentences, the strict one a third with none, and the eager one four in five with one word in forty flagged, which is why there is a list. Each line in it has a ▶ to hear the stretch with a little of what is around it, and a tick: untick a line and that stretch stays. What is cut is the run plus most of the pause on either side, so what remains sounds like one ordinary pause; the two sides are joined with an 8 ms fade.

The scan runs once per phrase while the dialog is open (about a hundredth of real time) and is remembered, so changing the sensitivity is instant. The planned length under the summary falls as fillers are found.

### Transcript and subtitles

**Transcribe the speech and add subtitles** sends the original audio (16 kHz mono, half a second of silence between phrases) to the local server, which runs whisper on it and returns every word with its time. Three outputs can be ticked:

- **subtitles drawn into the video**: cues of up to two lines of 42 characters, on screen between one and six seconds, broken at sentence ends, commas and pauses, drawn in white on a soft dark box at the bottom of each frame by the browser's encoder (so they survive any container and any server stage);
- **subtitle files next to the video**: `lecture.srt` and `lecture.vtt` written into the same folder (inside the folder for HLS and DASH) and remembered with the export in the **Exports** list, so deleting the video deletes them too; for *Save in browser* they are offered as downloads;
- **the transcript as a text file**: `lecture.txt`, one paragraph per stretch of speech with the time it starts at. The transcript is also shown under the result.

The words are transcribed from the original recording and carried onto the final timeline afterwards: a word inside a cut filler disappears from the subtitles too, and the times follow the speed. **Language** tells the recogniser what to expect, or *Detect automatically*.

**What it needs.** The server looks for whisper on the PATH at start-up, in this order: `whisper-cli` (whisper.cpp, the fastest), `whisper-cpp`, then `whisper` (the Python openai-whisper). The capabilities line in the export dialog says which it found, and the system check prints it as `Speech`. Nothing is bundled and nothing is downloaded by One Take itself:

| Engine | Install | Model |
| --- | --- | --- |
| whisper.cpp | `brew install whisper-cpp` | a `ggml-*.bin` file in `~/.one-take/models` (or `--whisper-model /path/to/ggml-base.en.bin`); `ggml-base.en.bin` is preferred when several are there |
| openai-whisper | `brew install openai-whisper` | `base.en` by default (`--whisper-model small` to change); whisper downloads it into `~/.cache/whisper` the first time it runs, about 140 MB, and the progress view says so |

Pass `--whisper /path/to/program` to use a particular one. Transcription runs on the CPU at roughly five to twenty times real time depending on the engine and the machine (openai-whisper's `base.en` ran at six times real time on an M2 Max), so an hour of lecture takes a few minutes; the progress view shows it as its own step, *Transcribe on the server*, with the recogniser's own percentage. Everything stays on the machine: the server writes the audio to a temporary file in its data folder, runs the recogniser on it, and deletes it.

This is the one place where One Take leans on a trained model, and it is yours to install or not: without whisper the switch is greyed out and everything else works as before.

## The studio: deep clean and only your voice

The **Sound** section of the export dialog runs the heaviest work of the export on the local server, over the recording as the microphone heard it, before any filter: a phrase keeps two copies, the one the live noise filter cleaned (what you hear while you record) and the raw one, and the studio starts from the raw one. These are trained models that take their time (seconds to minutes; the dialog says how long on this computer), so each is a wait you can skip: untick the switch, or press **Continue without waiting for the studio** while it runs, and what it had finished goes in while the rest plays as it was.

### Setting it up

`npm run studio` makes a Python environment of its own under the server's data folder (`~/.one-take/studio/venv`, about 1.1 GB with PyTorch), fetches the three model checkpoints from Hugging Face (ClearerVoice-Studio's `MossFormer2_SE_48K`, 222 MB; `MossFormer2_SS_16K`, 670 MB; `AV_MossFormer2_TSE_16K`, 735 MB) and the speaker model, and checks that everything imports. It needs `uv` or a Python 3.10 to 3.13; on Apple silicon the models run on the GPU through Metal, on an NVIDIA card through CUDA, otherwise on the CPU. Restart the server afterwards: its start-up line `Studio` and the Sound section both say what was found. Without the environment every switch is greyed out with the reason and the export runs exactly as before. `--studio-python /path/to/python` uses an environment of your own; `--no-studio` skips the check.

### The deep clean

**Deep clean the sound from the raw microphone** runs MossFormer2 (speech enhancement at 48 kHz) over the whole recording: the phrases are sent as one run of audio, in order, so the model hears what the room sounds like over seconds, and the result is cut back into phrases. Unlike the live filter, which hears each frame once and must decide at once, it looks at four seconds at a time with the whole phrase in view. On a synthetic test (a voice over brown noise 8 dB under it) it lifted the voice from 5.6 to 13.5 dB over the noise and took the room-only stretches down to silence; on an M2 Max it runs at about a twentieth of real time, so an hour of lecture takes a few minutes.

### Only your voice

**Keep only your voice where another voice was heard** runs on the phrases the lip and voice checks flagged (*Another voice* or *Not sure whose voice*, see [Who is speaking](#who-is-speaking)) and on any clip you switched to *Only my voice* in the editor:

- When the camera saw your face while the phrase was said, AV-MossFormer2 (audio-visual target speaker extraction) gets the audio and a film of your mouth: 25 grey crops a second, 112 pixels square, cut from the face the lip check already finds and kept with the phrase. The film tells it which voice is yours, so it handles two people talking at once, which audio alone cannot.
- Without a face, MossFormer2 separates the phrase into two voices and the one closer to your voice profile (the same speaker model as the voice check, run on the server with the same features) is kept; without a profile, the louder one. A voice picked this way that is nothing like your profile means you are not in that phrase, and it is left as it was.

Both work at 16 kHz; the result goes back to the recording's rate by adding what the recording has above 8 kHz, scaled frame by frame by how much of the lower band the model kept, so a silenced stretch stays silent up top. The voice step runs after the deep clean when both are on, which is where it does best.

**Check every phrase for a second voice** (off unless you ask) runs the separation over every phrase and flags one where a second voice is active in at least a tenth of it, keeps going for a second, and speaks within 24 dB of yours. It is slow (the separation model over the whole lecture) and the bars are approximate; the flagged list is there to listen and decide.

### The flagged phrases

Under the switches, every phrase the checks flagged is listed the way the filler words are: when it is, how long, what the checks said (the reasons on hover), a ▶ to hear it, and a tick. A ticked phrase goes into the export (with only your voice kept when that switch is on); untick one and it is left out of the video altogether. Nothing is deleted: the phrase is still there in the timeline and the editor.

### Three versions of every clip

In the editor, under the waveform, each clip has a switch: **Original** (the microphone before any filter), **Cleaned** (the live filter's version until the deep clean has run, the deep clean after) and **Only my voice** (once the studio has kept it), each with a ▶ to hear it. The choice is saved with the clip, the preview plays it, the waveform draws it and the export uses it; a change of choice is on the undo stack like any other edit. Two buttons under the switch ask the studio for a version of just that clip, so you can hear the deep clean or the extraction before an export. Re-record, cut, keep, split and Remove pauses work on every version at once (and on the film and the picture), so the versions never drift apart: all of them are the same samples, only cleaned differently.

How the raw copy is kept in step: a second capture node reads the microphone before the filter into a tape, and when a phrase is stored its stretch of the tape is taken a fixed delay earlier (41 ms for the deep filter, 21 ms for the classic one) and nudged by correlation to where it best matches the filtered phrase, so a filter that changed mid-phrase never leaves the two copies out of step. A phrase recorded with the filter off has no separate raw copy; Original plays the recording itself.

### The camera's picture

When the camera was recorded, the **Camera** section can also clean its picture before it is drawn into the frame: **Background** blurs what is behind you or paints it a plain colour (MediaPipe's selfie segmenter tells you from the background, fetched once, 250 kB), and **Picture** evens out the exposure and takes the colour cast out (a stretch of the brightness within two to one, a gamma towards a middle grey, grey-world colour balance within limits, all followed slowly so the picture never flickers). Each frame is cleaned once, as it changes.

### What it costs

The deep clean over an hour takes a few minutes on an Apple GPU and considerably longer on a CPU; keeping a voice costs about a third of real time per flagged phrase. The models take a gigabyte or two of memory while the worker runs; it stops on its own after three minutes of nothing to do. Everything stays on the machine: the audio and the mouth films go to the local server as files in its data folder, are processed there and deleted; the checkpoints were fetched once by `npm run studio`.

## How an export works

### Stage 0: the studio on the server

When the Sound section asks for it, the phrases go to the server first, as the microphone heard them: the deep clean comes back for every phrase, then only your voice for the flagged ones, each result kept with its phrase the moment it lands (*Deep clean on the server*, *Keep only your voice on the server* in the progress view, with a button to continue without waiting). From here on each phrase is the version it is set to.

### Stage 1: the browser encodes

First the phrases are prepared when the **Enhance** section asks for it: fillers cut, volume evened, pace changed (*Prepare the audio* in the progress view), and the transcript is made (*Transcribe on the server*). Then the browser renders the timeline with WebCodecs through [mediabunny](https://github.com/Vanilagy/mediabunny), faster than real time:

1. Slides are drawn on a canvas at the chosen size and frame rate, with the subtitle of the moment on top when subtitles are drawn in. Up to eight slide bitmaps are cached so going back and forth is cheap.
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

### Following an export

Once you press **Export**, the settings give way to a progress view:

- **Time left**, in large type, with a note on where the figure comes from: _from the plan_ before anything has been measured, _settling on the measured speed_ while the first tenth of a stage runs, then _measured over the last few seconds_. Elapsed time, the share done and the bytes written sit beside it, over one bar for the whole export.
- **The steps**: _Deep clean on the server_ and _Keep only your voice on the server_ first when the studio runs, then _Encode in the browser_, then _Compress with ffmpeg_ or _Package as HLS_ on the server when the plan has a server stage, then _Save_. Each shows its own percentage, its time left, and what it is doing right now: frames per second, speed against real time, bytes written, and for ffmpeg its CPU use.
- **This computer, live**: the whole machine's CPU use and memory, polled from the server once a second, plus the browser encoder's figures and the page's heap, so you can see what the export costs while it runs.
- **Cancel export** at any stage; when it finishes, the saved path, its size and how long it took, with _Show in folder_ and _Back to settings_.

The time left does not fall into the usual trap of "1 h 30 min" at the start and "30 s" a minute later. That figure comes from dividing the work left by the average speed since the start, which at the start is dominated by set-up time during which nothing counted as progress. Here the estimate starts from what the plan expected (the resource map), hands over to a speed measured over a sliding window of the last few seconds once a little work has been done, and follows a measured drop quickly but a rise only slowly. The arithmetic lives in `packages/shared/src/eta.ts` and is unit-tested against a simulated one-hour lecture: the first figure is the plan's, and no figure along the way exceeds twice it.

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
- Once the server is up it **races the H.264 encoders** it has (each verified hardware encoder against `libx264 veryfast`) on six seconds of slide-like 1080p video, about a second each, and records the winner. The result is shown under the hardware switch in the export dialog as information; it does not move the switch. On an M2 Max x264 wins: slide video is mostly unchanged blocks, which x264 skips almost for free (910 fps) while the VideoToolbox encoder runs every frame through a fixed pipeline (400 fps). The hardware encoder stays the default all the same, because it leaves the CPU free; untick the switch on such a machine for the quickest export. `--no-benchmark` skips the race.
- Decoding stays on the CPU. The upload is slide video, and software decoding of eleven minutes of it took 1.5 s where `-hwaccel videotoolbox` took 33 s.
- The PowerPoint renderer runs in a worker with a heap limit of half the machine's memory (`--renderer-memory 4096` to change it); a deck that needs more fails with a clear message instead of taking the server down.

**`npm run doctor`** runs the same check without starting the server and prints which process needs which resource for a one-hour 1080p lecture: recording, slide rendering, PowerPoint conversion, and every export stage (browser encode, upload, packaging, compression) with its memory, whether it runs on the GPU or the CPU, and a rough time. `npm run bench` (`doctor --bench`, `--height 2160` for 4K) runs the encoder race in the open, adds `libx264 medium` and `libx265 veryfast` for comparison, and says which encoder is really the fastest on this machine.

**In the browser** the app probes WebCodecs once: which codecs it can encode, for each whether `prefer-hardware` is accepted at 1080p and at 4K and whether `prefer-software` is accepted at all (Chrome has no software HEVC encoder, for instance), plus thread count, visible memory and the GPU name (WebGPU or WebGL). It then races the GPU and the software H.264 encoder on 150 frames of a 1080p slide (about half a second; the answer is kept for a week in `localStorage`). The export dialog's *This computer* section shows both sides.

**The hardware switch.** *Use the hardware encoder when this computer has one* sits under the system line and is on by default. The line under it lists what was found on each side (for example `AVC up to 4K and HEVC up to 4K in Chrome 141; h264_videotoolbox, hevc_videotoolbox in ffmpeg`) and, where the races found the CPU quicker on slide video, says so with the figures.

- **On:** the browser asks WebCodecs for the hardware encoder for every codec and size the probe accepted (an unsupported request fails instead of falling back, so it is never asked blindly), codecs the hardware can take come first when the codec is *Automatic*, and ffmpeg uses `h264_videotoolbox`, `hevc_videotoolbox`, `*_nvenc`, `*_qsv` or `*_vaapi` for compression, transcoding and adaptive ladders. A size the hardware refuses (above 4K on most of them) goes to the CPU with a warning.
- **Off:** the browser asks for the software encoder (`prefer-software`), skips codecs it only has in hardware when the codec is *Automatic* (asked for by name, such a codec is transcoded by ffmpeg on the CPU instead), and ffmpeg uses `libx264`, `libx265`, `libvpx-vp9` or `libsvtav1`.

The switch is a browser preference, like the theme: it applies to every project and is remembered until you change it. A machine without any hardware encoder shows it greyed out. Decoding stays on the CPU in either position (see above: software decoding of slide video is twenty times faster than the GPU path).

**Performance mode** (in the export dialog, saved with the project) picks presets around the switch:

| Mode | Browser stage | Server compression |
| --- | --- | --- |
| **Fastest** (default) | the hardware encoder when the switch is on and the probe accepted it; otherwise the software encoder in `realtime` latency mode | the hardware encoder when the switch is on; otherwise `libx264`/`libx265`, `veryfast` preset |
| **Balanced** | the same encoder choice, browser default latency | the same encoder choice, `medium` preset |
| **Smallest file** | the same encoder choice, `quality` latency | always the software encoders, `slow` preset, `stillimage` tune for x264 (no hardware encoder makes a smaller file) |

The latency choice is measured, not assumed: on an M2 Max the VideoToolbox encoder drops from 374 to 166 fps in `realtime` mode, while Chrome's software H.264 encoder runs at about 400 fps in either, so `realtime` is reserved for software codecs. A mode only sets the starting point; every field stays editable. The *Plan* section then names the encoder each stage will use and lists the resource map for the chosen settings (GPU/CPU/disk per stage, memory, rough time), and warns when the export would take more than 40 % of the machine's memory, when the CPU ends up with a codec the hardware could have taken, or when the job will take over half an hour.

**What else was done, and what it is worth.** Slides are still images, so each slide is captured once and every video frame of that slide is a reference clone with a new timestamp. For a software encoder the capture is a planar I420 frame in CPU memory (`core/yuv.ts`, BT.709, about 30 ms per slide). This matters more than it sounds: a canvas-backed frame is RGBA on the GPU and Chrome converts it again for every `encode()` call, which pinned every encoder, hardware or software, H.264 or VP9, at about 370 fps for 1080p on an M2 Max. With planar frames Chrome's software H.264 encoder reaches 570 fps in a real export (700 fps in a bare encoder loop) while the VideoToolbox encoder stays near 380 fps whatever it is fed (that is its pipeline rate; ffmpeg's `h264_videotoolbox` tops out at the same figure), which is why the race is reported under the hardware switch: on that machine, unticking it gives the quickest export, and leaving it on gives a cooler, idle CPU; a GPU encoder keeps the canvas frame, which is already in its memory. Slide bitmaps are decoded already scaled to the output size, the encode runs on an `OffscreenCanvas`, and the preview reuses one timeline instead of rebuilding it every animation frame. Measured on an M2 Max with Chrome: eleven minutes of 1080p at 15 fps encode in 17 s (38× real time, against 27 s before), so an hour-long lecture exports in about a minute and a half; compression on the server adds about a minute per hour with `libx264 veryfast`. Fewer frames is the one lever that always works: 10 fps is a third faster than 15 and looks the same on slides.

## What counts as speech

The microphone first goes through the noise filter (see [The noise filter](#the-noise-filter) below). Then it is listened to twice: once live, 10 ms at a time, to notice that something which could be a voice is going on, and once more when the phrase is finished, with the whole of it in view, to decide what to keep. The live listen never cuts anything; the second one makes every cut. Both are the same arithmetic.

### The voice detector

The detector (`packages/client/src/core/voice.ts`) is plain signal processing, with no model, nothing trained and no weights, so every rule in it can be read and argued with. `core/speech.ts` low-passes and resamples the microphone to 16 kHz and cuts it into 32 ms frames; the detector looks at each frame together with the one before it (a 64 ms window) and gives it a score from 0 to 1 for "someone is speaking". Three things go into the score, multiplied together:

- **Standing out from the room.** The window's power in eight bands between 100 Hz and 5 kHz is compared with an estimate of the room's noise in each band, the _floor_. A fan, an air conditioner, a hum, hiss, and the gain creeping up under automatic gain control all live in the floor, so they score nothing however loud they are; only sound that is new on top of it counts. The score ramps from 0 at 3 dB over the floor (averaged over the bands) to 1 at 10 dB. Where the floor comes from is the difference between the two listens, below.
- **Being voiced.** A voice is made by the vocal folds opening and closing 50 to 400 times a second, which makes the waveform repeat at that period; noise, typing, breath, a chair or a door have no such repeat. The spectrum between 80 Hz and 1.5 kHz is first flattened (what stands over the floor is divided by its own local envelope), which leaves a voice's harmonics standing as a comb and turns the smooth rumble of a fan into white noise; the result is matched against itself at every lag in the pitch range, and the strongest true peak is the repeat strength, worth 0 at 0.3 and 1 at 0.6. A peak counts fully only when its pitch carries on from the frame next to it, within 15 % or an octave: a voice holds its pitch from one frame to the next, a chance repeat in noise does not. The range reaches down to 50 Hz so that a deep voice, and the creak many speakers drop into at the end of a sentence, are heard as voices.
- **Changing.** Nobody speaks in a sound that holds one level for a second and a half. When the speech-band energy over 1.5 s spans less than 6 dB the score is scaled down, to nothing at 3 dB, which rules out a tone or a hum that happened to switch on and lets the floor absorb it.

The score has a short release (each frame keeps at least 60 % of the one next to it), so one weak frame inside a word does not flicker. Whispering, which has nothing voiced in it, is not heard as a voice, and neither is a fricative such as "s" on its own; the pre-roll, the hangover and the tail around what is heard cover those.

### The first listen, live

The live phrase detector (`packages/client/src/core/vad.ts`) hears each block once and has to answer at once, so it is kept lenient on purpose and never makes a cut. Its floor is a running estimate: it falls at once when the room goes quieter, rises only after half a second with nothing that could be a voice in it, and is never left under the quietest the room has been in the last two seconds, so a sound that switches on and stays on becomes the room's new noise within two seconds. A block is _heard_ when the score says it could be a voice (0.35 to open a phrase, and only 0.15 to keep one open) and, until the phrase has started, the level is over the speech line. A phrase opens after 30 ms heard and keeps 200 ms of pre-roll from before that, so the first syllable is never clipped. It stays open through anything that scores 0.15 or more, which a soft aside, a sentence trailing off or a low creaky ending does, and ends only after two seconds (or _Phrase ends after_, whichever is longer) with nothing voice-like at all, of which 150 ms is kept. A loud sound that is not a voice (typing, a breath, a chair, a fan, a door) does not open a phrase, and a faint voice under the line does not either. (The live detector can also run on the level alone, with the line held above the noise floor; the app never does that, but the unit tests drive it that way.)

### The second listen, with hindsight

When a phrase is finished it goes through `packages/client/src/core/hindsight.ts` before it is stored. The same three things are measured, by the same arithmetic, but every frame is judged knowing what came before and after it:

- **The floor is the quietest the room has been within two seconds either side** of the frame. The live floor can only look back, and has to rise during a long quiet stretch to absorb a fan that switched on; a quiet voice looks like a long quiet stretch to it, so the live floor can climb into a soft sentence until the sentence stands over nothing, which is how a sentence spoken softly used to get cut. With hindsight the floor under a soft sentence is the gap before or after it, so the sentence stands over the room however softly it was said.
- **A pitch counts as carried when it continues from the frame before or into the frame after**, so the first voiced frame of every word, which live can only be halved (there is nothing before it to carry from), counts in full.
- **Steadiness is measured around a frame**, not behind it, and a weak frame is lifted by the frames on either side of it, not only by the one before.

The scores then go through the rules in `packages/client/src/core/silence.ts`: a stretch of voice begins at a frame scored 0.5 and goes on while the score stays over 0.35; it is padded with the pre-roll in front and the tail behind; a pause longer than _Phrase ends after_ between two stretches is cut, splitting the phrase in two; a stretch shorter than the minimum phrase is dropped; a phrase with no voice in it at all (a chair, typing, a fan switching on) is dropped altogether; and a sliver of silence of up to 0.3 s at either end is left alone. A sentence split across slides stays joined as long as nothing was cut at the seam. The second listen gets through a minute of audio in well under a second, so a phrase shows up in the timeline a moment after it ends; phrases are stored in the order they were spoken however long each takes, and `Backspace` while one is still being gone over drops it.

On the test fixtures (macOS text-to-speech, `packages/client/test/hindsight.test.ts`) the second listen keeps every word of a woman's voice, a man's voice and a deep voice with a 58 Hz pitch (which the old live detector, with its pitch floor at 70 Hz, cut to a sixth); keeps a sentence that drops 25 dB in the middle, and one 20 dB softer standing on its own between two pauses (both lost before); keeps 90 % or more of the words through a fan 10 dB under the voice; and finds no phrase in a fan, a humming fan, hiss, typing, a tone, a fan switching on or swelling, or gain creeping up 20 dB over ten seconds.

| Setting                                  | Default  | What it does                                                                                              |
| ---------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| Speech line (threshold)                  | −45 dBFS | Sound under this never opens a phrase, however voice-like.                                                |
| Phrase ends after                        | 0.7 s    | A pause this long is cut by the second listen, splitting the phrase. Shorter pauses stay in the recording. |
| Pause between phrases                    | 0.15 s   | Silence inserted between phrases in the video. Plus 0.25 s on a slide change.                             |
| Pre-roll (fixed)                         | 200 ms   | Audio from before the trigger that is kept, so the first syllable is never clipped.                       |
| Tail (fixed)                             | 150 ms   | How much of the trailing silence is kept.                                                                 |
| Minimum phrase (fixed)                   | 200 ms   | Bursts shorter than this (a click, a cough) are dropped.                                                  |
| Live hold (fixed)                        | 2 s      | How long a live phrase stays open with nothing voice-like heard before it is finished and gone over.      |

How it decides:

- A phrase starts after 30 ms (three blocks) heard.
- Changing slides mid-phrase splits it. The part spoken so far is stored on the old slide and the rest continues on the new slide, joined without a gap, as long as the second listen cut nothing at the seam. A continuation is kept however short it is, as long as something was said on the new slide; a slide skipped past mid-sentence, or a change that lands right at the end of a sentence, stores nothing.
- Muting, stopping the mic, previewing, exporting, switching modes and (in Press to speak) letting go of the key end the current phrase.
- Opening the microphone takes a moment. A stop that arrives while it is still opening wins (the stream is released the moment it arrives), a second start joins the one in progress instead of racing it, and a held `R` or `M` key does not toggle on auto-repeat.

The detector has a gate. The recorder (`packages/client/src/core/recorder.ts`) opens it when the mic may be heard: in Auto whenever the mic is on and not muted, in Press to speak only while the key or button is held, and never during a preview or an export. While the gate is closed the detector only feeds the level meter; it keeps nothing, not even pre-roll, so a phrase can never begin with sound from before a press or from a muted stretch. Inside an open gate both modes behave the same: pre-roll, hold, tail and the second listen all apply, which is why a press is trimmed at both ends and a long pause inside a press is still cut.

The microphone is opened in mono with echo cancellation, Chrome's own noise suppression and automatic gain control turned on. Capture runs in an AudioWorklet, with a ScriptProcessor fallback for browsers that lack it.

### The noise filter

The **Noise filter** list under the level meter has three choices, and whichever runs does so on the audio thread, before the voice detector, the recorder or the voice check hears anything:

- **Deep** (the default): DeepFilterNet3, a trained model that takes out fans, typing, traffic, music and other people talking, at the full 48 kHz band. It is the `libDF` runtime compiled to WebAssembly, in its own AudioWorklet, from the `@workadventure/noise-suppression` package (the model and the runtime, 22 MB, are served with the app; nothing is fetched elsewhere). The app's audio context runs at 48 kHz for it. It may take out up to 40 dB (`audio/deepfilter.ts`); unlimited attenuation silences the room between words, which sounds like dropouts. It adds about 40 ms of delay, costs a few per cent of one core on a recent laptop, and while it loads (a moment, the first time) the classic filter stands in. Chrome's own noise suppression is turned off under it, so the two do not fight. The worklet measures its own cost; when it spends more than 60 % of real time over two windows in a row, the machine cannot keep up, the classic filter takes over for the rest of the session and a message says so.
- **Classic**: the filter below, plain signal processing, for steady noise only.
- **Off**: nothing beyond what Chrome does on its own.

The classic filter, `packages/client/src/core/denoise.ts`, is like the detector: no model, nothing trained, every number a rule. The sound is cut into 21 ms frames that overlap by half, each frame is turned into its spectrum (bins about 47 Hz wide), and every bin of every frame goes through three steps:

- **Learning the room.** Each bin keeps a _floor_, its estimate of the noise there. For the first half second the floor is simply the average so far (nobody is speaking yet). After that the bin's power, smoothed over its neighbours and over frames, is compared with the quietest it has been in the last second or two; a bin that stands more than 7 dB over that is judged to hold a voice and its floor stays put, otherwise the floor follows the power. A fan, a hum or hiss hold their level, so they are the quietest the bin has been and become the floor within a second or two of switching on; a voice keeps changing and never does.
- **Judging what stands over it.** The _measured_ ratio is how far the frame's power stands over the floor. The _believed_ ratio, what is taken to be voice on top of the floor, comes mostly (98 %) from what the filter kept of the previous frame and only a little from this one (the decision-directed rule). That memory is what stops the result from twinkling: a bin that stood out for one frame by chance is not believed, a harmonic a voice keeps going for a few frames is.
- **Scaling the bin.** The two ratios give the bin's gain through the Ephraim-Malah log-spectral amplitude estimator: the gain with the least expected error in the log of the amplitude, the scale that matches how loudness is heard. A bin believed to be all noise goes down to the gain floor, 24 dB; a bin believed to be all voice is left alone. Nothing is ever scaled under the floor, so what is left of the room sounds like a quieter room rather than a flutter of tones.

The frames are put back together through windows that add up to one, so a clean voice comes out as it went in, 21 ms later. On the test fixtures a fan, a humming fan, hiss or white noise drops by about 20 dB from the first second, a clean voice comes through within a decibel of itself, a fan that switches on mid-recording is absorbed within three seconds, and the voice detector hears more of a voice through a fan than it did before (at 5 dB of fan under the voice, two thirds of the loud frames instead of a third). The classic filter cannot take out sounds that keep changing, such as a voice from the next room, music or typing, because they never become the floor; that is what the deep one is for. It takes about a millisecond per second of audio, and the choice takes effect without reopening the microphone.

A headset or USB microphone gives the cleanest cut. Mute (`M`) when you need to talk to someone in the room.

**Remove pauses** in the editor applies the second listen to clips that are already recorded (`packages/client/src/core/silence.ts`): every clip is scored from start to end with hindsight, the stretches with a voice are padded with the pre-roll and the tail, a pause longer than _Phrase ends after_ splits the clip, a stretch of voice shorter than the minimum phrase is dropped, and a clip with no voice at all is removed. Silence of up to 0.3 s at either end of a clip is left alone, since that is what a phrase keeps on purpose. A clip that continued a split sentence stays joined to it unless the cut reached the seam. The editor's own **Record** goes through the same two listens as the main recording.

## Who is speaking

Two checks run while you record, and together they say, for every phrase, whether it was you. A phrase that was someone else gets an **Another voice** badge in the timeline, within a second of the phrase ending, and the reasons sit in the badge's tooltip; a phrase the two checks disagree on gets **Not sure whose voice**. Your own phrases get no badge, only the reasons on hover. The verdict is stored with the phrase, so it is still there after a reload, and it changes nothing by itself: delete the phrase with its ✕, or keep it.

### The lip check

With a camera chosen in the **Camera** list (the default is the default camera), its picture goes to MediaPipe's Face Landmarker in a worker (`packages/client/src/vision/lips.ts`, `workers/lips.worker.ts`): up to twenty times a second it finds 478 points on your face, and four of them are read (`core/lips.ts`): the inside edges of the upper and lower lip, and the two corners of the mouth. The gap between the lips over the width of the mouth is how open your mouth is, a number that does not change when you lean towards the camera or away from it: about 0 shut, 0.5 for an open "ah". Each frame becomes a sample with the time it was seen. When a phrase has been stored, the samples inside its span are looked at together: the swing of the opening (the gap between its 10th and 90th percentiles) and how much it moved from frame to frame. A swing of 5 % of the mouth's width, or a mean move of 2 % per frame, means your lips were moving; less means they were still. With no face in view for most of the phrase, or fewer than six frames, the camera has nothing to say. The frames are matched to the phrase by the time they reached the page, allowing for the filter's delay, which is why a phrase is judged over its whole span and never over a split second. The small mirror in the corner of the stage shows what the camera sees and whether a face is in view; the picture never leaves the page.

### The voice check

The first time you start the mic, you read for twenty seconds. The stretches the voice detector hears a voice in are cut into windows of four seconds, every two seconds, each window goes through a speaker-embedding model, and the mean of the vectors is your **voice profile**: 256 numbers that say what your voice sounds like and, as far as the model can manage, nothing about what you said. The model is WeSpeaker's ResNet34 trained on VoxCeleb, the ONNX file that sherpa-onnx publishes, run by onnxruntime-web's WebAssembly backend in a worker (`packages/client/src/speaker/voice-check.ts`, `workers/speaker.worker.ts`). It is fed Kaldi's 80-band log mel filterbank with each band's mean over the clip taken out (`core/fbank.ts`, matched number for number against kaldi-native-fbank), which is what makes the vector deaf to the microphone's colour and the level. At least eight seconds of voice have to come through for a profile; the enrollment says so and offers to go again when they do not.

While a phrase is being spoken, its audio (after the noise filter) goes to the worker as it comes, and is embedded window by window as the windows become due, so that when the phrase ends only the tail is left to do: the voice check's answer lands a few hundred milliseconds after the phrase, however long the phrase was. The phrase's vector is the mean of its windows', and it is compared with the profile by the cosine between the two: 1 for the same direction, 0 for unrelated. On the model's own test speakers the same voice scores 0.5 to 0.9 and another voice at most 0.4 (median 0.14), and on macOS's text-to-speech voices the same voice scores 0.87 or more and another one 0.63 at most; the bars are **0.5 and above is you**, **0.35 and below is another voice**, and between the two is doubt (`core/speaker.ts`). A phrase with less than 0.8 s of voice is not judged by the voice check.

### The verdict

`core/identity.ts` reads the pair off a table:

| Voice says \ lips say | moving  | still   | no face in view | camera off |
| --------------------- | ------- | ------- | --------------- | ---------- |
| you                   | you     | not sure | you            | you        |
| another voice         | not sure | another | another        | another    |
| in doubt              | you     | another | not sure        | not sure   |
| no profile            | you     | another | (no verdict)    | (no verdict) |

When the two agree, that is the verdict. When one has nothing to say, the other decides, a voice in doubt by itself staying in doubt. When they disagree (a voice unlike yours while your lips moved, or your voice over still lips), neither is trusted alone and the phrase is marked as not sure, with both reasons, so you can listen and decide. A phrase split by a slide change is judged piece by piece against the camera, with the voice check's one answer for the whole phrase.

### What it needs, and what it costs

- **Chrome or Edge** for the lip check (`MediaStreamTrackProcessor` hands the camera's frames to the worker). The voice check and the deep filter run wherever AudioWorklet and WebAssembly do.
- **Three models.** DeepFilterNet3 (8 MB) and its runtime (15 MB) come with the app. The speaker model (25 MB) and the face model (4 MB) are fetched once: `npm run models` puts them in `packages/client/public/models` for the app to serve, and a client without them fetches each from its publisher the first time it is needed, says so, checks it against its SHA-256 and keeps it in the browser's cache storage, so a machine is only ever asked once. Nothing is ever uploaded.
- **Time.** The face model answers in a few milliseconds a frame on the GPU; the speaker model takes about 70 ms per second of speech on one CPU thread in Python and a few times that in WebAssembly, which the windows hide. In the headless check on an M2 Max every verdict landed 125 to 550 ms after the phrase ended.
- **What it cannot do.** The checks tell your voice from a different one; a voice very like yours, or your own voice played back from a speaker, can pass. A face turned well away from the camera, or in the dark, is "no face in view", and the voice check decides alone. The voice profile is made once; if your voice changes a lot (a cold, a different microphone, a different room), click **Learn my voice** and read again.

## Saving your work and resuming

Everything is written to IndexedDB (database `one-take`) the moment it exists:

- the slide source (the PDF or the image files), so slides can be re-rendered,
- every phrase as 16-bit PCM with its slide index, sample rate and whether it continues the previous phrase (an edit writes the changed phrases back the moment it is made), and, when the camera was on, its picture as the encoded frames the camera produced (about 4 MB a minute),
- the project state: phrase order, current slide, your detector settings and the last export settings.

The recording mode (Auto or Press to speak), the theme, the tips setting, the microphone, the noise filter, the camera switch, which camera, where its picture goes and how big it is, and the hardware encoder switch are browser preferences, kept in `localStorage` rather than with the project. The list of exported videos lives on the server side (see [Where files go](#where-files-go)).

Reload the tab or close it and come back, and you continue where you left off. The **×** after the deck's name clears all of it. If IndexedDB is unavailable (some private windows), the app still works but nothing is persisted; a warning goes to the console.

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
| `--data-dir`          | `ONE_TAKE_DATA_DIR`     | `~/.one-take`          | Where the server keeps its list of finished exports (`exports.json`), its temporary files and whisper.cpp models (`models/`). |
| `--whisper`           | `ONE_TAKE_WHISPER`      | found on `PATH`        | The whisper program for transcripts: `whisper-cli` (whisper.cpp) or `whisper` (openai-whisper).         |
| `--whisper-model`     | `ONE_TAKE_WHISPER_MODEL` | `base.en` / first `ggml-*.bin` found | A model name for openai-whisper, a `ggml-*.bin` file for whisper.cpp.                    |
| `--studio-python`     | `ONE_TAKE_STUDIO_PYTHON` | `<data dir>/studio/venv/bin/python` | A Python with the studio's packages (ClearerVoice-Studio), instead of the environment `npm run studio` makes. |
| `--no-studio`         | `ONE_TAKE_STUDIO=0`     | off                    | Skip the studio check at start-up; its switches stay greyed out.                                        |
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

Jobs live in memory. The last 50 finished jobs stay in the job list; a server restart forgets in-flight uploads, and the client tells you to export again.

Subtitle and transcript files asked for in the export dialog are written next to the result with its name (`lecture (2).srt` for `lecture (2).mp4`; inside the folder for HLS and DASH) once it is done.

Finished exports are also written to `exports.json` in the data folder (`~/.one-take` by default; `--data-dir` to change it): path, size, format, duration, codecs, the ffmpeg encoder that made each one, and its subtitle files. That file feeds the **Exports** list in the app and survives restarts; the videos themselves stay where they were saved. Deleting from the list removes the file (or the HLS/DASH folder, provided it still holds nothing but the export) and the entry; an entry whose file has gone can be dropped on its own. The file is written whole and renamed into place, and a damaged one is set aside rather than stopping the server.

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
| `GET`    | `/api/system/load`            | How busy the machine is right now: whole-machine CPU use since the previous call, memory, and the server process. The export view polls it once a second. |
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
| `GET`    | `/api/library`                | Every export the server has finished, newest first, with whether each is still on disk and its size now. |
| `GET`    | `/api/library/:id`            | One export record.                                                                               |
| `GET`    | `/api/library/:id/file`       | The video itself, with `Range` support, for the in-app player. `409 not_a_file` for HLS and DASH folders. |
| `POST`   | `/api/library/:id/reveal`     | Opens the file manager at the export.                                                            |
| `POST`   | `/api/library/:id/open`       | Opens the export with the default application (the video player, or the folder).                 |
| `DELETE` | `/api/library/:id`            | Deletes the file or export folder (and its subtitle files) and forgets the record; `?files=0` only forgets it. Returns `{ record, deleted }`. |
| `POST`   | `/api/transcribe?language=en&duration=5400` | 16 kHz mono WAV as `application/octet-stream`; answers `201` with a running transcription job. `language` is a code or `auto`. |
| `POST`   | `/api/studio`                       | A studio job from its manifest (the clips, what each needs, the voice profile); answers `201` with the job, waiting for its uploads. |
| `PUT`    | `/api/studio/:id/audio`             | Every clip's 16-bit PCM in order, as `application/octet-stream`.                                     |
| `PUT`    | `/api/studio/:id/faces`             | Every clip's mouth crops (JPEG frames, each after its little-endian uint32 length), in order.        |
| `POST`   | `/api/studio/:id/start`             | Checks the uploads against the manifest and queues the work.                                         |
| `GET`    | `/api/studio/:id`                   | The job: state, progress, each clip's result and figures.                                            |
| `GET`    | `/api/studio/:id/events`            | Server-sent events for the job until it finishes.                                                    |
| `GET`    | `/api/studio/:id/clips/:clip/deep`  | A clip's deep clean (or `/voice`), as 16-bit PCM at the clip's rate, once the job says it is there.  |
| `DELETE` | `/api/studio/:id`                   | Stops the job; results already finished stay fetchable.                                              |
| `GET`    | `/api/transcribe/:id`         | The job: `state`, `progress` (0..1), `message`, and when done `words` (`[{ text, start, end }]`, seconds into the audio sent) and `language`. |
| `GET`    | `/api/transcribe/:id/events`  | Server-sent events with the job as it changes.                                                   |
| `DELETE` | `/api/transcribe/:id`         | Cancels it.                                                                                      |

### Export job lifecycle

```
POST /api/exports ──▶ uploading ──▶ processing ──▶ done
                         │              │
                         └──────────────┴──────▶ failed / cancelled
```

While `uploading`, the progress stage is `upload` and the percent is bytes received against the estimate. While `processing`, the stage is `process` with ffmpeg's percent, speed (relative to real time), seconds of output so far (`outTimeSec`), frames per second, bytes written, and, about once a second, the ffmpeg process's CPU use and resident memory (`process`), then `finalize` while the result is moved into place. A job without ffmpeg work goes straight from `uploading` to `finalize`.

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

`sidecars` is optional: `[{ "extension": "srt" | "vtt" | "txt", "content": "…" }]`, each written next to the result when the job is done and listed in the job's `sidecars`. `processing` is `null` when the server should store the upload as is. For a re-encode, `video` is `{ "mode": "encode", "codec": "h264", "crf": 23, "preset": "medium", "tune": "stillimage", "fps": null, "height": null, "maxBitrateKbps": null, "keyFrameIntervalSec": 4, "hardware": false }` and `audio` is `{ "mode": "encode", "codec": "aac", "bitrateKbps": 96 }`. `ladder` is a list of `{ name, height, videoBitrateKbps, audioBitrateKbps }` for adaptive output.

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

When the job is `done`, `outputs` holds `[{ path, kind: "file" | "directory", bytes }]`, and the export is added to the library:

```json
{
  "id": "6c1f…",
  "createdAt": "2026-10-08T12:04:10.000Z",
  "path": "/Users/you/Movies/One Take/lecture.mp4",
  "directory": "/Users/you/Movies/One Take",
  "fileName": "lecture.mp4",
  "kind": "file",
  "container": "mp4",
  "bytes": 215043112,
  "exists": true,
  "durationSec": 5400,
  "width": 1920,
  "height": 1080,
  "fps": 15,
  "videoCodec": "avc",
  "audioCodec": "aac",
  "encoder": null,
  "command": "ffmpeg -hide_banner … -movflags +faststart -f mp4 lecture.6c1f0a2b.processing.mp4"
}
```

`encoder` names the ffmpeg video encoder when the server re-encoded (`libx264`, `h264_videotoolbox`); it is `null` for a stream copy. `exists` and `bytes` are read from disk every time the list is asked for.

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
| 404    | `export_not_found`        | The export is not in the library (already deleted or forgotten).      |
| 404    | `transcription_not_found` | Unknown transcription job, usually because the server restarted.      |
| 400    | `studio_unavailable`    | The studio is not set up on the server, or the model a job needs is missing. |
| 404    | `studio_not_found`      | Unknown studio job, usually because the server restarted.             |
| 409    | `studio_started`        | An upload for a studio job that has already started.                  |
| 409    | `studio_not_ready`      | A clip's result that is not there yet.                                |
| 400    | `transcription_unavailable` | No whisper on the server, or whisper.cpp without a model.           |
| 404    | `not_found`               | No such route.                                                        |
| 409    | `not_uploading`           | Data or finish arrived for a job that is no longer uploading.         |
| 409    | `no_output`               | Reveal was asked for a job that has no result yet.                    |
| 409    | `file_missing`            | The library entry's file is no longer where it was saved.             |
| 409    | `not_a_file`              | The in-app player asked for an HLS or DASH folder.                    |
| 409    | `folder_not_empty`        | Deleting an export folder that has gained files One Take did not make. |
| 500    | `internal`, `reveal_failed`, `too_many_files` | Something went wrong on the server.               |

## Project layout

npm workspaces with TypeScript project references. `shared` is built first; `server` and `client` depend on it.

```
one-take/
├── package.json              scripts, workspaces, dev tooling
├── tsconfig.base.json        strict compiler options shared by every package
├── eslint.config.js          typescript-eslint strictTypeChecked + stylisticTypeChecked, import order
├── vitest.config.ts          three test projects: shared, server, client
├── scripts/fetch-models.mjs  `npm run models`: fetches the speaker and face models into the client's public folder
├── scripts/setup-studio.mjs  `npm run studio`: the studio's Python environment and its model checkpoints
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
    │   └── src/
    │       ├── index.ts          entry: config, system check, ffmpeg detection, start, graceful shutdown
    │       ├── doctor.ts         `npm run doctor` / `npm run bench`: system check and encoder race without the server
    │       ├── config.ts         flags and environment variables
    │       ├── app.ts            app factory: loopback checks, error handler, static client, routes
    │       ├── routes/           capabilities and system, fs, convert (.pptx → PDF), exports (chunk upload, finish, SSE, cancel, reveal), library (list, stream, reveal, open, delete), transcribe (WAV in, words out)
    │       ├── services/
    │       │   ├── jobs.ts       JobManager: positioned writes, finish, process, cancel, cleanup
    │       │   ├── ffmpeg.ts     detection, pure buildFfmpegArgs(), progress parsing, runFfmpeg()
    │       │   ├── library.ts    ExportLibrary: finished exports in exports.json, read back with what the disk says now, deleted safely
│       │   ├── transcribe.ts detectTranscription() (whisper-cli or openai-whisper on the PATH), TranscriptionManager (runs it, parses its progress and JSON)
│       │   ├── studio.ts     detectStudio() (the Python environment and the models), StudioWorker (the long-lived worker process), StudioManager (jobs: uploads cut into clips, the deep clean as one recording, each voice from the cleaned audio)
│       ├── py/studio.py      the studio worker: ClearerVoice's models over JSON lines (the deep clean, a voice by its face or by the profile, the band merge back to 48 kHz, the second-voice measure)
│       │   ├── filesystem.ts listing, mkdir, free space, unique names, shortcuts, the "only our files" folder check
    │       │   ├── system.ts     detectSystem(): CPU/RAM/GPU/disk, hardware encoder self-tests, benchmarkEncoders()
    │       │   ├── load.ts       LoadMonitor: live CPU and memory for /api/system/load, ffmpeg process sampling
    │       │   ├── convert.ts    PptxConverter: runs the renderer in a worker thread with a heap limit
    │       │   └── pptx/         PowerPoint → PDF: html (text runs → paragraphs), layout (line breaking), fonts, geometry, render (pdfkit), worker
    │       └── util/             errors.ts (ApiError with stable codes), semaphore.ts (limits concurrent re-encodes), desktop.ts (reveal in the file manager, open with the default app)
    ├── client/               Vite + TypeScript app, no framework
    │   └── src/
    │       ├── main.ts           boot; exposes window.__onetake test hooks
    │       ├── app/              App controller, Store (state + event bus), types and defaults
    │       ├── audio/            the shared AudioContext (48 kHz), MicCapture (source → DeepFilterNet3 → capture worklet, or the classic filter), deepfilter.ts (the deep noise filter's node), capture processor, preview playback (seekable), take recording for the editor (with the camera when it is on)
    │       ├── video/            camera.ts (CameraCapture: the live camera, frames encoded with WebCodecs on the microphone's block clock, a phrase's stretch cut out on request), reader.ts (ClipReader: a clip's pieces decoded in order for the export and the preview)
    │       ├── core/             voice.ts (the voice detector: frame maths, live floor, pitch repeat, steadiness), hindsight.ts (the second listen: a finished clip scored with the whole of it in view), denoise.ts (the classic noise filter), fbank.ts (Kaldi's log mel filterbank for the speaker model), speaker.ts (the voice check's arithmetic: cosine, mean vector, the bars, the windows), lips.ts (mouth opening from landmarks, lip activity over a span), identity.ts (the verdict table and its reasons), fillers.ts (the filler-word detector: pauses, steadiness, formants, pitch glide), stretch.ts (time-stretch without pitch change), captions.ts (words → cues, SRT / VTT / transcript writers), fft.ts and biquad.ts, speech.ts (scoring the mic and clips: downsampler, frames), VoiceActivityDetector (vad.ts: lenient live phrases from scores and levels), silence.ts (the cuts: ranges from scores, a verdict for a phrase, removing pauses after the fact), Recorder (auto / press to speak, the review queue), timeline builder, edit.ts (cut, split, replace, insert; the picture follows), clip-video.ts (a phrase's camera picture as pieces of encoded frames: slicing, joining, speed), overlay.ts (where the picture sits on the slide: corners, anywhere, size), PCM helpers, I420 slide frames (yuv.ts)
    │       ├── slides/           PDF (pdf.js) and image rasterisation, natural sort
    │       ├── storage/          IndexedDB project store (idb), prefs (localStorage), the voice profile
    │       ├── models/           fetch.ts: a model's bytes from /models, the cache storage or its publisher, checked
    │       ├── speaker/          voice-check.ts: the speaker model in its worker, fed each live phrase, compared with the profile
    │       ├── vision/           lips.ts: the camera into the lip worker, the samples kept for each phrase's span
    │       ├── workers/          speaker.worker.ts (onnxruntime-web, windows of a phrase), lips.worker.ts (MediaPipe Face Landmarker on the camera's frames)
    │       ├── export/           capabilities, prepare (fillers cut, volume, speed, the audio for the recogniser, word times onto the final timeline), encoder (mediabunny, subtitles and the camera picture drawn in), overlay (which camera frame goes with each moment of the timeline), sinks (server / file / memory), runner (prepare, transcribe, encode, finish), real-time fallback
    │       ├── api/              typed client for the server API with SSE and polling
    │       ├── ui/               layout, cam-stage (the camera picture over the slide: live or played back, drag to move, handle to resize), editor, export dialog, exports list (library.ts), folder picker, film strip, timeline list (with the voice badges), meter, enroll (the voice enrollment), keyboard, toast, icon (grauity icons + the Newton School mark)
    │       └── styles/           theme.css (Mona Sans, token aliases), grauity.css (grauity components in plain CSS), app.css (layout)
    │   └── public/fonts/         Mona Sans (variable weight, OFL); public/models/ holds the fetched models (not in git)
    └── e2e/                  end-to-end runner (no test framework, no dependencies)
        └── src/
            ├── run.ts            boots server + headless Chrome, records in both modes, exports, probes with ffprobe
            ├── stress.ts         talks through the app for minutes or hours, checking phrases, timelines, heap, resume and export
            ├── camera.ts         the camera with a fake device: placement, size, dragging, a picture on every phrase, the export frame, the editor, the reload
            ├── harness.ts        shared: server and Chrome start-up, a page over the DevTools Protocol, real key and mouse input
            ├── cdp.ts            minimal Chrome DevTools Protocol client on Node's WebSocket
            └── make-fixtures.ts  writes the PDFs, the PowerPoint deck and the WAVs of speech (macOS text-to-speech) with pauses, typing and clicks
```

Dependencies are few on purpose. Client: `mediabunny` (muxing and WebCodecs), `pdfjs-dist` (PDF rendering), `idb` (IndexedDB), `@newtonschool/grauity` (design tokens and the icon font; only its CSS is bundled, the React components are not used), `@workadventure/noise-suppression` (DeepFilterNet3 as WebAssembly in an AudioWorklet; only its `deepfilternet` entry is used), `onnxruntime-web` (runs the speaker model, WebAssembly backend only), `@mediapipe/tasks-vision` (the Face Landmarker). Server: `fastify`, `@fastify/static`, `zod`, `pptxtojson` (reads PowerPoint files), `pdfkit` (draws the PDF). Shared: `zod`.

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
| `npm run e2e:stress`   | Builds, then talks through the app in headless Chrome for minutes or hours, checking as it goes. See below. |
| `npm run check`        | Typecheck, lint, format check and unit tests. Run this before you commit.                                  |
| `npm run doctor`       | System check and resource map for a one-hour 1080p lecture, without starting the server.                    |
| `npm run bench`        | `doctor --bench`: races the H.264 encoders on this machine (`--height 2160` for 4K).                        |
| `npm run models`       | Fetches the speaker model and the face model (29 MB) into `packages/client/public/models`, checking each against its SHA-256. Optional: a client without them fetches them itself on first use. |
| `npm run studio`       | Makes the studio's Python environment under the server's data folder and fetches its models (about 1.7 GB of checkpoints plus PyTorch); run once, then restart the server. |
| `npm run e2e:studio`   | Builds, then checks the studio and the clip versions in headless Chrome: the raw copy in step with the filtered one, the editor's switch, an export with the deep clean and the voice step, the skip. Where this machine has no studio it checks the greyed-out state. |

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
- `client`: the live phrase detector (with scores and without them), the voice detector (`test/voice.test.ts`: two spoken fixtures, clean and with a fan, a humming fan or white noise 10 dB under the voice; a fan, hiss, typing, a tone, a fan switching on, a fan swelling and fading, gain creeping up and silence; and the live path from 48 kHz blocks through the second listen to phrases), the second listen (`test/hindsight.test.ts`: a woman, a man and a 58 Hz deep voice heard through, a sentence that drops 25 dB in the middle and a soft sentence on its own kept, the voices through a fan, nothing in the sounds of a room or in a fan, hum or tone switching on, the cut verdict on a phrase, and the whole live path), the noise filter (`test/denoise.test.ts`: a clean voice through within a decibel, a fan taken out from under a voice at 10 and 5 dB with the detector hearing more of the voice, the room alone quietened by 20 dB and never heard as a voice over many noise seeds, a fan switching on absorbed, typing only dulled, the same samples whatever the block size, the one-frame delay, and the live path from 48 kHz blocks through the filter to phrases), the scoring plumbing (`test/speech.test.ts`: the downsampler, the microphone scorer and the clip scorer), the pause remover (`test/silence.test.ts`), the recorder (auto and press to speak: the gate, the key, splits, mutes, pauses, and the review queue: cuts, drops, order, failures, discards, joins across slides that survive or break with the cut), the timeline builder, the editor's edit functions (cutting and keeping a stretch, splitting, replacing and inserting clips, which clip is under a time, waveform peaks), the PCM helpers (these are pure, so they run in Node), the filterbank (`test/fbank.test.ts`: frames against kaldi-native-fbank on three spoken fixtures, edges included), the speaker arithmetic and, when `npm run models` has run, the real model through onnxruntime-web (`test/speaker.test.ts`: the embeddings against a Python reference, the two fixture voices told apart, a voice recognised from its windows and from a 2 s crop), the lip maths (`test/lips.test.ts`: a talking mouth, a shut one through the landmarks' jitter, spans, missing faces) and the verdict table (`test/identity.test.ts`), plus a long-session stress simulation (`test/stress.test.ts`). The simulation drives four virtual hours of speaking through the recorder in a few seconds: thousands of phrases, slides going back and forth with hundreds of changes mid-sentence, auto and press to speak alternating, holds with human reaction times, mutes, preview pauses, coughs, discards, a twenty-minute sentence held the whole time, and an hour of random chaos. Every 10 ms block carries its position, so each phrase is checked exactly: consecutive blocks, all heard with the gate open, none shared, on the slide that was showing, no more than the pre-roll in front and the tail behind; the total kept is bounded by the speech fed; the timeline built from the result is consistent in both orders.

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
4. loads the slides, skips the voice enrollment it is offered at the first mic start (which turns the voice check off and is remembered), checks that DeepFilterNet3 is the filter running and that the lip check watches the fake camera, records with a slide change mid-sentence, and checks that four phrases exist and one continues across slides,
4. switches to Press to speak and, with real key and mouse events, checks that speech with the key up records nothing, that holding `Space` (auto-repeat included) records exactly one press with a slide change inside it as two joined parts, that the stage button works with the mouse, that `Space` never changes slides in that mode and does again in Auto, and that the mode is remembered,
5. exports MP4 (checks faststart, 5 fps and AAC), HLS by stream copy at 480p with 2 s segments (checks the playlist, the init segment, the segment count and H.264), DASH with compression (checks that the ffmpeg command carried CRF 30 and the `stillimage` tune), WebM (checks no ffmpeg was needed), a compressed HEVC file (checks it is smaller than the MP4) and an in-memory MP4 saved in the browser, probing each with ffprobe,
6. reloads the page, checks the project resumed, and plays the preview.

Set `CHROME` to the path of your Chrome binary if it is not at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. `--keep` leaves the output folder in place for inspection.

Neither runner can wait forever. Every call into the browser has a deadline (60 s by default, longer for exports) and each script arms a watchdog for the whole run; when either fires, the script prints the stage it was in, the page's console and a last screenshot (`stall.png`), and exits with a failure. Keys are sent as real DevTools input events, except letter keys (`M`, `R`, `Ctrl+Z`): on this Chrome (headless, macOS) one injected letter key turns into thousands of keydown events a second that never stop, so those are dispatched as `KeyboardEvent`s inside the page, which reach the app's handler the same way. Run the scripts with their output unpiped (not through `tail`), or the progress lines only appear at the end.

The app exposes `window.__onetake` with the store, the detector, the recorder, `setMode`, `hold`, slide loading, navigation, deletion, undo, `exportWith(overrides, inMemory)`, and for the checks `voiceCheck`, `lips`, `enroll`, `enrollVoice()`, `profile()`, `setProfile()`, `makeProfile()`, `setNoiseFilter()` and `setCamera()`, so you can script the same checks from the DevTools console. The who-is-speaking path (enrollment through the dialog, a second voice marked, the verdict's delay) was checked by hand the same way, with a WAV of two text-to-speech voices as the microphone: the enrolled voice scored 98 %, the other 7 to 20 %, and each verdict landed within 550 ms of its phrase ending.

### Stress run

```sh
npm run e2e:stress                                   # builds, then two minutes
npx tsx packages/e2e/src/stress.ts --minutes 30
npx tsx packages/e2e/src/stress.ts --hours 3 --out /tmp/one-take-stress --no-export
```

The stress runner (`packages/e2e/src/stress.ts`) plays a generated voice as the microphone (bursts of half a second to five seconds at varying loudness, thinking pauses, the odd click), long enough to cover the whole run and played once (runs beyond an hour loop it; see the note in `make-fixtures.ts`), through a twelve-slide deck. It first checks the two modes deterministically: Auto records; switching to Press to speak with the mic on records nothing for six seconds of talk; holding `Space` for four seconds (with auto-repeat) records and does not move the slide; holding the stage button with the mouse records. Then it runs a seeded random session: slide moves with real `→` `←` `PageDown` `Home` `End` presses and film-strip jumps, mode switches, presses with slide changes inside them, `Backspace` and `Ctrl+Z`, mutes, mic restarts with `R`, and (with `--preview`) previews stopped with `Esc`. Once a minute it checks every phrase (valid slide, non-empty, sane sample rate, unique id) and both timelines (items match phrases, times chain exactly, totals finite), and logs phrases, seconds recorded, PCM bytes and the V8 heap. At the end it stops the mic, checks the detector is idle, that pauses really were removed, and that the heap did not grow unduly, then reloads, resumes (same phrases, same seconds, same mode), previews, exports the whole session to MP4 and checks the file's duration against the timeline. `--seed` replays a run; `--no-export` skips the final export for very long runs; `--verbose` prints every action with its time, leaves console breadcrumbs around each microphone and Web Audio call, and lets a stall report interrupt the page and print its JavaScript call stack.

**Known limitation of the headless run.** Previews in the middle of the random session are opt-in (`--preview`). In this headless Chrome with the fake microphone, once a preview has played, a later mic stop wedges the browser's audio stack after about a minute: every call the app makes completes (the breadcrumbs show the track stopping and the context suspending), the JavaScript stack cannot be interrupted, and the page then stops answering inside native code. The same action list without previews passes, and so does the preview at the end of the run. It has not been reproduced with a real microphone, so the sequence worth checking by hand on real hardware is: record, preview, record more, stop the mic, start it again.

## Browser support

| Browser                 | Recording | Export with the server | Export in the browser                             |
| ----------------------- | --------- | ---------------------- | ------------------------------------------------- |
| Chrome, Edge (desktop)  | Yes       | Yes, full speed        | Yes, streamed to disk through a save dialog       |
| Other Chromium browsers | Yes       | Yes, full speed        | Usually the same as Chrome                        |
| Safari, Firefox         | Yes       | Depends on WebCodecs support in that version | In memory, up to about 2 GB, then downloaded. Without WebCodecs, real-time WebM only. |

Recording the camera needs WebCodecs and either `MediaStreamTrackProcessor` or `requestVideoFrameCallback`: Chrome and Edge have both, and the **Record camera** switch is greyed out, with the reason, where they are missing.

The export dialog tells you what your browser can encode. Codec availability also depends on the operating system: H.265 and AV1 encoding, for example, are often only available with hardware support.

The lip check needs Chrome or Edge (it hands the camera's frames to a worker with `MediaStreamTrackProcessor`); elsewhere the voice check decides alone. The deep noise filter needs AudioWorklet; the ScriptProcessor fallback gets the classic filter.

## Troubleshooting

**Nothing is recorded when I talk.** Watch the **Mic level** meter. Your voice must cross the white line. Lower the **Speech line** slider until it does, or move closer to the microphone. Check that the right microphone is selected and that the page is not muted (`M`). The note under the meter shows the voice detector's score; if it stays low while you talk, the microphone is picking you up too faintly, or the room is so loud that your voice does not stand out from it: move closer to the microphone, or use a headset.

**The recording starts on its own.** Something crosses the line and the voice detector hears a voice in it: a TV, a radio, people talking nearby. Raise the **Speech line** slider so that only your own voice goes past it, or switch to Press to speak.

**The Record camera switch unticks itself.** The browser refused the camera: allow it in the address bar (the camera icon) and tick the switch again. If another app has the camera open, close it first. A camera that is unplugged while recording ends the picture there; the phrases already recorded keep theirs.

**A long silence was kept inside a phrase.** That happens with a recording made before the voice detector was there. Click **Edit**, then **Remove pauses**: every stretch without a voice is cut out, and Undo brings it back if you disagree.

**A soft stretch of my voice was cut.** The cut is made after the phrase is finished, from the whole of it, so a quiet aside or a sentence that trails off should survive; if one does not, it stood less than 3 dB over the room's noise, so lower the room (the **Noise filter** on, a headset) rather than the **Speech line**, which only decides what can _open_ a phrase. A whispered stretch longer than _Phrase ends after_ is cut, since a whisper has nothing voiced in it.

**The fan is in the recording.** Check that **Noise filter** under the level meter says **Deep** and that the note under the meter says *deep filter*: DeepFilterNet3 takes out a fan, typing, traffic, music and other voices. If the note says *classic filter* although Deep is chosen, the machine could not keep up with the model (a message said so when it gave way) and the classic filter is doing what it can: a steady fan, air conditioner, hum or hiss, about 20 dB, within three seconds of it switching on, but not sounds that keep changing. If your own voice comes out thin, try **Classic** or **Off**.

**A phrase of mine is marked as another voice.** Hover the badge: it says what each check saw. *Voice unlike yours* with a low match means the profile does not fit how you sounded, a cold, another microphone, a very different room; click **Learn my voice** and read again. *Your lips were still* with your face in view means the camera did not see your mouth move while the voice went on: check the mirror in the corner of the stage shows your face straight on, in the light. A verdict changes nothing by itself, so the phrase is still there to listen to and keep.

**The camera's mirror says no face in view.** Face the camera, and give it light from the front; a face in profile or in the dark is not found. If the mirror is missing, the **Camera** list is set to *Off (no lip check)*, the browser refused the camera, or this is not Chrome or Edge; the voice check then decides alone.

**The enrollment says too little of my voice came through.** It needs eight seconds of voice out of the twenty, as the voice detector hears it. Read out loud the whole time, closer to the microphone, with the level meter crossing the white line, and try again.

**Phrases are cut off at the end.** Raise **Phrase ends after**. The default 0.7 s treats a longer pause as the end of a phrase. (A phrase shows up in the timeline about two seconds after you stop talking: the live detector waits that long to be sure you have finished, then the second listen trims the wait away.)

**The export dialog says the server is not reachable.** Start it with `npm start` and check that the page is open on the same host and port the server logs. In development the Vite page on 5173 proxies to the server on 4317; both must be running. Or choose **Save in browser**.

**ffmpeg not found.** Install it (see [What you need](#what-you-need)) or pass `--ffmpeg /path/to/ffmpeg`. The capabilities endpoint shows what the server found. Without ffmpeg, MP4, MOV, MKV and WebM still work; HLS, DASH and compression do not.

**"This browser cannot encode …".** The container needs a codec your browser does not have. Pick another container, set the codec to **Automatic**, or save to a folder with ffmpeg installed and let the server transcode.

**MPEG-TS segments need AAC audio.** HLS with `.ts` segments cannot carry Opus. Choose AAC, or fMP4 segments.

**Unknown export job after a restart.** Jobs live in memory. Restarting the server during an upload loses the job; export again.

**The folder cannot be replaced.** Replacing a folder is allowed only when it holds nothing but a previous One Take export. Choose another name or empty the folder yourself.

**A PowerPoint slide looks a little different.** Fonts the machine lacks are replaced by a stand-in with the same weight and style, which shifts line breaks. Pass the real fonts with `--fonts`. 3-D effects, soft shadows, embedded video, SmartArt animation and GIF or SVG pictures are approximated or skipped; the browser console lists what the renderer changed. For a pixel-exact result, export the deck as PDF.

**The export runs on the CPU although this machine has a hardware encoder.** Open the export dialog and look under **This computer**: **Use the hardware encoder** must be ticked (it is, unless it was unticked once; the choice is remembered per browser), and the line under it lists the encoders found in the browser and in ffmpeg. On an Apple-silicon Mac that line may add that the CPU encoder measured faster on slides; that is information, not a decision. The *Smallest file* mode keeps ffmpeg on the software encoders by design.

**Hardware encoder refused above 4K.** Many hardware encoders cap at 4096×2304. Untick **Use the hardware encoder** or pick a smaller size.

**The deep clean and Only my voice are greyed out.** The server found no studio. Run `npm run studio` once (it needs `uv` or a Python 3.10 to 3.13, and fetches about 1.7 GB of models), restart the server, and reopen the dialog; the note under the switches says what was found. A phrase whose voice could not be kept (the studio says your voice was not found in it) stays as it was.

**The transcript switch is greyed out.** The server found no whisper. Install one (`brew install openai-whisper`, or `brew install whisper-cpp` plus a `ggml-*.bin` model in `~/.one-take/models`), restart the server, and reopen the dialog. The note under the switch says what was found and, for openai-whisper, that the first run downloads the model.

**A filler the list found is a real word, or a real "um" was missed.** The detector works from the sound's shape, not from a vocabulary, so it will sometimes mistake a held, isolated vowel ("oh…", "so…") for a hesitation, and miss a filler that runs straight into the next word. Untick the line to keep a stretch, or pick a lower sensitivity; pick *Catch more* and go through the list to find the rest. A hesitation with a pause on both sides is the one it is surest of.

**The faster export sounds choppy.** Speeds above 2× stretch what the time-stretch can hide; keep to 2× or below for speech. Pauses are not shortened by the speed, so a lecture with long pauses gains less than the figure suggests: use **Remove pauses** in the editor first.

**A video is missing from Exports.** Only exports saved to a folder through the local server are listed. Files saved with **Save in browser** went wherever the browser put them. A listed video marked *not on disk* was moved or deleted outside the app; **Remove from list** drops the entry.

**Export in Safari or Firefox fails for a long lecture.** Those browsers assemble the file in memory. Use the server, or split the lecture.

**The mic works but the level meter is flat in headless Chrome.** You need `--use-fake-device-for-media-stream`, `--use-file-for-fake-audio-capture=<wav>` and `--disable-features=AudioServiceSandbox`. The e2e runner sets these.

## Privacy

Audio and the camera's picture never leave your computer. The browser keeps phrases in IndexedDB, the server writes only to the folder you pick, and no request carries anything of yours anywhere. Speech is detected in the browser by plain arithmetic. The three models (the deep noise filter, the speaker model, the face model) run in the browser too; the first two parts come with the app and the other two are fetched once, from GitHub and from Google's model storage, checked and kept, unless `npm run models` has already put them in place. Your voice profile is 256 numbers in this browser's localStorage, and the verdicts are stored with the phrases. The studio's models (the deep clean, the separation and the extraction) run on the local server, in a Python environment `npm run studio` makes; their checkpoints come from Hugging Face once, through that command alone, and the audio and the mouth films they work on are files in the server's data folder that are deleted when the job is done. There is no analytics, no account, and no cloud.

## License

MIT. See [LICENSE](LICENSE).
