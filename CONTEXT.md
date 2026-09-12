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
An ordered list of Shots making up one recording or broadcast.
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

### Running a show

**Live session**:
One run of a Rundown, from start to stop. Knows which Shot is live and when it went live.
_Avoid_: playback, broadcast, run, session

**Live queue**:
The Shots of a Rundown as they stand within a Live session, including which have been
consumed or skipped. The Rundown itself never changes during a Live session.
_Avoid_: playlist, stack, buffer

**Hidden**:
A Shot that has left the Live queue's future, because it has already been on air or was
skipped. A property of the Live queue only — never of the stored Shot. A Shot going off air
stays visible until its successor's Transition finishes, so briefly it is on screen without
being live.
_Avoid_: done, past, consumed, removed

**Next**:
Putting the next visible Shot on air and hiding the one leaving.
_Avoid_: advance, go, cut, take

**Skip**:
Dropping the next Shot from the Live queue without ever putting it on air.
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
