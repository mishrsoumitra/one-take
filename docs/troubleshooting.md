# Troubleshooting

Find the line that sounds like your problem. Each one says what is going on and what to do.

## Contents

- [Recording](#recording)
- [The camera, the pen and the checks](#the-camera-the-pen-and-the-checks)
- [Exporting](#exporting)
- [Models, whisper and the studio](#models-whisper-and-the-studio)
- [Other](#other)

## Recording

**Nothing is recorded when I talk.** Watch the **Mic level** meter. Your voice must cross the white line. Lower the **Speech line** slider until it does, or move closer to the microphone. Check that the right microphone is selected and that the page is not muted (`M`). The note under the meter shows the voice detector's score; if it stays low while you talk, the microphone is picking you up too faintly, or the room is so loud that your voice does not stand out from it. Move closer to the microphone, or use a headset.

**The recording starts on its own.** Something crosses the line and the voice detector hears a voice in it: a TV, a radio, people talking nearby. Raise the **Speech line** slider so that only your own voice goes past it, or switch to Press to speak.

**A long silence was kept inside a phrase.** That happens with a recording made before the voice detector was there. Click **Edit**, then **Remove pauses**: every stretch without a voice is cut out, and Undo brings it back if you disagree.

**A soft stretch of my voice was cut.** The cut is made after the phrase is finished, from the whole of it, so a quiet aside or a sentence that trails off should survive. If one does not, it stood less than 3 dB over the room's noise. Lower the room (the **Noise filter** on, a headset) rather than the **Speech line**, which only decides what can *open* a phrase. A whispered stretch longer than *Phrase ends after* is cut, since a whisper has nothing voiced in it.

**Phrases are cut off at the end.** Raise **Phrase ends after**. The default 0.7 s treats a longer pause as the end of a phrase. A phrase shows up in the timeline about two seconds after you stop talking: the live detector waits that long to be sure you have finished, then the second listen trims the wait away.

**The fan is in the recording.** Check that **Noise filter** under the level meter says **Deep** and that the note under the meter says *deep filter*. If the note says *classic filter* although Deep is chosen, the machine could not keep up with the model (a message said so when it gave way), and the classic filter is doing what it can: a steady fan, air conditioner, hum or hiss, about 20 dB, within three seconds of it switching on, but not sounds that keep changing. If your own voice comes out thin, try **Classic** or **Off**.

## The camera, the pen and the checks

**The Record switch goes back to Voice.** The browser refused the camera. Allow it in the address bar (the camera icon) and choose **Voice + camera** again. In the pen mode the pen stays, and the camera row says why there is no picture. If another app has the camera open, close it first. A camera that is unplugged while recording ends the picture there; the phrases already recorded keep theirs.

**The first phrase of a session has no picture for its first second.** The very first time the mic starts in a browser tab, the browser's audio input takes about a second to come up, and while it does no camera frame reaches the page. Every later start in the same tab is immediate. Start the mic, let the status pill say *Listening*, then begin; or start and stop it once before the lecture.

**I can't draw on the slide.** The pen works while the mic is on, in the **Voice + camera + pen** mode. The toolbar says *Start mic to draw* until then. A preview or an export also puts the pen away until it is over.

**My drawing ended before I was finished.** A drawing ends when the pen has rested for a little over a second, or the moment a voice is heard. If you paused to think between strokes, the next stroke simply starts a new drawing, right after the first; the video shows the two one after the other, on the same slide, with the first still on the board. If a voice ended it, that voice was recorded as a phrase after the drawing.

**My voice was not recorded while I was drawing.** That is by design: the voice and the pen are never recorded together. Say it again once the pen is up.

**A phrase of mine is marked as another voice.** Hover the badge; it says what each check saw. *Voice unlike yours* with a low match means the profile does not fit how you sounded: a cold, another microphone, a very different room. Click **Learn my voice** and read again. *Your lips were still* with your face in view means the camera did not see your mouth move while the voice went on: check that the mirror in the corner of the stage shows your face straight on, in the light. A verdict changes nothing by itself, so the phrase is still there to listen to and keep.

**The camera's mirror says no face in view.** Face the camera, and give it light from the front; a face in profile or in the dark is not found. If the mirror is missing, the **Camera** list is set to *Off (no lip check)*, the browser refused the camera, or this is not Chrome or Edge. The voice check then decides alone.

**The enrollment says too little of my voice came through.** It needs eight seconds of voice out of the twenty, as the voice detector hears it. Read out loud the whole time, closer to the microphone, with the level meter crossing the white line, and try again.

## Exporting

**The export dialog says the server is not reachable.** Start it with `npm start` and check that the page is open on the same host and port the server logs. In development the Vite page on 5173 proxies to the server on 4317; both must be running. Or choose **Save in browser**.

**ffmpeg not found.** Install it (see [What you need](../README.md#what-you-need)) or pass `--ffmpeg /path/to/ffmpeg`. Without ffmpeg, MP4, MOV, MKV and WebM still work; HLS, DASH and compression do not.

**"This browser cannot encode …".** The container needs a codec your browser does not have. Pick another container, set the codec to **Automatic**, or save to a folder with ffmpeg installed and let the server transcode.

**MPEG-TS segments need AAC audio.** HLS with `.ts` segments cannot carry Opus. Choose AAC, or fMP4 segments.

**Unknown export job after a restart.** Jobs live in memory. Restarting the server during an upload loses the job; export again.

**The folder cannot be replaced.** Replacing a folder is allowed only when it holds nothing but a previous One Take export. Choose another name or empty the folder yourself.

**The export runs on the CPU although this machine has a hardware encoder.** Open the export dialog and look under **This computer**: **Use the hardware encoder and decoder** must be ticked (it is, unless it was unticked once; the choice is remembered per browser), and the line under it lists the encoders and decoders found in the browser and in ffmpeg. On an Apple-silicon Mac that line may add that the CPU encoder measured faster on slides; that is information, not a decision. The *Smallest file* mode keeps ffmpeg on the software encoders by design.

**The system check says the hardware decoder failed a test decode.** ffmpeg lists the method but could not set it up (no device, a missing driver, a virtual machine). The CPU decodes and nothing else changes. `npm run doctor` repeats the test.

**Hardware encoder refused above 4K.** Many hardware encoders cap at 4096×2304. Untick **Use the hardware encoder and decoder** or pick a smaller size.

**A filler the list found is a real word, or a real "um" was missed.** The detector works from the sound's shape, not from a vocabulary, so it will sometimes mistake a held, isolated vowel ("oh…", "so…") for a hesitation, and miss a filler that runs straight into the next word. Untick the line to keep a stretch, or pick a lower sensitivity. Pick *Catch more* and go through the list to find the rest. A hesitation with a pause on both sides is the one it is surest of.

**The faster export sounds choppy.** Speeds above 2× stretch what the time-stretch can hide; keep to 2× or below for speech. Pauses are not shortened by the speed, so a lecture with long pauses gains less than the figure suggests. Use **Remove pauses** in the editor first.

**The pen moves in steps in the video.** Pick 24 or 30 fps in the export dialog. At 15 fps a stroke drawn in half a second is only eight frames long.

**A video is missing from Exports.** Only exports saved to a folder through the local server are listed. Files saved with **Save in browser** went wherever the browser put them. A listed video marked *not on disk* was moved or deleted outside the app; **Remove from list** drops the entry.

**Export in Safari or Firefox fails for a long lecture.** Those browsers assemble the file in memory. Use the server, or split the lecture.

## Models, whisper and the studio

**"Could not listen: wespeaker_en_voxceleb_resnet34_LM.onnx … could not be fetched."** The voice check's model is neither on the server nor in the browser's cache, and it could not be downloaded. The message says what was tried: the server not running, the server unable to reach GitHub, the publisher refusing the page. Run `npm start` (or `npm run models`) while the machine is online, then reload the page; no rebuild is needed. The server's start-up line `Models` says where each model was found.

**The transcript switch is greyed out.** The server found no whisper. Install one (`brew install openai-whisper`, or `brew install whisper-cpp` plus a `ggml-*.bin` model in `~/.one-take/models`), restart the server, and reopen the dialog. The note under the switch says what was found and, for openai-whisper, that the first run downloads the model.

**The deep clean and Only my voice are greyed out.** The server found no studio. Run `npm run studio` once (it needs `uv` or a Python 3.10 to 3.13, and fetches about 1.7 GB of models), restart the server, and reopen the dialog. The note under the switches says what was found. A phrase whose voice could not be kept (the studio says your voice was not found in it) stays as it was.

## Other

**A PowerPoint slide looks a little different.** Fonts the machine lacks are replaced by a stand-in with the same weight and style, which shifts line breaks. Pass the real fonts with `--fonts`. 3-D effects, soft shadows, embedded video, SmartArt animation and GIF or SVG pictures are approximated or skipped; the browser console lists what the renderer changed. For a pixel-exact result, export the deck as PDF.

**The mic works but the level meter is flat in headless Chrome.** You need `--use-fake-device-for-media-stream`, `--use-file-for-fake-audio-capture=<wav>` and `--disable-features=AudioServiceSandbox`. The e2e runner sets these.
