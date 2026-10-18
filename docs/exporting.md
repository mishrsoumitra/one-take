# Exporting

You have a lecture you are happy with. This guide is about turning it into a video file: where it goes, which format and quality to pick, what the server can do with ffmpeg, and the extra steps that make it faster, cleaner and subtitled.

## Contents

- [The export dialog](#the-export-dialog)
- [Where the video goes](#where-the-video-goes)
- [Output formats](#output-formats)
- [Resolution, frame rate and quality](#resolution-frame-rate-and-quality)
- [Compression with ffmpeg](#compression-with-ffmpeg)
- [Streaming: HLS and DASH](#streaming-hls-and-dash)
- [Phrase order](#phrase-order)
- [Speed, volume, filler words and subtitles](#speed-volume-filler-words-and-subtitles)
- [The camera and the drawings](#the-camera-and-the-drawings)
- [Following an export](#following-an-export)
- [Your exported videos](#your-exported-videos)

## The export dialog

Click **Export video**. In the dialog you choose:

- **Save to**: a folder on this computer, through the server, or **Save in browser**.
- **File name**, **Container**, **Resolution**, **Frame rate**, **Quality**, **Video codec**, **Audio** codec and bitrate, **Key frame every**, and **Order**.
- **Compression (server, ffmpeg)** and, for HLS and DASH, **Segment length**, **Segment type** and **Adaptive bitrate**.
- **Sound**: the studio's switches (the deep clean, only your voice, the check for a second voice) and the list of flagged phrases to listen to, keep or leave out. See [The studio](studio.md).
- **This computer**: what the machine has, the **Use the hardware encoder and decoder** switch (on by default, remembered in this browser) and the performance mode. See [The hardware switch](how-exporting-works.md#the-hardware-switch).
- **Camera** (shown when any phrase has a picture) and **Drawings** (shown when any clip draws on a slide). See [below](#the-camera-and-the-drawings).
- **Enhance**: the playback **Speed**, **even out the volume**, **cut filler words** with a list of what was found, and **transcribe the speech and add subtitles**. See [below](#speed-volume-filler-words-and-subtitles).

The **Plan** panel shows what the browser will encode and what the server will do afterwards, an estimate of the upload size and the final size, warnings, and any reason the export cannot run. Press **Export** when you are happy. You can cancel at any point, and when it's done, **Show in folder** opens Finder or Explorer at the file.

The settings are saved with the project, so the next export starts from the last one.

## Where the video goes

**A folder on this computer** goes through the local server. A folder picker browses the computer the server runs on. Inside the folder you chose, the file passes through two temporary names while it uploads and while ffmpeg runs, and gets its final name when it is done. An existing file is never overwritten: you get `lecture (2).mp4` unless you tick *replace*. The details are in [Where files go](server.md#where-files-go).

**Save in browser** needs no server. In Chrome and Edge the file streams to a location you pick in a save dialog, so size is not a concern. Other browsers assemble the file in memory and download it; keep those exports under about 2 GB. The plan tells you which case you are in.

A browser without WebCodecs gets **Record in real time (WebM)**: the lecture is played into a recorder. It takes as long as the lecture and produces WebM only, but it works wherever the microphone works.

## Output formats

| Container      | Extension | Video codecs           | Audio codecs | Needs ffmpeg | Notes                                                                                        |
| -------------- | --------- | ---------------------- | ------------ | ------------ | -------------------------------------------------------------------------------------------- |
| MP4            | `.mp4`    | H.264, H.265, AV1, VP9 | AAC, Opus    | No\*         | Plays everywhere. With ffmpeg the index is moved to the front so it plays while downloading. |
| Fragmented MP4 | `.mp4`    | H.264, H.265, AV1, VP9 | AAC, Opus    | No           | Written in small fragments. If the export is interrupted, what was written stays playable.   |
| QuickTime MOV  | `.mov`    | H.264, H.265           | AAC          | No           | For Final Cut, iMovie and other Apple tools.                                                 |
| Matroska MKV   | `.mkv`    | H.264, H.265, VP9, AV1 | AAC, Opus    | No           | Holds any codec. Good for archiving; not every player supports it.                           |
| WebM           | `.webm`   | VP9, AV1               | Opus         | No\*\*       | Royalty-free. Plays in browsers; smaller files for the same quality.                         |
| HLS            | `.m3u8`   | H.264, H.265           | AAC          | Yes          | A folder with `index.m3u8` and short segments for a web player or a streaming server.        |
| MPEG-DASH      | `.mpd`    | H.264, H.265, VP9, AV1 | AAC, Opus    | Yes          | A folder with `manifest.mpd` and segments for dash.js, Shaka Player or a CDN.                |

\* Without ffmpeg the server stores the browser's file as is. With ffmpeg the upload is crash-safe fragments, remuxed with `+faststart` and never re-encoded.

\*\* The browser writes WebM directly when it can encode VP9 or AV1 with Opus. Otherwise the server transcodes it with ffmpeg.

Which codecs you get depends on what your browser can encode; the dialog lists them. **Automatic** picks the first one the container allows and the browser supports: H.264, then H.265, then AV1, then VP9 for the MP4 family; VP9, then AV1 for WebM.

## Resolution, frame rate and quality

**Resolution.** The presets are 2160p (3840×2160), 1440p (2560×1440), 1080p (1920×1080), 720p (1280×720), 480p (854×480) and 360p (640×360). **Custom size…** takes any width and height from 16 to 7680; odd numbers are rounded down to even, because H.264 and H.265 need that. Slides are drawn centred on a black canvas at the chosen size, keeping their shape. Above 4K the plan warns you that many hardware encoders refuse to run.

**Frame rate.** The list offers 1, 2, 5, 10, 12, 15, 24, 25, 30, 50 and 60 fps, and **Custom…** accepts 1 to 120. The default is 15. Slides are still images, so 10 to 15 fps looks identical to 30 and exports faster with smaller files. With a camera picture or drawings, pick 24 or 30 so the movement is smooth.

**Video quality.** Four levels, each a bitrate at 1080p30 that is scaled to your size and frame rate. These are upper bounds; still slides compress far below them.

| Level                       | At 1080p30   |
| --------------------------- | ------------ |
| Low · smallest file         | 1200 kbit/s  |
| Medium · good for slides    | 2500 kbit/s  |
| High · crisp text (default) | 5000 kbit/s  |
| Very high · near lossless   | 10000 kbit/s |

**Custom bitrate…** takes 100 to 200 000 kbit/s.

**Audio.** AAC or Opus (or **Automatic**), at 48, 64, 96, 128 or 192 kbit/s. The default is 96 kbit/s, which is plenty for one voice. Audio is mono, resampled to 48 kHz, and phrases are joined with short fades.

**Key frames.** **Key frame every** 0.5 to 60 s (default 4 s). Smaller values seek faster and make bigger files. A key frame is also forced on every slide change, so scrubbing lands on a clean slide. For HLS and DASH the interval is adjusted to divide the segment length evenly.

## Compression with ffmpeg

Turn on **Compress** to have the server re-encode the video with ffmpeg. The browser then encodes at a high "mezzanine" quality first, so nothing is lost twice.

| Setting           | Choices                                                                | Notes                                                                                                        |
| ----------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Codec             | H.264, H.265, VP9, AV1                                                 | H.264 and H.265 go into MP4, MOV, MKV, HLS and DASH. VP9 and AV1 go into MP4, MKV, WebM and DASH.            |
| Quality (CRF)     | H.264 0–51 (default 23), H.265 0–51 (28), VP9 0–63 (32), AV1 0–63 (35) | Lower is better quality and a bigger file. For slides, 26–30 with H.264 is still crisp.                      |
| Speed preset      | ultrafast, veryfast, fast, medium, slow, slower, veryslow              | Slower presets squeeze out a smaller file for the same quality. Mapped onto the equivalent for VP9, SVT-AV1, libaom and NVENC. |
| Tune              | none, stillimage                                                       | `stillimage` is applied with x264 only. It suits slides well.                                                |
| Output frame rate | 1–120 or empty                                                         | Change the frame rate while re-encoding. Empty keeps the recorded rate.                                      |
| Max bitrate       | 100–200 000 kbit/s or empty                                            | Caps the bitrate (with a buffer of twice that) for streaming-friendly output.                                |
| Scale to height   | 16–7680 or empty                                                       | Scales while re-encoding, keeping the aspect ratio.                                                          |

Which encoder does the work follows the **Use the hardware encoder and decoder** switch: VideoToolbox, NVENC, QSV or VAAPI when ffmpeg has one and the switch is on, otherwise x264, x265, libvpx or SVT-AV1. The *Smallest file* mode always uses the software encoders, because a hardware encoder makes a larger file at the same quality. The plan names the encoder before you start, and the ffmpeg command that ran is kept with the job, so you can see exactly what happened.

For the smallest files: **Compress** with H.264, tune `stillimage`, CRF 26 to 30, and 10 to 15 fps.

## Streaming: HLS and DASH

| Setting            | Choices                     | Notes                                                                                       |
| ------------------ | --------------------------- | ------------------------------------------------------------------------------------------- |
| Segment length     | 2, 4, 6 or 10 s (default 4) | Key frames are aligned so each segment is exactly this long.                                |
| Segment type (HLS) | fMP4 (default), MPEG-TS     | MPEG-TS has the widest player support but needs AAC audio.                                  |
| Adaptive bitrate   | on / off                    | Produces several renditions and a master playlist instead of one stream. Always re-encodes. |

The adaptive ladder uses every rung at or below your source height:

| Rung  | Video       | Audio      |
| ----- | ----------- | ---------- |
| 1080p | 4500 kbit/s | 128 kbit/s |
| 720p  | 2500 kbit/s | 96 kbit/s  |
| 480p  | 1200 kbit/s | 64 kbit/s  |
| 360p  | 700 kbit/s  | 48 kbit/s  |

HLS writes `master.m3u8` with one folder per rendition (for example `720p/index.m3u8` and `720p/seg_00001.m4s`). Single-rendition HLS writes `index.m3u8`, `init.mp4` (fMP4) and `seg_00001.m4s` or `seg_00001.ts`. DASH writes `manifest.mpd`, init segments like `init-0.m4s` and media segments like `chunk-0-00001.m4s`, with a timeline and a template.

## Phrase order

**As recorded (slides may repeat)** keeps the order you spoke in, so if you went back to slide 3 later, slide 3 appears twice. **Grouped by slide number** sorts phrases by slide, keeping the spoken order within each slide. Phrases are joined with **Pause between phrases** (0.15 s to begin with), plus 0.25 s on every slide change.

## Speed, volume, filler words and subtitles

The **Enhance** section changes what the video says, not how it is encoded. Everything in it is done in the browser on copies of the phrases, so your recording itself is never changed. The one exception is the transcription, which the local server does with whisper.

**Speed** plays the lecture at 1.1×, 1.25×, 1.5×, 1.75× or 2×, or any figure from 0.5× to 3× under *Custom…*. The voice keeps its pitch. The pauses between phrases keep their length; only the speech gets faster, and the slides and the drawings change where the words say they should. Keep to 2× or below for speech; above that the stretch starts to show.

**Even out the volume from phrase to phrase** brings every phrase to the same speech level, never more than 18 dB up or 6 dB down, and never past the point where a peak would clip. Use it when some phrases were said closer to the microphone than others.

**Cut "um", "uh", "er" and "hmm"** finds hesitations by the shape of the sound, not by a vocabulary, so it works in any language. **Sensitivity** picks how sure it has to be: *Only the obvious ones*, *Balanced* (the default) or *Catch more*. Every filler it found is listed with a ▶ to hear the stretch and a tick: untick a line and that stretch stays. What is cut is the hesitation plus most of the pause around it, so what remains sounds like one ordinary pause. The scan runs once while the dialog is open and is remembered, so changing the sensitivity is instant, and the planned length under the summary falls as fillers are found. How it decides is in [Filler words](how-exporting-works.md#filler-words).

**Transcribe the speech and add subtitles** sends the audio to the local server, which runs whisper on it and returns every word with its time. You can tick three outputs:

- **Subtitles drawn into the video**: cues of up to two lines of 42 characters, on screen between one and six seconds, broken at sentence ends, commas and pauses, drawn in white on a soft dark box at the bottom of each frame.
- **Subtitle files next to the video**: `lecture.srt` and `lecture.vtt` in the same folder (inside the folder for HLS and DASH), remembered with the export so deleting the video deletes them too. For *Save in browser* they are offered as downloads.
- **The transcript as a text file**: `lecture.txt`, one paragraph per stretch of speech with the time it starts at. The transcript is also shown under the result.

The words are taken from the original recording and carried onto the final timeline afterwards, so a word inside a cut filler disappears from the subtitles too, and the times follow the speed. **Language** tells the recogniser what to expect, or *Detect automatically*. Transcription needs whisper on the server; without it the switch is greyed out. Which engines are found, where the model goes and how long it takes are in [Transcription](how-exporting-works.md#transcription).

## The camera and the drawings

**Camera** appears when any phrase has a picture. Untick **show the camera picture over the slides** to leave it out. The note says where the picture will be (drag or resize it on the main screen to change that), how many phrases have a picture, and reminds you to pick 24 or 30 fps so the speaker moves smoothly.

Two more controls clean the picture before it is drawn into the frame. **Background** blurs what is behind you or paints it a plain colour; a small segmentation model (fetched once, 250 kB) tells you from the background. **Picture** evens out the exposure and takes the colour cast out, slowly enough that the picture never flickers.

**Drawings** appears when any clip draws on a slide. It says how many drawings and strokes go into the video, and gives the same reminder about the frame rate: a pen drawn at 15 fps moves in steps. Every drawing goes in as it was made; to leave one out, delete it in the timeline or the editor.

## Following an export

Once you press **Export**, the settings give way to a progress view:

- **Time left**, in large type, with a note on where the figure comes from: *from the plan* before anything has been measured, *settling on the measured speed* while the first tenth of a stage runs, then *measured over the last few seconds*. Elapsed time, the share done and the bytes written sit beside it, over one bar for the whole export.
- **The steps**: the studio's steps first when it runs, then *Prepare the audio* and *Transcribe on the server* when the Enhance section asks for them, then *Encode in the browser*, then *Compress with ffmpeg* or *Package as HLS* on the server when the plan has a server stage, then *Save*. Each shows its own percentage, its time left, and what it is doing right now: frames per second, speed against real time, bytes written, and for ffmpeg its CPU use.
- **This computer, live**: the machine's CPU use and memory, the browser encoder's figures and the page's heap, so you can see what the export costs while it runs.
- **Cancel export** at any stage. When it finishes: the saved path, its size and how long it took, with **Show in folder** and **Back to settings**.

The time left does not start at "1 h 30 min" and drop to "30 s" a minute later. It starts from what the plan expected and hands over to a speed measured over the last few seconds once a little work has been done. How that is done is in [Following an export](how-exporting-works.md#following-an-export).

## Your exported videos

Click **Exports** in the top bar (or **Exported videos…** at the bottom of the export dialog). Every video the local server has saved is listed, newest first, with its format, size, duration, where it went and which encoder made it.

- **Play** streams an MP4, MOV or WebM into a player right there. An HLS or DASH folder opens in the file manager instead.
- **Show in folder** opens Finder or Explorer at the file.
- **Delete** asks once, then removes the file from disk and the entry from the list. An HLS or DASH folder is deleted only while it holds nothing but the export.

A video you moved or deleted outside the app is shown as *not on disk*, with **Remove from list** in place of Delete. The list is kept by the server, so it survives restarts. Files saved with **Save in browser** never pass through the server and are not listed.
