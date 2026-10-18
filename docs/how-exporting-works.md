# How exporting works

You don't need any of this to export a video. Read it when you want to know what the browser does and what the server does, why a three-hour lecture is fine, what the start-up system check is for, when the hardware encoder is used, and how speed, filler words and transcription are done.

## Contents

- [The stages of an export](#the-stages-of-an-export)
- [What runs where](#what-runs-where)
- [Following an export](#following-an-export)
- [Large exports](#large-exports)
- [The system check](#the-system-check)
- [The hardware switch](#the-hardware-switch)
- [Performance modes](#performance-modes)
- [What was measured](#what-was-measured)
- [Speed](#speed)
- [Volume](#volume)
- [Filler words](#filler-words)
- [Transcription](#transcription)

## The stages of an export

**Stage 0: the studio on the server.** When the Sound section asks for it, the phrases go to the server first, as the microphone heard them. The deep clean comes back for every phrase, then only your voice for the flagged ones, and each result is kept with its phrase the moment it lands. From here on each phrase is the version it is set to. See [The studio](studio.md).

**Stage 1: the browser encodes.** First the phrases are prepared when the Enhance section asks for it: fillers cut, volume evened, pace changed (*Prepare the audio* in the progress view), and the transcript is made (*Transcribe on the server*). Then the browser renders the timeline with WebCodecs through [mediabunny](https://github.com/Vanilagy/mediabunny), faster than real time:

1. Slides are drawn on a canvas at the chosen size and frame rate, with the drawings, the camera picture and the subtitle of the moment on top. Up to eight slide bitmaps are cached so going back and forth is cheap.
2. Audio is joined with short fades, resampled to 48 kHz, and fed to the encoder in 100 ms chunks.
3. The muxer writes the container as positioned 4 MB chunks to wherever the file is going: the server, a file on disk, or memory.
4. Every encoded frame and every audio chunk waits for the encoder's queue, so memory stays flat however long the lecture is.
5. Frame and sample timestamps come from integer counters, not accumulated floats, so hours of video stay in sync.

The last slide stays on screen for 0.25 s after the last word.

**Stage 2: the server packages or re-encodes.** When you save to a folder, the server receives the chunks and writes each one at its byte offset, so a re-sent chunk is harmless. When the upload is complete it does one of these:

- **Move** the file into place (fMP4, MOV, MKV, WebM, or MP4 without ffmpeg).
- **Remux** an MP4 with `+faststart` so the index sits at the front. No re-encode.
- **Package** HLS or DASH by copying the streams into segments.
- **Re-encode** with CRF for compression, adaptive ladders, or when the browser could not produce the container's codecs.

The browser follows the job over server-sent events and falls back to polling if the stream drops.

## What runs where

The planner in `packages/shared/src/plan.ts` is a pure function. The export dialog calls it to show the plan before anything runs, and the same decisions are unit-tested.

| You ask for                                               | The browser writes                                           | The server does                                      |
| --------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------- |
| MP4 to a folder, ffmpeg present                           | Fragmented MP4                                               | Remuxes to MP4 with faststart (stream copy)          |
| MP4 to a folder, no ffmpeg                                | MP4                                                          | Moves it into place                                  |
| Fragmented MP4, MOV, MKV or WebM to a folder              | That container                                               | Moves it into place                                  |
| Any single-file container, saved in the browser           | That container, straight to disk or memory                   | Nothing                                              |
| WebM to a folder, browser cannot encode VP9/AV1 with Opus | Fragmented MP4 mezzanine                                     | Transcodes to VP9 + Opus (warned in the plan)        |
| HLS or DASH, no compression, no ladder                    | Fragmented MP4 with key frames aligned to the segment length | Copies the streams into segments                     |
| HLS or DASH with adaptive bitrate                         | High-quality fragmented MP4 mezzanine                        | Re-encodes every rung and writes the master playlist |
| Anything with Compress on                                 | High-quality fragmented MP4 mezzanine                        | Re-encodes with CRF and your settings                |

A mezzanine is encoded at the higher of your chosen bitrate and the "very high" level, with audio at no less than 128 kbit/s.

**Estimates and blockers.** Before an export starts, the dialog shows an estimate of the upload size, the final size and the number of frames. On the server the free space in the destination is checked against the estimate, doubled when ffmpeg will need a temporary copy. The plan also lists blockers: a missing server, a missing ffmpeg, an ffmpeg without the right encoder or muxer, or a codec the browser cannot produce. An export with blockers cannot start.

## Following an export

The time left in the progress view does not start at "1 h 30 min" and drop to "30 s" a minute later. The usual figure comes from dividing the work left by the average speed since the start, and at the start that average is dominated by set-up time during which nothing counted as progress.

Here the estimate starts from what the plan expected (the resource map), hands over to a speed measured over a sliding window of the last few seconds once a little work has been done, and follows a measured drop quickly but a rise only slowly. The arithmetic is in `packages/shared/src/eta.ts` and is unit-tested against a simulated one-hour lecture: the first figure is the plan's, and no figure along the way exceeds twice it.

## Large exports

A three-hour lecture is the normal case, so the pipeline is built around it:

- **No in-memory assembly.** The muxer streams 4 MB chunks to the server or straight to disk. Memory use does not grow with the video length.
- **Back-pressure everywhere.** Every encoded frame and audio chunk waits for the encoder queue, and every chunk waits for the upload. Nothing piles up.
- **Exact timestamps.** Integer counters, not accumulated floats, so hours of video stay in sync.
- **A free-space check** before anything starts, counting the temporary copy ffmpeg needs. Files over 4 GB are fine.
- **Crash-safe fragments.** The upload is a fragmented MP4, so an interrupted export still leaves a playable file on the server side.
- **Retries.** A dropped connection retries the chunk up to six times with exponential back-off (0.8 s doubling to a cap of 8 s). Positioned writes make duplicates harmless. A 4xx answer stops retrying, because the job is gone.
- **Cancel** stops the encoder, aborts the upload, kills ffmpeg and removes partial files. A failed job cleans up too.
- **The screen stays awake** during an export, and closing the tab while recording or exporting asks for confirmation.
- **Collisions never overwrite.** You get `lecture (2).mp4` unless you tick *replace*. Folders are replaced only when they contain nothing but a previous One Take export.
- **Slides** are rendered once, cached as bitmaps during the export, and reused.
- **Audio from different microphones** (different sample rates) is resampled to one rate.

## The system check

Video work is heavy, so the app looks at the machine before it does any. The server runs a check at start-up, and the export dialog turns the result into a mode and a resource map.

At start-up (`npm start`) the server prints what it found and serves it at `GET /api/system`:

```
One Take 1.0.0: system check
  CPU      Apple M2 Max, 12 cores (8 performance, 4 efficiency), arm64
  Memory   96 GB total, 69 GB available now
  GPU      Apple M2 Max, 38 cores, shared memory
  Disk     412 GB free in /Users/me/Movies/One Take
  ffmpeg   9.0.2 at /opt/homebrew/bin/ffmpeg
           hardware encoders: h264_videotoolbox, hevc_videotoolbox
           hardware decoders: videotoolbox (decodes the upload whenever the hardware switch is on; a codec it cannot take falls back to the CPU)
           races at 1080p on slide-like video: encode libx264 910 fps, h264_videotoolbox 400 fps; decode software 2000 fps, videotoolbox 300 fps (measured 14/10/2026, kept in the data folder for a week)
  Node     v24.14.0
  Mode     gpu: GPU encoding available; up to 2 ffmpeg re-encodes at a time
  Renderer 32.0 GB heap for PowerPoint conversion
  Speech   whisper-cli found: transcripts and subtitles are on
  Studio   The studio runs on the GPU (torch 2.9.0); the deep clean and keeping only your voice are ready.
  Models   all in /Users/me/one-take/packages/client/public/models
```

- **The machine:** CPU model, core count and the performance/efficiency split (Apple silicon), total and available memory, the GPU, and free disk space where exports go.
- **Hardware encoders and decoders.** Every hardware encoder ffmpeg lists (`*_videotoolbox`, `*_nvenc`, `*_qsv`, `*_vaapi`) is self-tested with a third of a second of synthetic video. One that is compiled in but has no device behind it is dropped, so the export dialog never offers an encoder that would fail. Every hardware decoder it lists (`videotoolbox`, `cuda`, `qsv`, `d3d11va`, `dxva2`, `vaapi`) is tested the same way on a third of a second of H.264. `--no-self-test` skips both (about 0.2 s per encoder or decoder).
- **The tier:** `gpu` when a hardware encoder works, `cpu-fast` with eight or more cores, `cpu`, or `constrained` (under 4 cores or 8 GB). It decides how many ffmpeg re-encodes may run at once; software encoders already use every core, so a second job would only slow both down.
- **The races.** Three seconds after the server is up it races the H.264 encoders it has (each verified hardware encoder against `libx264 veryfast`) on six seconds of slide-like 1080p video, about a second each, then races the decoders the same way. The figures are printed when they are in, shown under the hardware switch in the export dialog as information, and kept in `benchmark.json` in the data folder for a week, so the next start prints them at once. A new ffmpeg, or a week, runs the races afresh. They do not move the switch. `--no-benchmark` skips them.
- **The PowerPoint renderer** runs in a worker with a heap limit of half the machine's memory (`--renderer-memory 4096` to change it). A deck that needs more fails with a clear message instead of taking the server down.

`npm run doctor` runs the same check without starting the server and prints which process needs which resource for a one-hour 1080p lecture: recording, slide rendering, PowerPoint conversion, and every export stage with its memory, whether it runs on the GPU or the CPU, and a rough time. `npm run bench` (`--height 2160` for 4K) runs the encoder and decoder races in the open, adds `libx264 medium` and `libx265 veryfast` for comparison, and says which encoder is really the fastest on this machine.

**In the browser** the app probes WebCodecs once: which codecs it can encode, whether `prefer-hardware` is accepted at 1080p and at 4K for each, whether `prefer-software` is accepted at all (Chrome has no software HEVC encoder, for instance), plus thread count, visible memory and the GPU name. It then races the GPU and the software H.264 encoder on 150 frames of a 1080p slide, about half a second, and keeps the answer for a week in `localStorage`. The export dialog's *This computer* section shows both sides.

## The hardware switch

**Use the hardware encoder and decoder when this computer has one** sits under the system line in the export dialog and is on by default. The line under it lists what was found on each side, for example `AVC up to 4K and HEVC up to 4K in Chrome 141; h264_videotoolbox, hevc_videotoolbox in ffmpeg (decoding on videotoolbox)`, and where the races found the CPU quicker on slide video, says so with the figures.

- **On:** the browser asks WebCodecs for the hardware encoder for every codec and size the probe accepted, codecs the hardware can take come first when the codec is *Automatic*, ffmpeg uses `h264_videotoolbox`, `hevc_videotoolbox`, `*_nvenc`, `*_qsv` or `*_vaapi` for compression, transcoding and adaptive ladders, and decodes the upload with the verified `-hwaccel` method. A size the hardware refuses (above 4K on most of them) goes to the CPU with a warning.
- **Off:** the browser asks for the software encoder, skips codecs it only has in hardware when the codec is *Automatic*, and ffmpeg uses `libx264`, `libx265`, `libvpx-vp9` or `libsvtav1` and decodes on the CPU.

The switch is a browser preference, like the theme: it applies to every project and is remembered until you change it. A machine without any hardware encoder or decoder shows it greyed out.

**Decoding follows the switch too.** On its own the CPU decoder is quicker on slide video (on an M2 Max, six seconds of 1080p decode in 0.09 s on the CPU and 0.59 s on VideoToolbox). But a compression never decodes on its own: next to the hardware encoder, the hardware decoder adds no wall time and cuts the CPU time by two thirds, which is what the switch is for. A codec the hardware cannot take falls back to the CPU inside ffmpeg. The browser's camera clips (360p, a few hundred kbit/s) are left to WebCodecs' own choice; forcing the hardware there made a visibly softer picture at that bitrate.

## Performance modes

The performance mode in the export dialog (saved with the project) picks presets around the switch:

| Mode                   | Browser stage                                                                                                     | Server compression                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Fastest** (default)  | the hardware encoder when the switch is on and the probe accepted it; otherwise the software encoder in `realtime` latency mode | the hardware encoder and decoder when the switch is on; otherwise `libx264`/`libx265`, `veryfast` preset, decoding on the CPU |
| **Balanced**           | the same encoder choice, browser default latency                                                                  | the same encoder and decoder choice, `medium` preset                                                              |
| **Smallest file**      | the same encoder choice, `quality` latency                                                                        | always the software encoders and the CPU decoder, `slow` preset, `stillimage` tune for x264 (no hardware encoder makes a smaller file) |

The latency choice is measured, not assumed: on an M2 Max the VideoToolbox encoder drops from 374 to 166 fps in `realtime` mode, while Chrome's software H.264 encoder runs at about 400 fps in either, so `realtime` is reserved for software codecs. A mode only sets the starting point; every field stays editable. The *Plan* section then names the encoder each stage will use and lists the resource map for the chosen settings (GPU, CPU and disk per stage, memory, rough time), and warns when the export would take more than 40 % of the machine's memory, when the CPU ends up with a codec the hardware could have taken, or when the job will take over half an hour.

## What was measured

Slides are still images, so each slide is captured once and every video frame of that slide is a reference clone with a new timestamp. For a software encoder the capture is a planar I420 frame in CPU memory (`core/yuv.ts`, BT.709, about 30 ms per slide). This matters more than it sounds: a canvas-backed frame is RGBA on the GPU, and Chrome converts it again for every `encode()` call, which pinned every encoder at about 370 fps for 1080p on an M2 Max. With planar frames Chrome's software H.264 encoder reaches 570 fps in a real export, while the VideoToolbox encoder stays near 380 fps whatever it is fed. That is why the race is reported under the hardware switch: on that machine, unticking it gives the quickest export, and leaving it on gives a cooler, idle CPU. A GPU encoder keeps the canvas frame, which is already in its memory.

Slide bitmaps are decoded already scaled to the output size, the encode runs on an `OffscreenCanvas`, and the preview reuses one timeline instead of rebuilding it every animation frame. Measured on an M2 Max with Chrome: eleven minutes of 1080p at 15 fps encode in 17 s (38× real time), so an hour-long lecture exports in about a minute and a half, and compression on the server adds about a minute per hour with `libx264 veryfast`. Fewer frames is the one lever that always works: 10 fps is a third faster than 15 and looks the same on slides.

## Speed

The audio is time-stretched by waveform-similarity overlap-add (`packages/client/src/core/stretch.ts`, plain code): 25 ms windows of the recording are laid down at the normal spacing while being taken from the input `speed` times further apart, each one from the spot within a few milliseconds that best continues the window before it, so no pitch period is torn. The pauses between phrases keep their length. The camera's frames and the pen's strokes keep their content and run through it faster, in step with the voice. An hour of 48 kHz speech takes a few seconds.

## Volume

**Even out the volume** brings every phrase's speech level (the loudest fifth of its 50 ms blocks) to −20 dBFS, never more than 18 dB up or 6 dB down, and never past the point where a peak would clip. Drawings, being silence, are left alone.

## Filler words

The filler detector (`packages/client/src/core/fillers.ts`) works like the voice detector: by arithmetic alone, no model, every rule readable. A filler is not recognised as a word; it is recognised by its shape, which is much the same in every speaker and language:

1. **It stands apart.** A filler is a hesitation, so there is a real pause, a quarter of a second or so, on at least one side of it and usually both. The brief silence before a "p" or a "t" is far shorter.
2. **It is one long, steady sound.** "Uh" is a neutral vowel held for a quarter of a second or more without the mouth moving. The spectrum of each 32 ms frame hardly changes over 48 ms, where a word's spectrum moves with every consonant.
3. **The vowel is the central one** of "but" and "the": its first two formants sit near 600 and 1200 Hz, where the vowels of "see", "say" and "saw" peak elsewhere. An "um" or "hmm" ends in a nasal murmur with its energy under 500 Hz; that tail is part of the same run and goes with it.
4. **The pitch glides, it does not sing.** A filler holds one note or drifts down smoothly; a run of syllables carries the sentence's melody.

Every run of voice between 0.12 and 1.5 s gets a score from 0 to 1 that is the product of those things, with a little extra for being quieter than the rest, as hesitations are. The sensitivity picks the score a run needs: *Only the obvious ones* (0.55), *Balanced* (0.35, the default) or *Catch more* (0.2). On synthetic speech with hesitations spliced in, the balanced setting finds half of them with one false alarm in two minutes of ordinary sentences, the strict one a third with none, and the eager one four in five with one word in forty flagged, which is why there is a list to check. What is cut is the run plus most of the pause on either side, and the two sides are joined with an 8 ms fade.

## Transcription

The server looks for whisper on the PATH at start-up, in this order: `whisper-cli` (whisper.cpp, the fastest), `whisper-cpp`, then `whisper` (the Python openai-whisper). The capabilities line in the export dialog says which it found, and the system check prints it as `Speech`. Nothing is bundled and nothing is downloaded by One Take itself.

| Engine         | Install                     | Model                                                                                                                                                |
| -------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| whisper.cpp    | `brew install whisper-cpp`  | a `ggml-*.bin` file in `~/.one-take/models` (or `--whisper-model /path/to/ggml-base.en.bin`); `ggml-base.en.bin` is preferred when several are there |
| openai-whisper | `brew install openai-whisper` | `base.en` by default (`--whisper-model small` to change); whisper downloads it into `~/.cache/whisper` the first time it runs, about 140 MB            |

Pass `--whisper /path/to/program` to use a particular one. The audio is sent as 16 kHz mono with half a second of silence between phrases; drawings are left out, since silence only tempts the recogniser to invent words. Transcription runs on the CPU at roughly five to twenty times real time depending on the engine and the machine, so an hour of lecture takes a few minutes. The progress view shows it as its own step with the recogniser's own percentage. The server writes the audio to a temporary file in its data folder, runs the recogniser on it, and deletes it.

This is the one place where One Take leans on a trained model that is yours to install or not: without whisper the switch is greyed out and everything else works as before.
