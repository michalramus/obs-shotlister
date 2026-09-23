# shotlister

Camera-queue management for live multi-camera productions. An operator builds a running
order ahead of time, then runs it live while camera operators follow along on their phones
and OBS is driven to match.

## Language

### Structure

**Project**:
A production with its own cameras and rundowns.
_Avoid_: show, event, production

**Camera**:
A camera position within a Project, identified by a number, a name and a colour, and
optionally mapped to an OBS scene.
_Avoid_: source, input, angle, channel

**Rundown**:
An ordered list of items making up one recording or broadcast: Shots in a Camera Rundown,
Calls in a Voice-over Rundown.
_Avoid_: playlist, sequence, running order

**Shot**:
One Camera's turn on air: a Camera, a duration, and optionally a label and an in-Transition.
The unit a Rundown is made of.
_Avoid_: clip, cue, item, segment

**Transition**:
The visual change into a Shot — a named OBS transition and its duration, or a cut when
there is none. It belongs to the Shot being transitioned *into*, not the one leaving.
_Avoid_: dissolve, wipe, effect

**Marker**:
A labelled point in time on a Rundown, positioned independently of Shot boundaries.
_Avoid_: cue point, flag, chapter, note

**Reference media**:
An audio or video file aligned to a Rundown by an offset, against which the operator places
Shot boundaries. Never broadcast — it exists only to edit against.
_Avoid_: asset, source, track

**Kind**:
Which sort of item a Rundown is made of: a Camera Rundown (Shots) or a Voice-over Rundown
(Calls). A Rundown has exactly one Kind and can be converted between them. Not to be
confused with Edit mode and Live mode, which are views.
_Avoid_: mode, type, variant

**Track**:
One lane of the timeline. The item Track holds the Rundown's Shots or Calls; the Lyrics
Track holds Lyrics. A Track is a lane, never a Rundown and never Reference media.
_Avoid_: lane, row, layer

**Lyric**:
One line of song text on the Lyrics Track, with its own in and out points. Purely an
orientation aid for the operator: never spoken, never sent anywhere.
_Avoid_: caption, subtitle, marker, text cue

**Part**:
A named moment of a song within a Project — "guitar", "voice 1", "refren". The Voice-over
Rundown counterpart of a Camera: reusable, defined once, referenced by many Calls.
_Avoid_: section, moment, marker, tag

**Call**:
One Part's turn to be announced: a Part and a duration, and optionally a label. The unit a
Voice-over Rundown is made of, exactly as a Shot is the unit of a Camera Rundown. No Camera
is involved and OBS is never switched.
_Avoid_: cue, announcement, moment, prompt

**Announcement**:
What a Voice-over Rundown speaks before a Call: that Call's Part name and connector, then
the countdown numbers, played from clips rendered ahead of the show. Never a Cue, which is
a fixed sound the Cue Tray plays.
_Avoid_: cue, prompt, callout, TTS

**Voice**:
The synthetic speaker an Announcement is rendered with. Set once for the app and
overridable per Project, because the language follows the material and not the machine.
_Avoid_: speaker, model, engine

**Render state**:
Whether a Part's audio exists and matches its current text and Voice: *rendered*, *stale*,
or *never rendered*. A Project reports the aggregate; a show can start while something is
unrendered, but only behind a warning.
_Avoid_: status, dirty, cached, synced

### Running a show

**Live session**:
One run of a Rundown, from start to stop. Knows which item is live and when it went live.
_Avoid_: playback, broadcast, run, session

**Live queue**:
The items of a Rundown as they stand within a Live session, including which have been
consumed or skipped. The Rundown itself never changes during a Live session.
_Avoid_: playlist, stack, buffer

**Hidden**:
An item that has left the Live queue's future, because it has already been on air or was
skipped. A property of the Live queue only — never of the stored item. A Shot going off air
stays visible until its successor's Transition finishes, so briefly it is on screen without
being live.
_Avoid_: done, past, consumed, removed

**Next**:
Putting the next visible item on air and hiding the one leaving: switching the Camera in a
Camera Rundown, and nothing but the Announcement in a Voice-over Rundown.
_Avoid_: advance, go, cut, take

**Skip**:
Dropping the next item from the Live queue without ever putting it on air. Any Announcement
already in flight for it stops at once.
_Avoid_: delete, remove, drop

**Preview-first**:
A Live session start mode that loads the first Shot's scene into OBS preview and transitions
it to program, rather than cutting to program directly.
_Avoid_: pre-roll, standby, arm

### Views

**Edit mode**:
The operator view for building a Rundown: splitting, resizing, relabelling and reordering
Shots against the Reference media.
_Avoid_: design mode, prep

**Live mode**:
The operator view for running a Live session. Actions here affect the Live queue only.
_Avoid_: show mode, run mode

**Phone view**:
The read-only shotlist a camera operator follows in a browser on the local network, usually
filtered to their own Camera.
_Avoid_: web UI, client, remote

**Operator**:
The person running the Live session at the desktop window. Distinct from a camera operator,
who follows the Phone view.
_Avoid_: user, director

**Cue Tray**:
The standalone program on the video switching computer that plays a Live session's audio
cues. Read-only, and the main app is unaware of it.
_Avoid_: client, listener, agent, beeper

**Cue**:
One sound played at a moment in the Live session — a countdown number or a beep. Distinct
from a Shot, which is never called a cue.
_Avoid_: sound, alert, tone
