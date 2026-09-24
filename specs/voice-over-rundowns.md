# Feature: Voice-over Rundowns

## Goal

A second Kind of Rundown that announces song Parts to musicians over speech instead of
switching cameras in OBS. The operator drives it exactly as a Camera Rundown — Next and
Skip, timers advisory — but the side effect of Next is a spoken Announcement, not a scene
change.

## Kind

`rundowns.kind` is `'camera'` or `'voice'`. A Camera Rundown holds Shots, a Voice-over
Rundown holds Calls. A Rundown can be converted between Kinds at any time.

OBS is never contacted in a Voice-over Rundown: no scene switch, no transition, no preview.

## Data model

Shots and Calls share the `shots` table; the Rundown's Kind decides which target column is
read.

```sql
ALTER TABLE rundowns ADD COLUMN kind TEXT NOT NULL DEFAULT 'camera';
ALTER TABLE shots    ADD COLUMN part_id TEXT REFERENCES parts(id);
-- camera_id becomes nullable (table rebuild)

CREATE TABLE parts (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number     INTEGER NOT NULL,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL,
  folder     TEXT,           -- folder scope, NULL otherwise
  rundown_id TEXT REFERENCES rundowns(id) ON DELETE CASCADE,
  UNIQUE(project_id, number)
);
```

Scope is additive (ADR 0006): a Rundown sees Project Parts (`folder IS NULL AND rundown_id
IS NULL`), plus Parts for its folder, plus its own. A Part can be promoted between scopes,
keeping its id.

Deleting a Part referenced by Calls is refused, reporting the count, matching Camera
behaviour.

## Conversion between Kinds

Both `camera_id` and `part_id` are retained across a conversion, so converting away and back
restores the original assignments exactly. Order, durations, labels and transitions are
never touched.

A Rundown born in one Kind has nothing in the other column, so conversion leaves every item
unassigned. Starting a Live session on a Rundown with any unassigned item is refused.

## What gets spoken

`"<part name> <connector>"` then the countdown numbers — "gitara za 10, 5, 3, 2, 1". The
connector is a per-Project string, so Polish reads naturally. A Call's label is never
spoken; it stays a visual note for the operator.

The Announcement names the **next visible** Call and counts down to its planned start, so
Hidden and Skipped Calls extend the countdown exactly as they do for the Cue Tray.

## Timing

- Countdown numbers default to 10, 5, 3, 2, 1. Configurable globally with a Project
  override.
- Phrase placement is a setting, global with Project override:
  - **flush** (default): the phrase is scheduled backwards from the first number using the
    clip's stored duration, so phrase and countdown form one continuous utterance.
  - **immediate**: the phrase plays the moment the previous Call goes live.
- A Call too short for the full countdown plays from the largest number that still fits. A
  Call too short for even the phrase drops its Announcement and is badged in Edit mode.
- On overrun nothing is played. The Announcement fires once per Call and never repeats,
  matching ADR 0002.
- Collisions: an Announcement starting while another is in flight cuts the old one off.
  Never queued.
- Skip stops any in-flight Announcement immediately.
- **Path delay**: Mumble buffers, so the band hears a clip well after it plays. A global
  delay setting shifts the whole utterance that much earlier, so what the band *hears*
  lands where it was scheduled. Global rather than per-Project, like the output device it
  compensates for: it describes the machine's route to the band, not the show. Numbers the
  shift pushes before the previous Call are dropped, exactly as a short Call already drops
  them. Under *immediate* placement nothing can play before now, so the delay eats into the
  time the band has to hear the name instead.

## Rendering

See ADR 0005. Clips live under `userData/tts/<hash>.opus`, hashed on (text, Voice, engine),
with `duration_ms` stored alongside each. Engine is Piper, bundled per platform; Voice is a
global setting with a Project override.

- Numbers 1..60 are rendered once per Voice.
- Phrase clips are rendered once per Part.
- Render state per Part: rendered / stale / never rendered.
- Settings toggle: auto-render on change (debounced) or manual only.
- Project-wide status with one **Render all missing** action covering every Rundown in the
  Project.
- A stale or missing render warns at Live start; it does not block.
- Orphaned clips are swept on app start and on app close only, never during a session.

## Playback

Playback is in the renderer via `HTMLAudioElement.setSinkId`, matching where the existing
countdown Cues already play. Two independent output device selectors: one for the existing
Cues, one for Announcements, so Announcements can be piped to a virtual cable feeding
Mumble while the operator keeps Cues on their own speakers.

## Authoring

Parts are assigned exactly as Cameras are: keys **1-9** then **q w e r t y u i o p** map to
the first nineteen Parts in scope, plus a button bar and a type-to-filter picker. Calls are
split, resized and reordered against Reference media identically to Shots.

An **Add new description** button and hotkey opens a one-field dialog; Enter creates the
Part at **Rundown** scope, to be promoted later from the Parts panel.

Parts carry a colour and the timeline colour-codes Calls by it. Grouping is convention only:
multi-select in the Parts panel sets a shared colour, there is no Group entity.

## Elsewhere in the system

- **Phone view**: shows a Voice-over Rundown unfiltered. There are no Cameras to filter by.
- **Cue Tray**: goes silent for voice-kind Rundowns. `kind` is added to the phone protocol
  payload; requires a coordinated tray release.
- **OSC**: unchanged. Next and Skip behave identically.
- **Resolve CSV import**: not supported for Voice-over Rundowns.

## Acceptance criteria

- Existing Rundowns migrate to `kind = 'camera'` with no visible change.
- Converting a Rundown to voice and back restores every Camera assignment.
- A Live session on a voice Rundown never contacts OBS.
- An Announcement fires once per Call, names the next visible Call, and is cut off by Skip.
- No speech synthesis runs while a Live session is running.
- `yarn test` passes.
