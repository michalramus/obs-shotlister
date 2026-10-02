# Feature: Live Controls

## Dependencies

- `specs/data-model.md`
- `specs/shotlist-widget.md`
- `specs/shot-management.md`

## Goal

Five live operations on a rundown: start, stop, next, skip, restart. When a rundown is live (`running === true`), editing it is forbidden. State is broadcast to phone browsers (camera operators) and is the foundation for future video mixer (OBS) control.

In a Voice-over Rundown, Next's side effect is a spoken Announcement instead of an OBS scene
switch, and starting is refused while any item is unassigned. See
`specs/voice-over-rundowns.md`.

## The timeline is read-only in Live mode

A Rundown is built in Edit mode and run in Live mode, so the timeline is a read-out for the whole
of Live mode — before Start as much as on air. The lock is the **view**, not `running`: `running`
says only that a Live session is on air, which is not true until the operator presses Start, so a
rule keyed on it leaves the timeline fully editable for exactly as long as the operator is staring
at the queued show. `TimelineEditor` takes a `readOnly` prop for this, which the renderer derives
as `uiMode === 'live' || running` — the second half so that flipping back to the Edit layout
mid-show does not unlock the timeline either.

"Editing is forbidden" covers the pointer as well as the keyboard. Every Grab goes through one
adapter in `TimelineEditor`, which refuses to start while the view is read-only unless the Grab's
own spec declares itself view-only — so a Grab added later is refused by default rather than by
somebody remembering. Refused: the Shot boundary resize, the extend-last-item drag, the Marker
move, the Reference media offset, the Lyric edge drag, adding a Marker by double-click or M, a
Marker's label edit and delete, a Lyric's re-word and delete, the Lyric In and Out points,
importing or clearing Reference media, the context menu, the label-edit key, and the Camera, Part
and number keys and buttons that split at the Playhead.

Space is Edit mode's preview transport and Live mode's Start-then-Next, one key claimed by both
`TimelineEditor` and `App`. Only the view tells them apart: gated on `running`, a single press in
Live mode started the show _and_ set the timeline playing behind it.

Still allowed, because none of it writes anything: scrubbing the Playhead, the operator's own
scroll (an overrunning Shot freezes the Playhead, so real scrolling still happens while running),
zoom, stepping the Playhead, selecting a Shot or a Lyric, and clicking a Track to place the
Playhead.

An affordance that cannot be used is not offered: the buttons are disabled and dimmed, the hover
handles and hints are gone, preview playback is paused on entering Live mode, and a Marker label
left mid-edit when the view locks is abandoned rather than silently dropped on save.

## UI layout

Controls rendered in the renderer, above the shotlist.

```
┌─────────────────────────────────────────────────┐
│  [▶ Start]                                      │  ← idle
│                                                 │
│  [■ Stop]  [↺ Restart]  [⏭ Skip next]  [→ Next]│  ← running
└─────────────────────────────────────────────────┘
```

When `running === true`, the shotlist and shot editor are **read-only** (add/edit/delete/reorder disabled, visually locked).

## State machine

```
idle ──[Start]──▶ running (queue filled, liveIndex=0, startedAt=now)
running ──[Next]──▶ running (outgoing Shot hidden, liveIndex++, startedAt=now)
running ──[Skip next]──▶ running (next visible Shot hidden, liveIndex unchanged)
running ──[Stop]──▶ idle (queue cleared, liveIndex=null, startedAt=null, running=false)
running ──[Restart]──▶ running (queue refilled, liveIndex=0, startedAt=now)
running, last shot ──[Next]──▶ idle (queue cleared, liveIndex=null, running=false)
```

## Actions

### Start

- Available when `running === false` and `shots.length > 0`
- Sets `liveIndex = 0`, `startedAt = Date.now()`, `running = true`
- Locks rundown editing
- IPC: `live:start`

### Stop

- Available when `running === true`
- Sets `running = false`, `liveIndex = null`, `startedAt = null`
- Discards the Live queue, so nothing about the run survives it (ADR 0001)
- Unlocks rundown editing
- IPC: `live:stop`

### Next

- Available when `running === true`
- Advances to the next visible Shot — one hidden by a Skip is passed over
- Sets `startedAt = Date.now()`
- If no next shot: transitions to idle
- IPC: `live:next`

### Skip next

- Available when `running === true` and a next shot exists
- Hides the next visible queued Shot (after liveIndex) for this run
- Does not advance `liveIndex` or reset `startedAt`
- Skipped shot shown struck-through in shotlist
- IPC: `live:skip-next`

### Restart

- Available when `running === true`
- Refills the queue with every Shot visible again, sets `liveIndex = 0`, `startedAt = Date.now()`
- IPC: `live:restart`

## Rundown edit lock

When `running === true`:

- Shot add/edit/delete/reorder controls are hidden or disabled
- Visual indicator on the shotlist: "Live — editing disabled"
- Rundown rename is also disabled

## Persisted live state (SQLite)

Only the *selection* is durable. Progress — the queue, which Shot is live, when
it went live, whether it is running — is held in memory and dies with the
process (ADR 0001: resuming into a stale live state would drive OBS from a
position that no longer matches what is on air).

```sql
CREATE TABLE live_state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton
  rundown_id   TEXT,
  project_id   TEXT
);
```

Written when the operator opens a Rundown or a Project, not on a live action.

## Socket.io broadcast

On every live action, main process emits to all connected clients:

```ts
// Phones get elapsed time, not a timestamp: their clocks are not the
// operator's, so the receiver anchors it against its own (ADR 0003).
io.emit('state:live', {
  liveIndex: number | null,
  elapsedMs: number | null,
})
io.emit('state:playback', { running: boolean })
// A Skip or a Next hides one Shot. Sent on its own rather than folded into
// state:rundown, so a phone need not re-derive the whole list.
io.emit('state:shot:hidden', { shotId: string })
```

`state:rundown` is NOT re-emitted on live changes — only on rundown data changes.

## IPC channels

| Channel          | Payload                 | Returns     |
| ---------------- | ----------------------- | ----------- |
| `live:start`     | `{ rundownId: string }` | `LiveState` |
| `live:stop`      | —                       | `LiveState` |
| `live:next`      | —                       | `LiveState` |
| `live:skip-next` | —                       | `LiveState` |
| `live:restart`   | —                       | `LiveState` |
| `live:get`       | —                       | `LiveState` |

```ts
interface LiveState {
  rundownId: string | null
  projectId: string | null
  liveIndex: number | null
  startedAt: number | null
  running: boolean
}
```

A Skip is not in here: it is a hidden flag on the in-memory queue entry, and it
reaches the surfaces as `live:shot-hidden-push` (operator) and
`state:shot:hidden` (phones).

## Acceptance criteria

- Live mode locks the timeline — keyboard, buttons and every pointer Grab — before Start as much as
  on air; Start itself sets liveIndex to 0 and locks the shotlist and shot editor
- Next advances liveIndex with new startedAt
- Skip marks next shot struck-through; does not advance
- Stop returns to idle; editing unlocked; the queue and its skips are discarded
- Restart resets to liveIndex=0 with every Shot visible again
- After last shot, Next transitions to idle
- All state changes broadcast via Socket.io
- Only the selection survives a restart; a relaunched app is idle (ADR 0001)
- Every durable write is refused while `running === true`, at the IPC seam, so
  the refusal holds for the phone UI and the OSC pedal as well as the window
- `yarn test` passes
