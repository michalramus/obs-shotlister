# Feature: Live Controls

## Dependencies
- `specs/data-model.md`
- `specs/shotlist-widget.md`
- `specs/shot-management.md`

## Goal

Operator controls to start a rundown and advance through shots. Every state change is broadcast to phone browsers via Socket.io.

## UI layout

Controls rendered in the renderer, below or above the shotlist.

```
┌─────────────────────────────────────┐
│  [▶ Start rundown]                  │  ← before start
│                                     │
│  [⏭ Skip next]   [→ Go next live]   │  ← after start
└─────────────────────────────────────┘
```

## State machine

```
idle ──[Start rundown]──▶ running (liveIndex=0)
running ──[Go next live]──▶ running (liveIndex++)
running ──[Skip next]──▶ running (skippedIds + liveIndex unchanged — next live will jump over)
running, last shot ──[Go next live]──▶ idle (liveIndex=null)
```

## Actions

### Start rundown
- Only available when `running === false` and `shots.length > 0`
- Sets `liveIndex = 0`, `startedAt = Date.now()`, `running = true`
- IPC: `live:start` → persists to DB, broadcasts Socket.io `state:live` + `state:playback`

### Go next shot on live
- Only available when `running === true`
- Advances to next non-skipped shot: `liveIndex = nextNonSkipped(liveIndex)`
- Sets `startedAt = Date.now()`
- If no next shot: `liveIndex = null`, `running = false`
- IPC: `live:next`

### Skip next shot
- Only available when `running === true` and there is a next shot
- Marks the shot at `liveIndex + 1` (the next queued shot) as skipped for this run
- Does not advance `liveIndex` or reset `startedAt`
- Skipped shot is visually struck through in shotlist
- IPC: `live:skip-next`

> Skipped shot IDs are persisted to SQLite in `live_state` and restored on app restart.

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
| `live:next` | — | `LiveState` |
| `live:skip-next` | — | `LiveState` |
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

- Start rundown enables controls and sets liveIndex to 0
- Go next advances liveIndex; records new startedAt
- Skip next marks next shot as skipped; shotlist shows it struck through
- After last shot, running becomes false
- All state changes broadcast via Socket.io
- Live state restored on app restart
- `yarn test` passes
