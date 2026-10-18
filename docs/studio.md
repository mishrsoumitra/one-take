# The studio: deep clean and only your voice

The **Sound** section of the export dialog can hand the heaviest work of the export to the local server: trained models that clean the whole recording and, where another voice was heard, keep only yours. This guide says how to set it up, what each switch does, and what it costs.

## Contents

- [What it works on](#what-it-works-on)
- [Setting it up](#setting-it-up)
- [The deep clean](#the-deep-clean)
- [Only your voice](#only-your-voice)
- [The flagged phrases](#the-flagged-phrases)
- [Three versions of every clip](#three-versions-of-every-clip)
- [The camera's picture](#the-cameras-picture)
- [What it costs](#what-it-costs)

## What it works on

While you record, every phrase is kept twice: the version the live noise filter cleaned (what you hear while you record) and the raw one, as the microphone heard it before any filter. The studio starts from the raw one, so nothing the live filter did stands in the model's way.

These models take their time, from seconds to minutes, and the dialog says how long on this computer. Each is a wait you can skip: untick the switch, or press **Continue without waiting for the studio** while it runs. What the studio had finished goes in, and the rest plays as it was.

## Setting it up

Run this once:

```sh
npm run studio
```

It makes a Python environment of its own under the server's data folder (`~/.one-take/studio/venv`, about 1.1 GB with PyTorch), fetches the three model checkpoints from Hugging Face (ClearerVoice-Studio's `MossFormer2_SE_48K`, 222 MB; `MossFormer2_SS_16K`, 670 MB; `AV_MossFormer2_TSE_16K`, 735 MB) and the speaker model, and checks that everything imports. It needs `uv` or a Python 3.10 to 3.13. On Apple silicon the models run on the GPU through Metal, on an NVIDIA card through CUDA, otherwise on the CPU.

Restart the server afterwards. Its start-up line `Studio` and the Sound section both say what was found. Without the environment every switch is greyed out with the reason, and the export runs exactly as before.

Two server options: `--studio-python /path/to/python` uses an environment of your own, and `--no-studio` skips the check.

## The deep clean

**Deep clean the sound from the raw microphone** runs MossFormer2, a speech enhancement model at 48 kHz, over the whole recording. The phrases are sent as one run of audio, in order, so the model hears what the room sounds like over seconds, and the result is cut back into phrases.

The live filter hears each frame once and has to decide at once. The deep clean looks at four seconds at a time with the whole phrase in view. On a test recording of a voice over brown noise 8 dB under it, it lifted the voice from 5.6 to 13.5 dB over the noise and took the room-only stretches down to silence. On an M2 Max it runs at about a twentieth of real time, so an hour of lecture takes a few minutes.

## Only your voice

**Keep only your voice where another voice was heard** runs on the phrases the lip and voice checks flagged (*Another voice* or *Not sure whose voice*, see [Who is speaking](how-recording-works.md#who-is-speaking)) and on any clip you switched to *Only my voice* in the editor.

- When the camera saw your face while the phrase was said, AV-MossFormer2 (audio-visual target speaker extraction) gets the audio and a film of your mouth: 25 grey crops a second, 112 pixels square, cut from the face the lip check already finds and kept with the phrase. The film tells the model which voice is yours, so it handles two people talking at once, which audio alone cannot.
- Without a face, MossFormer2 separates the phrase into two voices, and the one closer to your voice profile is kept (the same speaker model as the voice check, on the server). Without a profile, the louder one is kept. If the voice picked this way is nothing like your profile, you are not in that phrase, and it is left as it was.

Both work at 16 kHz. The result goes back to the recording's rate by adding what the recording has above 8 kHz, scaled frame by frame by how much of the lower band the model kept, so a silenced stretch stays silent up top. When both switches are on, the voice step runs after the deep clean, which is where it does best.

**Check every phrase for a second voice** (off unless you ask) runs the separation over every phrase and flags one where a second voice is active in at least a tenth of it, keeps going for a second, and speaks within 24 dB of yours. It is slow, since it runs the separation model over the whole lecture, and the figures are approximate. The flagged list is there for you to listen and decide.

## The flagged phrases

Under the switches, every phrase the checks flagged is listed the way the filler words are: when it is, how long, what the checks said (the reasons on hover), a ▶ to hear it, and a tick. A ticked phrase goes into the export, with only your voice kept when that switch is on. Untick one and it is left out of the video altogether. Nothing is deleted: the phrase is still there in the timeline and the editor.

## Three versions of every clip

In the editor, under the waveform, each clip has a switch: **Original** (the microphone before any filter), **Cleaned** (the live filter's version until the deep clean has run, the deep clean after) and **Only my voice** (once the studio has kept it), each with a ▶ to hear it. The choice is saved with the clip, the preview plays it, the waveform draws it and the export uses it. Two buttons under the switch ask the studio for a version of just that clip, so you can hear the deep clean or the extraction before an export.

Re-record, cut, keep, split and Remove pauses work on every version at once, and on the film and the picture, so the versions never drift apart. All of them are the same samples, only cleaned differently.

How the raw copy is kept in step: a second capture node reads the microphone before the filter into a tape. When a phrase is stored, its stretch of the tape is taken a fixed delay earlier (41 ms for the deep filter, 21 ms for the classic one) and nudged by correlation to where it best matches the filtered phrase, so a filter that changed mid-phrase never leaves the two copies out of step. A phrase recorded with the filter off has no separate raw copy; Original plays the recording itself.

## The camera's picture

When the camera was recorded, the **Camera** section of the export dialog can also clean its picture before it is drawn into the frame. **Background** blurs what is behind you or paints it a plain colour; MediaPipe's selfie segmenter (fetched once, 250 kB) tells you from the background. **Picture** evens out the exposure and takes the colour cast out: a stretch of the brightness within two to one, a gamma towards a middle grey, and grey-world colour balance within limits, all followed slowly so the picture never flickers. Each frame is cleaned once, as it changes.

## What it costs

The deep clean over an hour takes a few minutes on an Apple GPU and considerably longer on a CPU. Keeping a voice costs about a third of real time per flagged phrase. The models take a gigabyte or two of memory while the worker runs; it stops on its own after three minutes of nothing to do.

Everything stays on the machine. The audio and the mouth films go to the local server as files in its data folder, are processed there and deleted. The checkpoints were fetched once by `npm run studio`.
