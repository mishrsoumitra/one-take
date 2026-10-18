# How recording works

You don't need any of this to use the app. Read it when you want to know why a phrase was cut where it was, how the fan was taken out, how the app decided a phrase was somebody else's, or where your recording lives.

## Contents

- [What counts as speech](#what-counts-as-speech)
  - [The voice detector](#the-voice-detector)
  - [The first listen, live](#the-first-listen-live)
  - [The second listen, with hindsight](#the-second-listen-with-hindsight)
  - [The settings](#the-settings)
  - [The gate](#the-gate)
- [The noise filter](#the-noise-filter)
- [Who is speaking](#who-is-speaking)
  - [The lip check](#the-lip-check)
  - [The voice check](#the-voice-check)
  - [The verdict](#the-verdict)
  - [What it needs, and what it costs](#what-it-needs-and-what-it-costs)
- [The pen](#the-pen)
- [Saving your work and resuming](#saving-your-work-and-resuming)
- [Privacy](#privacy)

## What counts as speech

The microphone first goes through the noise filter. Then it is listened to twice: once live, 10 ms at a time, to notice that something that could be a voice is going on, and once more when the phrase is finished, with the whole of it in view, to decide what to keep. The live listen never cuts anything. The second one makes every cut. Both use the same arithmetic.

### The voice detector

The detector (`packages/client/src/core/voice.ts`) is plain signal processing: no model, nothing trained, no weights, so every rule in it can be read and argued with. The microphone is low-passed and resampled to 16 kHz and cut into 32 ms frames. The detector looks at each frame together with the one before it, a 64 ms window, and gives it a score from 0 to 1 for "someone is speaking". Three things go into the score, multiplied together:

- **Standing out from the room.** The window's power in eight bands between 100 Hz and 5 kHz is compared with an estimate of the room's noise in each band, the *floor*. A fan, an air conditioner, a hum, hiss, and the gain creeping up under automatic gain control all live in the floor, so they score nothing however loud they are. Only sound that is new on top of it counts. The score ramps from 0 at 3 dB over the floor to 1 at 10 dB. Where the floor comes from is the difference between the two listens, below.
- **Being voiced.** A voice is made by the vocal folds opening and closing 50 to 400 times a second, which makes the waveform repeat at that period. Noise, typing, breath, a chair or a door have no such repeat. The spectrum between 80 Hz and 1.5 kHz is first flattened, which leaves a voice's harmonics standing as a comb and turns the smooth rumble of a fan into white noise. The result is matched against itself at every lag in the pitch range, and the strongest true peak is the repeat strength, worth 0 at 0.3 and 1 at 0.6. A peak counts fully only when its pitch carries on from the frame next to it, within 15 % or an octave: a voice holds its pitch from one frame to the next, a chance repeat in noise does not. The range reaches down to 50 Hz, so a deep voice, and the creak many speakers drop into at the end of a sentence, are heard as voices.
- **Changing.** Nobody speaks in a sound that holds one level for a second and a half. When the speech-band energy over 1.5 s spans less than 6 dB, the score is scaled down, to nothing at 3 dB. That rules out a tone or a hum that happened to switch on, and lets the floor absorb it.

The score has a short release (each frame keeps at least 60 % of the one next to it), so one weak frame inside a word does not flicker. Whispering, which has nothing voiced in it, is not heard as a voice, and neither is an "s" on its own; the pre-roll, the hangover and the tail around what is heard cover those.

### The first listen, live

The live phrase detector (`packages/client/src/core/vad.ts`) hears each block once and has to answer at once, so it is lenient on purpose and never makes a cut.

Its floor is a running estimate. It falls at once when the room goes quieter, rises only after half a second with nothing that could be a voice in it, and is never left under the quietest the room has been in the last two seconds. So a sound that switches on and stays on becomes the room's new noise within two seconds.

A block is *heard* when the score says it could be a voice (0.35 to open a phrase, and only 0.15 to keep one open) and, until the phrase has started, the level is over the speech line. A phrase opens after 30 ms heard and keeps 200 ms of pre-roll from before that, so the first syllable is never clipped. It stays open through anything that scores 0.15 or more, which a soft aside, a sentence trailing off or a low creaky ending does. It ends only after two seconds (or *Phrase ends after*, whichever is longer) with nothing voice-like at all, of which 150 ms is kept.

A loud sound that is not a voice (typing, a breath, a chair, a fan, a door) does not open a phrase, and a faint voice under the line does not either.

### The second listen, with hindsight

When a phrase is finished it goes through `packages/client/src/core/hindsight.ts` before it is stored. The same three things are measured, by the same arithmetic, but every frame is judged knowing what came before and after it:

- **The floor is the quietest the room has been within two seconds either side of the frame.** The live floor can only look back, and has to rise during a long quiet stretch to absorb a fan that switched on. A quiet voice looks like a long quiet stretch to it, so the live floor can climb into a soft sentence until the sentence stands over nothing. That is how a sentence spoken softly used to get cut. With hindsight the floor under a soft sentence is the gap before or after it, so the sentence stands over the room however softly you said it.
- **A pitch counts as carried when it continues from the frame before or into the frame after.** So the first voiced frame of every word, which live can only be halved, counts in full.
- **Steadiness is measured around a frame**, not behind it, and a weak frame is lifted by the frames on either side of it.

The scores then go through the rules in `packages/client/src/core/silence.ts`. A stretch of voice begins at a frame scored 0.5 and goes on while the score stays over 0.35. It is padded with the pre-roll in front and the tail behind. A pause longer than *Phrase ends after* between two stretches is cut, splitting the phrase in two. A stretch shorter than the minimum phrase is dropped. A phrase with no voice in it at all (a chair, typing, a fan switching on) is dropped altogether, and a sliver of silence of up to 0.3 s at either end is left alone. A sentence split across slides stays joined as long as nothing was cut at the seam.

The second listen gets through a minute of audio in well under a second, so a phrase shows up in the timeline a moment after it ends. Phrases are stored in the order they were spoken, however long each takes, and `Backspace` while one is still being gone over drops it.

On the test recordings (`packages/client/test/hindsight.test.ts`, macOS text-to-speech), the second listen keeps every word of a woman's voice, a man's voice and a deep voice with a 58 Hz pitch; keeps a sentence that drops 25 dB in the middle, and one 20 dB softer standing on its own between two pauses; keeps 90 % or more of the words through a fan 10 dB under the voice; and finds no phrase in a fan, a humming fan, hiss, typing, a tone, a fan switching on or swelling, or gain creeping up 20 dB over ten seconds.

**Remove pauses** in the editor applies the same second listen to clips that are already recorded: every clip is scored from start to end with hindsight, a pause longer than *Phrase ends after* splits the clip, a stretch of voice shorter than the minimum phrase is dropped, a clip with no voice at all is removed, and silence of up to 0.3 s at either end is left alone. A clip that continued a split sentence stays joined to it unless the cut reached the seam. The editor's own **Record** goes through the same two listens as the main recording.

### The settings

| Setting                 | Default  | What it does                                                                                              |
| ----------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| Speech line (threshold) | −45 dBFS | Sound under this never opens a phrase, however voice-like.                                                |
| Phrase ends after       | 0.7 s    | A pause this long is cut by the second listen, splitting the phrase. Shorter pauses stay in the recording. |
| Pause between phrases   | 0.15 s   | Silence inserted between phrases in the video. Plus 0.25 s on a slide change.                             |
| Pre-roll (fixed)        | 200 ms   | Audio from before the trigger that is kept, so the first syllable is never clipped.                       |
| Tail (fixed)            | 150 ms   | How much of the trailing silence is kept.                                                                 |
| Minimum phrase (fixed)  | 200 ms   | Bursts shorter than this (a click, a cough) are dropped.                                                  |
| Live hold (fixed)       | 2 s      | How long a live phrase stays open with nothing voice-like heard before it is finished and gone over.      |

A few more rules:

- A phrase starts after 30 ms (three blocks) heard.
- Changing slides mid-phrase splits it. The part spoken so far is stored on the old slide, and the rest continues on the new slide, joined without a gap, as long as the second listen cut nothing at the seam. A continuation is kept however short it is, as long as something was said on the new slide. A slide skipped past mid-sentence, or a change that lands right at the end of a sentence, stores nothing.
- Muting, stopping the mic, previewing, exporting, switching modes, putting the pen on the slide, and (in Press to speak) letting go of the key all end the current phrase.
- Opening the microphone takes a moment. A stop that arrives while it is still opening wins, a second start joins the one in progress instead of racing it, and a held `R` or `M` key does not toggle on auto-repeat.

### The gate

The recorder (`packages/client/src/core/recorder.ts`) opens a gate in front of the detector when the mic may be heard: in Auto whenever the mic is on and not muted, in Press to speak only while the key or button is held, never during a preview or an export, and never while the pen is on the slide. While the gate is closed the detector only feeds the level meter. It keeps nothing, not even pre-roll, so a phrase can never begin with sound from before a press or from a muted stretch. Inside an open gate both modes behave the same: pre-roll, hold, tail and the second listen all apply, which is why a press is trimmed at both ends and a long pause inside a press is still cut.

The microphone is opened in mono with echo cancellation, Chrome's own noise suppression and automatic gain control turned on. Capture runs in an AudioWorklet, with a ScriptProcessor fallback for browsers that lack it.

## The noise filter

The **Noise filter** list under the level meter has three choices. Whichever runs does so on the audio thread, before the voice detector, the recorder or the voice check hears anything.

**Deep** (the default) is DeepFilterNet3, a trained model that takes out fans, typing, traffic, music and other people talking, at the full 48 kHz band. It is the `libDF` runtime compiled to WebAssembly, in its own AudioWorklet, from the `@workadventure/noise-suppression` package. The model and the runtime (22 MB) come with the app; nothing is fetched elsewhere. The app's audio context runs at 48 kHz for it.

A few things to know about it. It may take out up to 40 dB; unlimited attenuation would silence the room between words, which sounds like dropouts. It adds about 40 ms of delay and costs a few per cent of one core on a recent laptop. While it loads, the classic filter stands in. Chrome's own noise suppression is turned off under it, so the two do not fight. And the worklet measures its own cost: when it spends more than 60 % of real time over two windows in a row, the machine cannot keep up, the classic filter takes over for the rest of the session, and a message says so.

**Classic** is plain signal processing for steady noise only, in `packages/client/src/core/denoise.ts`: no model, nothing trained, every number a rule. The sound is cut into 21 ms frames that overlap by half, each frame is turned into its spectrum (bins about 47 Hz wide), and every bin of every frame goes through three steps:

- **Learning the room.** Each bin keeps a *floor*, its estimate of the noise there. For the first half second the floor is simply the average so far, since nobody is speaking yet. After that the bin's power, smoothed over its neighbours and over frames, is compared with the quietest it has been in the last second or two. A bin that stands more than 7 dB over that is judged to hold a voice and its floor stays put; otherwise the floor follows the power. A fan, a hum or hiss hold their level, so they are the quietest the bin has been and become the floor within a second or two of switching on. A voice keeps changing and never does.
- **Judging what stands over it.** The *measured* ratio is how far the frame's power stands over the floor. The *believed* ratio, what is taken to be voice on top of the floor, comes mostly (98 %) from what the filter kept of the previous frame and only a little from this one. That memory is what stops the result from twinkling: a bin that stood out for one frame by chance is not believed, a harmonic a voice keeps going for a few frames is.
- **Scaling the bin.** The two ratios give the bin's gain through the Ephraim-Malah log-spectral amplitude estimator, the gain with the least expected error in the log of the amplitude, which matches how loudness is heard. A bin believed to be all noise goes down to the gain floor, 24 dB; a bin believed to be all voice is left alone. Nothing is ever scaled under the floor, so what is left of the room sounds like a quieter room rather than a flutter of tones.

The frames are put back together through windows that add up to one, so a clean voice comes out as it went in, 21 ms later. On the test recordings a fan, a humming fan, hiss or white noise drops by about 20 dB from the first second, a clean voice comes through within a decibel of itself, and a fan that switches on mid-recording is absorbed within three seconds. The classic filter cannot take out sounds that keep changing, such as a voice from the next room, music or typing, because they never become the floor. That is what the deep one is for. It takes about a millisecond per second of audio, and the choice takes effect without reopening the microphone.

**Off** leaves only what Chrome does on its own.

A headset or USB microphone gives the cleanest cut whichever filter runs.

## Who is speaking

Two checks run while you record, and together they say, for every phrase, whether it was you. A phrase that was someone else gets an **Another voice** badge in the timeline within a second of the phrase ending, and the reasons sit in the badge's tooltip. A phrase the two checks disagree on gets **Not sure whose voice**. Your own phrases get no badge, only the reasons on hover. The verdict is stored with the phrase, so it is still there after a reload, and it changes nothing by itself: delete the phrase with its ✕, or keep it.

### The lip check

With a camera chosen in the **Camera** list, its picture goes to MediaPipe's Face Landmarker in a worker (`packages/client/src/vision/lips.ts`, `workers/lips.worker.ts`). Up to twenty times a second it finds 478 points on your face, and four of them are read: the inside edges of the upper and lower lip, and the two corners of the mouth. The gap between the lips over the width of the mouth is how open your mouth is, a number that does not change when you lean towards the camera or away from it: about 0 shut, 0.5 for an open "ah". Each frame becomes a sample with the time it was seen.

When a phrase has been stored, the samples inside its span are looked at together: the swing of the opening (the gap between its 10th and 90th percentiles) and how much it moved from frame to frame. A swing of 5 % of the mouth's width, or a mean move of 2 % per frame, means your lips were moving; less means they were still. With no face in view for most of the phrase, or fewer than six frames, the camera has nothing to say. The frames are matched to the phrase by the time they reached the page, allowing for the filter's delay, which is why a phrase is judged over its whole span and never over a split second. The small mirror in the corner of the stage shows what the camera sees and whether a face is in view. The picture never leaves the page.

### The voice check

The first time you start the mic, you read for twenty seconds. The stretches the voice detector hears a voice in are cut into windows of four seconds, every two seconds, each window goes through a speaker-embedding model, and the mean of the vectors is your **voice profile**: 256 numbers that say what your voice sounds like and, as far as the model can manage, nothing about what you said. At least eight seconds of voice have to come through for a profile; the enrollment says so and offers to go again when they do not.

The model is WeSpeaker's ResNet34 trained on VoxCeleb, the ONNX file that sherpa-onnx publishes, run by onnxruntime-web's WebAssembly backend in a worker (`packages/client/src/speaker/voice-check.ts`, `workers/speaker.worker.ts`). It is fed Kaldi's 80-band log mel filterbank with each band's mean over the clip taken out (`core/fbank.ts`, matched number for number against kaldi-native-fbank), which is what makes the vector deaf to the microphone's colour and the level.

While a phrase is being spoken, its audio (after the noise filter) goes to the worker as it comes and is embedded window by window as the windows become due, so when the phrase ends only the tail is left to do. The voice check's answer lands a few hundred milliseconds after the phrase, however long the phrase was. The phrase's vector is the mean of its windows', and it is compared with the profile by the cosine between the two: 1 for the same direction, 0 for unrelated. On the model's own test speakers the same voice scores 0.5 to 0.9 and another voice at most 0.4; on macOS's text-to-speech voices the same voice scores 0.87 or more and another one 0.63 at most. The bars are **0.5 and above is you**, **0.35 and below is another voice**, and between the two is doubt. A phrase with less than 0.8 s of voice is not judged by the voice check.

### The verdict

`core/identity.ts` reads the pair off a table:

| Voice says \ lips say | moving   | still   | no face in view | camera off   |
| --------------------- | -------- | ------- | --------------- | ------------ |
| you                   | you      | not sure | you            | you          |
| another voice         | not sure | another | another         | another      |
| in doubt              | you      | another | not sure        | not sure     |
| no profile            | you      | another | (no verdict)    | (no verdict) |

When the two agree, that is the verdict. When one has nothing to say, the other decides, and a voice in doubt by itself stays in doubt. When they disagree (a voice unlike yours while your lips moved, or your voice over still lips), neither is trusted alone and the phrase is marked as not sure, with both reasons, so you can listen and decide. A phrase split by a slide change is judged piece by piece against the camera, with the voice check's one answer for the whole phrase.

### What it needs, and what it costs

- **Chrome or Edge** for the lip check, which hands the camera's frames to a worker with `MediaStreamTrackProcessor`. The voice check and the deep filter run wherever AudioWorklet and WebAssembly do.
- **Three models.** DeepFilterNet3 (8 MB) and its runtime (15 MB) come with the app. The speaker model (25 MB) and the face model (4 MB) are fetched once: `npm start` or `npm run models` puts them in `packages/client/public/models`, and the server serves them from there, or from wherever else a copy with the right SHA-256 is. A model that is nowhere is fetched by the server itself from its publisher the first time the app asks, into `~/.one-take/models`, checked and kept, so a machine is only ever asked once. The server does the fetching rather than the browser because GitHub's release downloads, where the speaker model lives, carry no CORS header and a page is refused them. Nothing is ever uploaded.
- **Time.** The face model answers in a few milliseconds a frame on the GPU. The speaker model takes about 70 ms per second of speech on one CPU thread in Python and a few times that in WebAssembly, which the windows hide. In the headless check on an M2 Max every verdict landed 125 to 550 ms after the phrase ended.
- **What it cannot do.** The checks tell your voice from a different one. A voice very like yours, or your own voice played back from a speaker, can pass. A face turned well away from the camera, or in the dark, is "no face in view", and the voice check decides alone. The voice profile is made once; if your voice changes a lot (a cold, a different microphone, a different room), click **Learn my voice** and read again.

## The pen

A drawing is a clip like a phrase, with silence for its sound (`packages/client/src/core/ink.ts`). Each stroke keeps its tool, its colour, its width as a share of the slide's width, and its points as fractions of the slide with the time of each, in milliseconds from the start of the clip. So the same stroke lands on the same spot on the stage, in the preview and in the exported video at any resolution, and appears in the video at the same moment it appeared under your hand.

While you draw, the clip is open. The pen touching the slide tells the recorder, which ends the phrase being spoken and closes the gate. The pen leaving the slide opens the gate again, so a voice during the rest ends the drawing. When the pen has rested for 1.2 s, the clip is finished: the pauses between strokes are shortened to 0.4 s at most, a tail of 0.15 s follows the last point, and the clip is stored in its turn behind any phrase still under its second listen, so clips always land in the order you made them. A wipe is a drawing with no strokes that clears the slide at its start, 0.4 s long.

What a clip shows is its *board*: every stroke drawn by earlier clips on the same slide, back to the last wipe. The board is worked out from the order of the clips, so a reorder in the editor, a cut, a split and both export orders all agree. The export draws the board under the camera picture and the subtitle, redrawing a frame only when a stroke gained a point. The pen cannot cut the sound of a phrase or re-encode the camera; it only adds clips and reads the order.

## Saving your work and resuming

Everything is written to IndexedDB (database `one-take`) the moment it exists:

- the slide source (the PDF or the image files), so slides can be rendered again,
- every phrase as 16-bit PCM with its slide, its sample rate and whether it continues the phrase before, its raw copy when the filter was on, its picture when the camera was on (the encoded frames the camera produced, about 4 MB a minute), and its strokes when it is a drawing; an edit writes the changed phrases back the moment it is made,
- the project state: phrase order, current slide, your detector settings and the last export settings.

The recording mode (Auto or Press to speak), the theme, the tips setting, the microphone, the noise filter, the Record switch (voice, camera, pen), which camera, where its picture goes and how big it is, the pen's tool, colour and width, and the hardware encoder switch are browser preferences, kept in `localStorage` rather than with the project. The list of exported videos lives on the server side (see [Where files go](server.md#where-files-go)).

Reload the tab, or close it and come back, and you continue where you left off. The **×** after the deck's name clears all of it. If IndexedDB is unavailable (some private windows), the app still works but nothing is persisted, and a warning goes to the console.

## Privacy

Audio, the camera's picture and the drawings never leave your computer. The browser keeps phrases in IndexedDB, the server writes only to the folder you pick, and no request carries anything of yours anywhere.

Speech is detected in the browser by plain arithmetic. The three models that run in the browser (the deep noise filter, the speaker model, the face model) are fetched once, from GitHub and from Google's model storage, by `npm run models` or by the local server the first time the app asks for them, checked against their SHA-256 and kept on this machine. That download is the only request the app ever makes beyond your own computer, and it carries nothing of yours. Your voice profile is 256 numbers in this browser's localStorage, and the verdicts are stored with the phrases.

The studio's models run on the local server, in a Python environment `npm run studio` makes. Their checkpoints come from Hugging Face once, through that command alone, and the audio and the mouth films they work on are files in the server's data folder that are deleted when the job is done. There is no analytics, no account and no cloud.
