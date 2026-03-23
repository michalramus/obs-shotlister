# Feature: Live Controls

## Dependencies
- `specs/data-model.md`
- `specs/shotlist-widget.md`
- `specs/shot-management.md`

## Goal

Five live operations on a rundown: start, stop, next, skip, restart. When a rundown is live (`running === true`), editing it is forbidden. State is broadcast to phone browsers (camera operators) and is the foundation for future video mixer (OBS) control.

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
idle ──[Start]──▶ running (liveIndex=0, startedAt=now)
running ──[Next]──▶ running (liveIndex++, startedAt=now)
running ──[Skip next]──▶ running (skippedIds += nextId, liveIndex unchanged)
running ──[Stop]──▶ idle (liveIndex=null, startedAt=null, running=false, skippedIds preserved)
running ──[Restart]──▶ running (liveIndex=0, startedAt=now, skippedIds cleared)
running, last shot ──[Next]──▶ idle (liveIndex=null, running=false)
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
- Skipped IDs preserved (resume context kept)
- Unlocks rundown editing
- IPC: `live:stop`

### Next
- Available when `running === true`
- Advances to next non-skipped shot: `liveIndex = nextNonSkipped(liveIndex)`
- Sets `startedAt = Date.now()`
- If no next shot: transitions to idle
- IPC: `live:next`

### Skip next
- Available when `running === true` and a next shot exists
- Marks the next queued shot (after liveIndex) as skipped for this run
- Does not advance `liveIndex` or reset `startedAt`
- Skipped shot shown struck-through in shotlist
- IPC: `live:skip-next`

### Restart
- Available when `running === true`
- Clears `skippedIds`, sets `liveIndex = 0`, `startedAt = Date.now()`
- IPC: `live:restart`

## Rundown edit lock

When `running === true`:
- Shot add/edit/delete/reorder controls are hidden or disabled
- Visual indicator on the shotlist: "Live — editing disabled"
- Rundown rename is also disabled

## Persisted live state (SQLite)

Table `live_state`:
```sql
CREATE TABLE live_state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton
  rundown_id   TEXT,
  live_shot_id TEXT,
  started_at   INTEGER,
  running      INTEGER NOT NULL DEFAULT 0,           -- boolean
  skipped_ids  TEXT NOT NULL DEFAULT '[]'            -- JSON array of shot IDs
);
```

Written on every live action. Restored on app start.

## Socket.io broadcast

On every live action, main process emits to all connected clients:

```ts
io.emit('state:live', {
  liveIndex: number | null,
  startedAt: number | null,
  skippedIds: string[],
})
io.emit('state:playback', { running: boolean })
```

`state:rundown` is NOT re-emitted on live changes — only on rundown data changes.

## IPC channels

| Channel | Payload | Returns |
|---|---|---|
| `live:start` | `{ rundownId: string }` | `LiveState` |
| `live:stop` | — | `LiveState` |
| `live:next` | — | `LiveState` |
| `live:skip-next` | — | `LiveState` |
| `live:restart` | — | `LiveState` |
| `live:get` | — | `LiveState` |

```ts
interface LiveState {
  rundownId: string | null
  liveIndex: number | null
  startedAt: number | null
  running: boolean
  skippedIds: string[]
}
```

## Acceptance criteria

- Start locks rundown editing and sets liveIndex to 0
- Next advances liveIndex with new startedAt
- Skip marks next shot struck-through; does not advance
- Stop returns to idle; editing unlocked; skips preserved
- Restart resets to liveIndex=0 and clears skips
- After last shot, Next transitions to idle
- All state changes broadcast via Socket.io
- Live state (including skippedIds) restored on app restart
- `yarn test` passes
