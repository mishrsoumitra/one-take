# Recording

This guide walks you through a recording from the first slide to the last phrase: loading the slides, setting up the mic, choosing how the mic is driven, adding your camera and your drawings, and fixing a mistake on the way. [Preview and editing](editing.md) and [Exporting](exporting.md) take it from there.

## Contents

- [Before you start](#before-you-start)
- [Load your slides](#load-your-slides)
- [Start the mic](#start-the-mic)
- [Find your speech line](#find-your-speech-line)
- [Auto or Press to speak](#auto-or-press-to-speak)
- [Talk, pause, talk again](#talk-pause-talk-again)
- [Move through the slides](#move-through-the-slides)
- [Record your camera](#record-your-camera)
- [Draw on the slides](#draw-on-the-slides)
- [Fix a mistake](#fix-a-mistake)
- [Keyboard shortcuts](#keyboard-shortcuts)

## Before you start

The first time you open the app, a short welcome tour lists the three steps: load slides, start the mic and talk, preview and export. Click **Help** in the top bar to see it again at any time.

The top bar shows the same three steps as numbered badges. The next thing to do is blue, and a finished step gets a green tick. While you work, a tip at the bottom of the stage says what to do next. Close it with its ✕ if you don't need it, or untick *Show tips while I work* in the tour.

The app opens in a dark theme. The sun / moon button at the right of the top bar switches to the light one and back, and your choice is remembered.

## Load your slides

Drop a PDF or a PowerPoint file (`.pptx`, `.ppsx`, `.pptm`) anywhere on the page, or click **Load slides** (or **Choose a file…** on the empty stage) and pick one. Every page becomes one slide. You can also pick a set of PNG or JPG images; they are ordered by file name, with numbers sorted the way you expect (`slide2` comes before `slide10`). If you pick a PDF and images together, the PDF wins.

Keynote and Google Slides decks: export them as PDF or `.pptx` first.

Slides are rendered once, at up to 2560×1440, and kept as JPEGs. Decks with hundreds of pages are fine.

### PowerPoint files

A `.pptx` you drop on the page goes to the local server, which turns it into a PDF with plain JavaScript and sends the PDF back. Nothing else has to be installed and no application opens. Text keeps its font, size, colour, bold and italic, bullets, alignment and spacing. Shapes, pictures (PNG and JPEG), tables, simple bar, line and pie charts, groups and slide backgrounds are drawn where the deck put them. Things a PDF cannot hold faithfully (3-D effects, soft shadows, embedded video, SmartArt animation, GIF or SVG pictures) are approximated or skipped. The app tells you how many such notes the renderer made, and the details are in the browser console.

Fonts come from the system font folders, plus Office's bundled fonts on a Mac. When the deck uses a font the machine does not have, a stand-in with the same weight and style takes its place, which shifts line breaks a little. To use the real font, put the font files in a folder and start the server with `--fonts /that/folder` (several folders separated by `:`).

For a pixel-exact result, export the deck as PDF yourself.

## Start the mic

Click **Start mic**. Chrome asks for microphone permission the first time.

Under the level meter you have three lists and a button:

- **Microphone**: which mic to use, if you have more than one. The browser only names them once the mic has been allowed, so the list fills after your first start. The choice is remembered.
- **Noise filter**: what is taken out from under your voice before anything is recorded. **Deep** (the default) is DeepFilterNet3, a trained model that takes out fans, typing, traffic, music and other people talking. **Classic** is a plain filter for steady noise only: a fan, a hum, hiss. **Off** leaves only what Chrome does on its own. The choice takes effect at once, even mid-recording, and is remembered. The note under the meter says which filter is really running.
- **Camera**: which camera watches your lips for the lip check, or *Off* for no lip check. While it is watched, a small mirror of it sits in the corner of the stage so you can see you are in the frame.
- **Learn my voice**: the voice check. The first time you start the mic, One Take asks you to read the lines in the box out loud for twenty seconds, in the voice you lecture in. From then on every phrase is compared with how your voice sounds, and a phrase that was somebody else is marked in the timeline. Skip it and the voice check stays off until you click the button, which also lets you learn your voice again. What the two checks do is in [Who is speaking](how-recording-works.md#who-is-speaking).

## Find your speech line

The **Mic level** meter shows your voice against a white line, the *speech line*. Sound under the line never counts as speech, so a faint voice from the next room can't start a phrase. Above the line, the voice detector decides what is a voice and what is noise, so a fan, an air conditioner or your keyboard won't start one either.

Your own voice should go clearly past the line. If it doesn't, move the **Speech line** slider until it does. The note under the meter shows how sure the detector is, for example *voice 92%*.

Two more sliders sit next to it. **Pause between phrases** is how much silence goes between phrases in the video (0.15 s to begin with). **Phrase ends after** is how long a pause has to be before it is cut out (0.7 s to begin with); a shorter pause stays in the recording.

## Auto or Press to speak

Next to **Start mic** is the mode switch, **Auto | Press to speak**:

- **Auto** (the default): the mic is live the whole time you are recording. The detector decides when a phrase starts and ends, and you never touch anything while you talk.
- **Press to speak**: the mic is on, but nothing is heard until you hold `Space` or the **Hold to speak** button at the bottom of the stage. Hold it while you talk and let go while you think. The status pill reads *Hold Space to speak* while the key is up, *Speak now* once it is down, and *Recording* while you talk. Nothing from before the press or after the release can end up in a phrase. The dead air between pressing and your first word, and between your last word and letting go, is trimmed like a pause in Auto, and a pause inside one press that is longer than *Phrase ends after* is cut too. Mute is hidden in this mode, because letting go of the key is the mute.

Your choice is remembered in this browser. Switching while a phrase is being spoken ends that phrase first.

## Talk, pause, talk again

While you speak, a red **RECORDING** flag shows on the stage. The flag stays up for two seconds after you stop, while the app makes sure you have finished rather than dropped your voice. The phrase then appears in the timeline a moment later, with its pauses already cut.

Pause as long as you like; nothing of the pause is kept. When you speak again, the new phrase is placed right after the last one with a short gap. The total recorded time is shown at the top.

In Auto, press `M` to mute while you talk to someone in the room. In Press to speak, just let go. Press `R` or **Stop mic** to turn the mic off.

## Move through the slides

Use `→` and `←`, `PageDown` and `PageUp`, a presenter clicker, or click a thumbnail in the film strip. In Auto, `Space` also moves to the next slide. In Press to speak, `Space` is the talk key and never changes slides. Each thumbnail shows how many seconds you have recorded on that slide.

If you change slides while speaking, in either mode, the sentence is split at that moment and continues on the new slide without a gap. In the video the slide changes exactly where you pressed the key. Skipping straight past a slide mid-sentence stores nothing on it.

## Record your camera

Next to the **Camera** list under the level meter, the **Record** switch says what goes into the video with your voice: **Voice** (the slides alone), **Voice + camera** (your picture over the slides), or **Voice + camera + pen** (your picture and your drawings on the slides; see [Draw on the slides](#draw-on-the-slides)).

Choose **Voice + camera**. The browser asks for camera permission the first time, then your picture appears over the slide, mirrored like a mirror so it is easy to frame yourself (the recording is not mirrored). A row of camera controls appears under the sliders:

- **Camera** (the list next to the switch): which camera to use. The same camera watches your lips for the lip check, opened once for both.
- **Position**: four buttons put the picture in the top-left, top-right, bottom-left or bottom-right corner of the slide. Or drag the picture on the slide to wherever you like; it snaps into a corner when it comes close to one, and the note under the row says *Where you dragged it* otherwise.
- **Size**: the picture's width as a share of the slide's width, from 12 % to 50 % (24 % to begin with). Dragging the small handle on the picture's free corner does the same.

The picture always stays on the slide, a small margin in from its edge, and keeps the camera's own shape. What you see on the stage is exactly where it will be in the finished video, at the same size relative to the slide, whatever resolution you export at.

The camera records only while the mic is on. Each phrase takes the stretch of picture that goes with its words, and pauses are in neither. Phrases recorded with the camera off show the slide alone, so you can turn the camera on or off between phrases, or in the middle of a recording. The switch, the camera and the layout are remembered, but the camera never opens on its own: after a reload it opens when you start the mic, or when you choose the mode again.

Recording the camera needs WebCodecs plus a way to read frames off the camera. Chrome and Edge have both. Elsewhere the option is greyed out and says why.

## Draw on the slides

Choose **Voice + camera + pen** on the **Record** switch. A pen toolbar appears at the left of the stage: **Pen** or **Highlighter**, seven colours, three widths, **Undo stroke** and **Clear the slide**. Your choice of pen is remembered. The camera is recorded as in the mode before; if it cannot be opened, your drawings still go in, over the slides alone.

Drawing is part of recording, so it works while the mic is on. Press the pen (or the mouse) on the slide and draw. The strokes appear on the stage exactly where they will be in the video, under the camera picture. Four rules:

- **The voice and the pen are never recorded together.** When the pen touches the slide, the phrase you were saying ends there, and the mic hears nothing while the pen is on the slide. The status pill reads *Drawing* and the flag on the stage turns yellow. In Press to speak, holding the key or not makes no difference while the pen is down.
- **A drawing is a clip.** It begins with your first stroke and ends when the pen has rested for a little over a second, or the moment you start speaking again, or when you change slides, stop the mic, or put the pen away. The pauses between your strokes are kept, but never longer than 0.4 s, so the drawing stays lively; the rest after the last stroke is trimmed. In the video the clip is silence for as long as the drawing took, and the strokes appear point by point, at the pace you drew them. It takes its place in the timeline right where you made it: after the phrase that was cut and before the one that follows.
- **Drawings stay on their slide.** Every phrase you record after a drawing on the same slide shows it, and a slide you come back to still has its annotations. **Clear the slide** records a wipe: a short step in the video after which the slide is clean. If you were speaking, the sentence is split there, so its first part still shows the drawing.
- **You can take a stroke back.** **Undo stroke** (or `Cmd/Ctrl+Z` while drawing) takes back the last stroke of the drawing you are making. `Backspace` drops the whole drawing in progress.

In the timeline and the editor a drawing shows a pen mark and how many strokes it has. You can move, split, cut, keep or delete it like a phrase, and where it sits decides which phrases show its strokes. Its sound is silence, so **Remove pauses** leaves it alone and the filler and volume steps skip it. **Replace with voice** in the editor records a phrase in its place. What happens under the hood is in [The pen](how-recording-works.md#the-pen).

## Fix a mistake

- `Backspace` or `Delete` drops the phrase you are saying right now (or the drawing you are making), or the last finished one if you are quiet.
- `Cmd/Ctrl+Z` brings a removed phrase back.
- `✕` on any phrase in the timeline deletes it.
- Drag phrases in the timeline to reorder them.

To close the slides and start over, click the **×** after the deck's name in the top bar. Slides with nothing recorded on them close at once. Otherwise the app asks first, because the phrases cannot be brought back.

## Keyboard shortcuts

| Keys                       | What happens                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| `→` `PageDown` `Enter` `↓` | Next slide                                                                                |
| `Space`                    | Auto: next slide. Press to speak: hold while you talk                                     |
| `←` `PageUp` `↑`           | Previous slide                                                                            |
| `Home` / `End`             | First / last slide                                                                        |
| `Backspace` / `Delete`     | Drop the drawing being made or the phrase being spoken, else remove the last finished one |
| `Cmd/Ctrl+Z`               | Take back the last stroke while drawing, else bring back the last removed phrase          |
| `M`                        | Mute / unmute (Auto only)                                                                 |
| `R`                        | Mic on / off                                                                              |
| `Esc`                      | Stop the preview                                                                          |

In the editor: `Space` plays and pauses, `←` `→` select the previous or next clip, `Delete` / `Backspace` removes the selected clip, `Cmd/Ctrl+Z` undoes the last change, and `Esc` stops playback, cancels a take, or closes the editor. While a press-to-speak take is recording, `Space` is the talk key.

Shortcuts are ignored while you type in a field or while a dialog is open. Most presenter clickers send `PageDown` and `PageUp`, so they work out of the box.
