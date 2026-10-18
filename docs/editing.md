# Preview and editing

You have recorded something. Now you want to hear it, put it in order, and fix the parts that went wrong. The preview and the editor do that on the main screen, before you export.

## Contents

- [Preview and reorder](#preview-and-reorder)
- [The editor](#the-editor)
- [Drawings in the editor](#drawings-in-the-editor)
- [Three versions of every clip](#three-versions-of-every-clip)

## Preview and reorder

**Preview** in the top bar plays the lecture with the slides switching at the right moments, your camera picture over them, and your drawings appearing as you made them. `▶` on a phrase in the timeline plays from there. Press `Esc` or **Stop** to stop.

Drag phrases in the timeline to reorder them. `✕` on a phrase deletes it.

## The editor

Click **Edit** to open the editor. It shows the lecture as a player with a scrub bar on the left and the list of clips on the right. A clip is one phrase on one slide, which is exactly what the timeline on the main screen shows; the editor only gives you more ways to change them.

- **Play and scrub.** `▶` plays from the playhead. Click or drag the bar under the slide to move through the lecture, even into the middle of a phrase. `Space` plays and pauses, `←` and `→` jump between clips.
- **Re-record a clip.** Select it and click **Re-record**. The mic opens in the same mode as the top bar (auto, or hold `Space` to speak). Say it again, press **Stop**, listen to the take, and click **Use this take**. The new voice replaces the old clip at the same place in the video, on the same slide. Pauses in the take are cut out as always, so a take with two sentences and a breath in between becomes two clips.
- **Cut a stretch of audio.** Drag across the waveform of the selected clip to select a stretch. **Cut selection** removes it and joins the two sides with a short fade. **Keep only selection** throws away everything else. **Play selection** lets you hear it first.
- **Split a clip.** Put the playhead inside the clip (click on the waveform) and click **Split at playhead**. The two halves still play back to back, and now a new clip can go between them.
- **Add a clip.** **Add clip after** records a new clip right after the selected one. **Add a clip** under the list lets you pick any slide and any position: at the start, or after any clip. Pick the slide, record, listen, use.
- **Move a clip to another slide.** The **Slide** list next to the clip's name changes which slide it shows. The audio stays the same.
- **Delete a clip** with the **Delete** button or the `Delete` key.
- **Remove pauses.** The app listens through every clip again and cuts out the stretches where nobody is speaking: a long silence at the end of a clip, or a pause inside one (the clip is split there, just as a live phrase is). Pauses shorter than *Phrase ends after* stay. It is one change, so one Undo brings everything back. Use it after a session in a room loud enough to keep a phrase open.
- **The picture follows.** A clip recorded with the camera on keeps its picture through every cut, split, keep, move and Remove pauses. The frames are never decoded and encoded again; the clip only remembers which stretch of them to play. The editor's player shows the picture over the slide while it plays, and a take recorded with the camera on gets a picture too.
- **Undo** (`Cmd/Ctrl+Z`) steps back through everything you did since opening the editor.

Every change is saved the moment you make it, so there is no Save button. **Done** (or `Esc`) closes the editor. The main microphone is turned off while the editor is open, because the editor records its own takes.

## Drawings in the editor

A clip made with the pen shows a pen mark and the number of strokes in the clip list. Instead of a waveform, its panel shows one bar per stroke, in the stroke's colour, from the moment the stroke starts to the moment it ends. The player shows the strokes as they stand at the playhead: scrub through a drawing and you see it being made.

You can split, cut, keep, move and delete a drawing like any other clip, and the strokes follow the cut. Where the clip sits decides which phrases show its strokes, so moving a drawing earlier makes it visible to more of them. **Replace with voice** records a phrase in its place. **Remove pauses** leaves drawings alone, since their sound is silence on purpose.

## Three versions of every clip

Under the waveform, each clip has a switch: **Original** (the microphone before any filter), **Cleaned** (the live noise filter's version, or the studio's deep clean once it has run) and **Only my voice** (once the studio has kept it). Each has a ▶ to hear it. The choice is saved with the clip, the preview plays it, the waveform draws it and the export uses it. A change of choice is on the undo stack like any other edit.

Two buttons under the switch ask the studio for a version of just that clip, so you can hear the deep clean or *Only my voice* before you export. They need the studio to be set up; see [The studio](studio.md).

Re-record, cut, keep, split and Remove pauses work on every version at once, so the versions never drift apart.
