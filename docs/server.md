# The server and its API

The server (`packages/server`) is a small [Fastify](https://fastify.dev) app. It serves the built client, browses folders for the picker, receives uploads, runs ffmpeg, whisper and the studio, and keeps the list of your exports. This guide is for running it with options and for talking to it over HTTP.

## Contents

- [Starting it](#starting-it)
- [Options](#options)
- [Where files go](#where-files-go)
- [Security](#security)
- [ffmpeg detection and encoders](#ffmpeg-detection-and-encoders)
- [HTTP API](#http-api)
  - [Endpoints](#endpoints)
  - [Export job lifecycle](#export-job-lifecycle)
  - [Creating a job](#creating-a-job)
  - [The job object](#the-job-object)
  - [Events](#events)
  - [Errors](#errors)

## Starting it

```sh
npm start                                  # installs, builds and fetches the models when needed, then starts
node packages/server/dist/index.js         # the server alone, after npm run build
```

On start it prints the system check (see [The system check](how-exporting-works.md#the-system-check)), then logs the address, the ffmpeg it found (or that HLS, DASH and compression are off), where the client is served from, and the default output folder, which it creates if needed.

## Options

Every flag has an environment variable with the same meaning. A flag wins over the variable.

| Flag                | Variable                        | Default                             | What it does                                                                                                                                                                                                        |
| ------------------- | ------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--host`            | `ONE_TAKE_HOST`                 | `127.0.0.1`                         | Address to listen on.                                                                                                                                                                                               |
| `--port`, `-p`      | `ONE_TAKE_PORT`                 | `4317`                              | Port.                                                                                                                                                                                                               |
| `--dir`, `-d`       | `ONE_TAKE_DIR`                  | `~/Movies/One Take`                 | Suggested output folder. Created on start.                                                                                                                                                                          |
| `--data-dir`        | `ONE_TAKE_DATA_DIR`             | `~/.one-take`                       | Where the server keeps its list of finished exports (`exports.json`), the races' figures (`benchmark.json`), its temporary files, whisper.cpp models and the client models it fetched itself (`models/`), and the studio (`studio/`). |
| `--whisper`         | `ONE_TAKE_WHISPER`              | found on `PATH`                     | The whisper program for transcripts: `whisper-cli` (whisper.cpp) or `whisper` (openai-whisper).                                                                                                                     |
| `--whisper-model`   | `ONE_TAKE_WHISPER_MODEL`        | `base.en` / first `ggml-*.bin` found | A model name for openai-whisper, a `ggml-*.bin` file for whisper.cpp.                                                                                                                                               |
| `--studio-python`   | `ONE_TAKE_STUDIO_PYTHON`        | `<data dir>/studio/venv/bin/python` | A Python with the studio's packages (ClearerVoice-Studio), instead of the environment `npm run studio` makes.                                                                                                       |
| `--no-studio`       | `ONE_TAKE_STUDIO=0`             | off                                 | Skip the studio check at start-up; its switches stay greyed out.                                                                                                                                                    |
| `--ffmpeg`          | `FFMPEG_PATH`                   | found on `PATH`                     | Path to the ffmpeg binary.                                                                                                                                                                                          |
| `--ffprobe`         | `FFPROBE_PATH`                  | found on `PATH`                     | Path to ffprobe (reported in capabilities; used by the e2e test).                                                                                                                                                   |
| `--static`          | `ONE_TAKE_STATIC`               | `packages/client/dist`              | Folder with the built client.                                                                                                                                                                                       |
| `--no-static`       |                                 | off                                 | API only; do not serve the client.                                                                                                                                                                                  |
| `--log-level`       | `ONE_TAKE_LOG_LEVEL`            | `info`                              | Fastify log level. `debug` or `trace` also logs every request.                                                                                                                                                      |
| `--allow-remote`    | `ONE_TAKE_ALLOW_REMOTE=1`       | off                                 | Accept requests from other machines. See [Security](#security).                                                                                                                                                     |
| `--fonts`           | `ONE_TAKE_FONTS`                | none                                | Extra font folders (separated by `:`) for drawing PowerPoint slides, searched before the system fonts.                                                                                                              |
| `--renderer-memory` | `ONE_TAKE_RENDERER_MEMORY_MB`   | half of RAM                         | Heap limit in MB for the PowerPoint renderer worker.                                                                                                                                                                |
| `--no-self-test`    | `ONE_TAKE_SELF_TEST=0`          | off                                 | Skip the start-up test of each hardware encoder and decoder.                                                                                                                                                        |
| `--no-benchmark`    | `ONE_TAKE_BENCHMARK=0`          | off                                 | Skip the encoder and decoder races after start-up (and ignore remembered figures).                                                                                                                                  |

## Where files go

Inside the folder you chose, an export passes through three names:

1. `lecture.1a2b3c4d.uploading.mp4` while the browser uploads (the eight characters are the start of the job id).
2. `lecture.1a2b3c4d.processing.mp4`, or a `lecture.1a2b3c4d.processing` folder for HLS and DASH, while ffmpeg runs.
3. `lecture.mp4`, or a `lecture` folder, when it is done.

File names are sanitised: path separators and characters that are illegal on Windows or macOS become `-`, reserved names such as `con` fall back to `lecture`, and names are cut at 120 characters. If the target exists you get `lecture (2).mp4` unless you asked to replace it. Cancelled and failed jobs remove their temporary files.

Jobs live in memory. The last 50 finished jobs stay in the job list. A server restart forgets in-flight uploads, and the client tells you to export again.

Subtitle and transcript files asked for in the export dialog are written next to the result with its name (`lecture (2).srt` for `lecture (2).mp4`; inside the folder for HLS and DASH) once it is done.

Finished exports are also written to `exports.json` in the data folder (`~/.one-take` by default): path, size, format, duration, codecs, the ffmpeg encoder that made each one, and its subtitle files. That file feeds the **Exports** list in the app and survives restarts; the videos themselves stay where they were saved. Deleting from the list removes the file (or the HLS/DASH folder, provided it still holds nothing but the export) and the entry; an entry whose file has gone can be dropped on its own. The file is written whole and renamed into place, and a damaged one is set aside rather than stopping the server.

The data folder also holds `benchmark.json` (the encoder and decoder races' figures, with the ffmpeg they are for and when they were measured; a week old or for another ffmpeg, they are measured again) and `models/`, where a client model the server had to fetch itself lands.

## Security

The server is meant for one person on one machine.

- It listens on `127.0.0.1` only.
- Every request must carry a loopback `Host` header (`localhost`, `127.0.0.1`, `[::1]` or anything ending in `.localhost`). Anything else gets `403 forbidden_host`. This stops DNS-rebinding attacks.
- Every request other than `GET` and `HEAD` must carry a loopback `Origin` (or none, for non-browser clients). Anything else gets `403 forbidden_origin`. This stops cross-site requests.
- JSON bodies are limited to 4 MB. Uploads are raw `application/octet-stream` streams and are not limited.
- Folder listing hides dot-files and reports whether a folder exists and is writable. It can list any folder the server's user can read, which is why the server only answers localhost.

Pass `--allow-remote` to switch the `Host` and `Origin` checks off, for example to record on a laptop and save on a desktop. Do that only on a network you trust, and combine it with `--host 0.0.0.0`.

## ffmpeg detection and encoders

On start the server runs `ffmpeg -version`, `ffmpeg -encoders` and `ffmpeg -muxers` and reports the result in `/api/capabilities`. The planner uses the lists to decide what is possible.

| Codec | Software encoders              | Hardware encoders (with the hardware switch on)             |
| ----- | ------------------------------ | ----------------------------------------------------------- |
| H.264 | `libx264`                      | `h264_videotoolbox`, `h264_nvenc`, `h264_qsv`, `h264_vaapi` |
| H.265 | `libx265`                      | `hevc_videotoolbox`, `hevc_nvenc`, `hevc_qsv`, `hevc_vaapi` |
| VP9   | `libvpx-vp9`                   |                                                             |
| AV1   | `libsvtav1`, then `libaom-av1` | `av1_nvenc`, `av1_qsv`, `av1_videotoolbox`                  |
| AAC   | `aac`, `aac_at`, `libfdk_aac`  |                                                             |
| Opus  | `libopus`                      |                                                             |

The first encoder in the preferred order that your ffmpeg has is used. The CRF value is mapped onto each encoder's own quality scale (VideoToolbox's 1 to 100, NVENC's `-cq`, QSV's `-global_quality`). H.265 output is tagged `hvc1` so Apple players accept it.

## HTTP API

All endpoints are under `/api`. Bodies and answers are JSON unless noted. The zod schemas in `packages/shared/src/api.ts` are the source of truth: the server validates every request against them and the TypeScript types are inferred from them, so client and server cannot drift apart.

### Endpoints

| Method   | Path                                        | What it does                                                                                                                                                                      |
| -------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/health`                               | `{ ok, name, version }`.                                                                                                                                                          |
| `GET`    | `/api/capabilities`                         | Server version, platform, home and default folders, ffmpeg info (path, version, encoders, muxers), ffprobe path, and shortcut folders for the picker.                              |
| `GET`    | `/api/system`                               | The system check: CPU, memory, GPU, disk, verified hardware encoders and decoders, the races' figures and tier.                                                                   |
| `GET`    | `/api/system/load`                          | How busy the machine is right now: whole-machine CPU use since the previous call, memory, and the server process. The export view polls it once a second.                          |
| `GET`    | `/models/:name`                             | A client model file (the speaker model, the face model, the selfie segmenter) from wherever a verified copy is, fetched from its publisher first when there is none. `404` for a name not in the catalogue, `502 model_unavailable` with the reason when it is nowhere and cannot be fetched. |
| `POST`   | `/api/convert?name=deck.pptx`               | A PowerPoint file as `application/octet-stream`; answers with `application/pdf`. Renderer notes come in the `x-one-take-warnings` header.                                          |
| `GET`    | `/api/fs/list?path=&files=1`                | Lists a folder: entries, parent, whether it exists and is writable, and free bytes. `files=1` includes files. Defaults to the home folder.                                          |
| `POST`   | `/api/fs/mkdir`                             | `{ path }`. Creates a folder (and parents) and returns its listing.                                                                                                                |
| `GET`    | `/api/exports`                              | All jobs the server remembers, newest first.                                                                                                                                      |
| `POST`   | `/api/exports`                              | Creates a job. Returns `201` with the job.                                                                                                                                        |
| `GET`    | `/api/exports/:id`                          | One job.                                                                                                                                                                          |
| `PUT`    | `/api/exports/:id/data?offset=`             | A chunk as `application/octet-stream`, written at that byte offset. Returns `{ received }`.                                                                                       |
| `POST`   | `/api/exports/:id/finish`                   | `{ totalBytes }`. Closes the upload, checks the size, and starts processing.                                                                                                      |
| `GET`    | `/api/exports/:id/events`                   | Server-sent events: the current job first, then every change until it finishes.                                                                                                   |
| `DELETE` | `/api/exports/:id`                          | Cancels the job and removes partial files.                                                                                                                                        |
| `POST`   | `/api/exports/:id/reveal`                   | Opens the file manager at the result (`open -R`, `explorer /select`, or `xdg-open`).                                                                                              |
| `GET`    | `/api/library`                              | Every export the server has finished, newest first, with whether each is still on disk and its size now.                                                                          |
| `GET`    | `/api/library/:id`                          | One export record.                                                                                                                                                                |
| `GET`    | `/api/library/:id/file`                     | The video itself, with `Range` support, for the in-app player. `409 not_a_file` for HLS and DASH folders.                                                                          |
| `POST`   | `/api/library/:id/reveal`                   | Opens the file manager at the export.                                                                                                                                             |
| `POST`   | `/api/library/:id/open`                     | Opens the export with the default application (the video player, or the folder).                                                                                                  |
| `DELETE` | `/api/library/:id`                          | Deletes the file or export folder (and its subtitle files) and forgets the record; `?files=0` only forgets it. Returns `{ record, deleted }`.                                       |
| `POST`   | `/api/transcribe?language=en&duration=5400` | 16 kHz mono WAV as `application/octet-stream`; answers `201` with a running transcription job. `language` is a code or `auto`.                                                     |
| `GET`    | `/api/transcribe/:id`                       | The job: `state`, `progress` (0..1), `message`, and when done `words` (`[{ text, start, end }]`, seconds into the audio sent) and `language`.                                       |
| `GET`    | `/api/transcribe/:id/events`                | Server-sent events with the job as it changes.                                                                                                                                    |
| `DELETE` | `/api/transcribe/:id`                       | Cancels it.                                                                                                                                                                       |
| `POST`   | `/api/studio`                               | A studio job from its manifest (the clips, what each needs, the voice profile); answers `201` with the job, waiting for its uploads.                                              |
| `PUT`    | `/api/studio/:id/audio`                     | Every clip's 16-bit PCM in order, as `application/octet-stream`.                                                                                                                  |
| `PUT`    | `/api/studio/:id/faces`                     | Every clip's mouth crops (JPEG frames, each after its little-endian uint32 length), in order.                                                                                     |
| `POST`   | `/api/studio/:id/start`                     | Checks the uploads against the manifest and queues the work.                                                                                                                      |
| `GET`    | `/api/studio/:id`                           | The job: state, progress, each clip's result and figures.                                                                                                                         |
| `GET`    | `/api/studio/:id/events`                    | Server-sent events for the job until it finishes.                                                                                                                                 |
| `GET`    | `/api/studio/:id/clips/:clip/deep`          | A clip's deep clean (or `/voice`), as 16-bit PCM at the clip's rate, once the job says it is there.                                                                                |
| `DELETE` | `/api/studio/:id`                           | Stops the job; results already finished stay fetchable.                                                                                                                           |

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

| Status | Code                                          | When                                                                         |
| ------ | --------------------------------------------- | ---------------------------------------------------------------------------- |
| 400    | `bad_request`                                 | The body or query failed validation (`details` lists the zod issues).        |
| 400    | `directory_not_writable`                      | The destination folder does not exist or cannot be written.                  |
| 400    | `ffmpeg_missing`                              | The job needs ffmpeg and the server has none.                                |
| 400    | `disk_full`                                   | Not enough free space for the estimate.                                      |
| 400    | `folder_not_empty`                            | You asked to replace a folder that holds files One Take did not make.        |
| 400    | `studio_unavailable`                          | The studio is not set up on the server, or the model a job needs is missing. |
| 400    | `transcription_unavailable`                   | No whisper on the server, or whisper.cpp without a model.                    |
| 403    | `forbidden_host`                              | The `Host` header is not loopback.                                           |
| 403    | `forbidden_origin`                            | A non-GET request came from a non-loopback origin.                           |
| 404    | `job_not_found`                               | Unknown job, usually because the server restarted.                           |
| 404    | `export_not_found`                            | The export is not in the library (already deleted or forgotten).             |
| 404    | `transcription_not_found`                     | Unknown transcription job, usually because the server restarted.             |
| 404    | `studio_not_found`                            | Unknown studio job, usually because the server restarted.                    |
| 404    | `not_found`                                   | No such route.                                                               |
| 409    | `not_uploading`                               | Data or finish arrived for a job that is no longer uploading.                |
| 409    | `no_output`                                   | Reveal was asked for a job that has no result yet.                           |
| 409    | `file_missing`                                | The library entry's file is no longer where it was saved.                    |
| 409    | `not_a_file`                                  | The in-app player asked for an HLS or DASH folder.                           |
| 409    | `folder_not_empty`                            | Deleting an export folder that has gained files One Take did not make.       |
| 409    | `studio_started`                              | An upload for a studio job that has already started.                         |
| 409    | `studio_not_ready`                            | A clip's result that is not there yet.                                       |
| 500    | `internal`, `reveal_failed`, `too_many_files` | Something went wrong on the server.                                          |
