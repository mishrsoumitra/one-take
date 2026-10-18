# One Take

Turn your slides and your voice into a lecture video, without ever pressing pause.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node 22+](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6.svg)

You load your slides, you start the mic, and you talk. Only the moments you speak are kept. Stop to think for as long as you like: nothing of the pause goes into the video, and when you speak again the new phrase lands right after the last one. Change slides as you talk and the video follows you. When you are done, you export the video, and it sounds like you said it all in one take.

Everything runs on your own computer. The browser records and encodes, and a small local server saves the file into a folder you choose. Nothing leaves your machine.

## Contents

- [What you need](#what-you-need)
- [Quick start](#quick-start)
- [Your first video in five steps](#your-first-video-in-five-steps)
- [What else it can do](#what-else-it-can-do)
- [The guides](#the-guides)
- [Privacy](#privacy)
- [License](#license)

## What you need

| What                                 | Why                                                                                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js 22 or newer                  | Runs the local server and the build. The repo's `.nvmrc` pins Node 24.                                                                                   |
| Chrome or Edge                       | The full experience: fast encoding with WebCodecs, files streamed straight to disk, the mic through an AudioWorklet. See [Browser support](docs/development.md#browser-support). |
| A microphone                         | A headset or a USB microphone gives the cleanest cut. The laptop's own mic works too.                                                                     |
| ffmpeg (optional)                    | For HLS, DASH, compression and MP4 files that play while they download. Without it you still get MP4, MOV, MKV and WebM, written by the browser.         |
| An internet connection, once         | Two small models (29 MB) are fetched the first time. After that nothing is fetched.                                                                      |
| Python 3.10 to 3.13 or uv (optional) | Only for the studio: the deep clean and keeping only your voice at export time. See [The studio](docs/studio.md).                                         |

Install ffmpeg with your package manager:

```sh
brew install ffmpeg            # macOS
sudo apt install ffmpeg        # Debian / Ubuntu
winget install Gyan.FFmpeg     # Windows
```

The server looks for `ffmpeg` on your `PATH` and in the usual places (`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `C:\ffmpeg\bin`, `C:\Program Files\ffmpeg\bin`). You can also point it at one with `--ffmpeg`.

## Quick start

```sh
git clone https://github.com/mishrsoumitra/one-take.git
cd one-take
npm start          # http://127.0.0.1:4317
```

`npm start` is the only command you need. Every time you run it, it does whatever is still to be done, says so, and starts the server:

1. It installs the dependencies when `node_modules` is missing or older than `package-lock.json`.
2. It builds the code when a source file changed since the last build. This takes a few seconds, and nothing happens when nothing changed.
3. It fetches the two models for the voice check and the lip check (29 MB, once, while you are online). If you are offline, that is only a note: the server fetches a missing model itself the first time the app asks for it.
4. It starts the server. Anything after `--` goes to the server: `npm start -- --port 4317 --dir ~/Movies/One\ Take`.

Open the address in Chrome and you are ready. The one thing `npm start` does not do is set up the studio (1.7 GB of models and a Python environment). That is `npm run studio`, and you only need it for the deep clean and *Only my voice* at export time.

For development, `npm run dev` starts the server on port 4317 and a Vite dev server on port 5173 with hot reload. Open http://localhost:5173.

## Your first video in five steps

1. **Load your slides.** Drop a PDF, a PowerPoint file (`.pptx`, `.ppsx`, `.pptm`) or a set of images anywhere on the page. Keynote and Google Slides: export as PDF or `.pptx` first.
2. **Start the mic and talk.** Click **Start mic** and allow the microphone. The first time, the app asks you to read for twenty seconds so it can learn your voice; you can skip that. Then just talk. Watch the **Mic level** meter: your voice should cross the white line. If it doesn't, move the **Speech line** slider down until it does.
3. **Change slides as you go.** Use `→` and `←`, `PageDown` and `PageUp`, a presenter clicker, or click a thumbnail. Change slides in the middle of a sentence if you like; the sentence stays whole.
4. **Check it.** Click **Preview** to hear what you have. Click **Edit** to re-record a clip, cut a stretch, or move things around.
5. **Export.** Click **Export video**, pick a folder and a format, and press **Export**. When it's done, **Show in folder** takes you to the file.

Said something wrong? Press `Backspace` and say it again. Need to talk to someone in the room? Press `M` to mute. The full list of keys is in [Keyboard shortcuts](docs/recording.md#keyboard-shortcuts).

## What else it can do

- **Pauses are cut, your voice never is.** The app listens for a human voice, not for loudness, so a fan, typing, a chair or a breath never becomes a phrase, and a sentence that trails off is kept to the end. Every cut is made after the phrase is finished, with the whole of it in view.
- **The room's noise is taken out live.** DeepFilterNet3 removes fans, typing, traffic, music and other people talking before anything is recorded. A plain classic filter and *Off* are there too.
- **It knows whose voice it is.** Your camera watches your lips and every phrase is compared with a profile of your voice. A phrase that was somebody else is marked in the timeline within a second.
- **Your camera in the picture.** Record your webcam along with your voice and put the picture in any corner, or anywhere on the slide, at any size.
- **Draw on the slides.** A pen and a highlighter, in seven colours. Your strokes go into the video just as you made them, and they stay on the slide for the phrases after them.
- **Two ways to drive the mic.** *Auto* listens all the time and decides for you. *Press to speak* records only while you hold `Space`.
- **An editor.** Re-record a clip, cut a stretch of audio, split a clip, move it to another slide, add a clip anywhere, remove every pause, and undo all of it.
- **Any format, any quality.** MP4, MOV, MKV, WebM, HLS and DASH; 360p to 4K; H.264, H.265, VP9 or AV1; compression and adaptive streaming with ffmpeg; your hardware encoder when you have one.
- **Faster, cleaner, with subtitles.** Play the lecture at up to 2× with the voice keeping its pitch, even out the volume, cut the "um"s, and add subtitles and a transcript with whisper.
- **A studio for the export.** Heavy models on the local server deep-clean the recording and keep only your voice where another voice was heard.
- **Nothing is lost.** Every phrase is saved the moment it ends. Close the tab, come back tomorrow, and everything is still there.
- **Built for long lectures.** A three-hour lecture exports without ever being assembled in memory.

## The guides

| Guide                                                       | Read it when you want to…                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [Recording](docs/recording.md)                              | load slides, set up the mic, choose Auto or Press to speak, record your camera, draw on the slides             |
| [Preview and editing](docs/editing.md)                      | listen back, reorder, re-record, cut, split, add or remove clips, remove pauses                                |
| [Exporting](docs/exporting.md)                              | choose a format and quality, compress, stream, speed up, cut filler words, add subtitles, find your exports    |
| [The studio](docs/studio.md)                                | deep-clean the recording and keep only your voice, with models on the local server                            |
| [How recording works](docs/how-recording-works.md)          | understand what counts as speech, the noise filter, the voice and lip checks, and what is saved where           |
| [How exporting works](docs/how-exporting-works.md)          | understand the export stages, large exports, the system check and the hardware encoder                         |
| [The server and its API](docs/server.md)                    | run the server with options, know where files go, or talk to it over HTTP                                      |
| [Development](docs/development.md)                          | read the code layout, run the tests, drive the end-to-end runs, know which browsers work                       |
| [Troubleshooting](docs/troubleshooting.md)                  | fix something that is not working                                                                              |

## Privacy

Your audio, your camera's picture and your drawings never leave your computer. The browser keeps your phrases in IndexedDB, the server writes only to the folder you pick, and no request carries anything of yours anywhere. The only download the app ever makes is the one-time fetch of the models, and it carries nothing of yours. There is no analytics, no account and no cloud. The details are in [How recording works](docs/how-recording-works.md#privacy).

## License

MIT. See [LICENSE](LICENSE).
