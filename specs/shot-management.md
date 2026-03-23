# Feature: Shot Management

## Dependencies
- `specs/data-model.md`
- `specs/rundown-management.md` (active rundown must exist)
- `specs/project-management.md` (cameras must exist for active project)

## Goal

Allow the operator to manually add, edit, delete, and reorder shots within the active rundown.

## UI layout

Shot management sits in the center panel of the renderer, below or alongside the shotlist widget. When not in live mode, the shotlist is editable.

```
┌──────────────────────────────────────────────┐
│  Shots                          [+ Add shot] │
├──────────────────────────────────────────────┤
│ ⠿ [CAM1] Main Wide   "Opening"    0:30  ✎ 🗑 │
│ ⠿ [CAM2] Close-up    "Interview"  1:00  ✎ 🗑 │
│ ⠿ [CAM3] Overhead    "Wide"       0:45  ✎ 🗑 │
└──────────────────────────────────────────────┘
```

`⠿` = drag handle for reorder.

## Add shot

`+ Add shot` button opens an inline form or modal:
- **Camera**: dropdown of project cameras (shows `CAM{number} — {name}`)
- **Duration**: time input formatted `m:ss`
- **Label**: optional text input
- Confirm: IPC `shots:create` → append to list
- New shot gets `orderIndex = max(existing) + 1`

## Edit shot

Click edit icon (✎) on a row → row becomes editable in-place (same fields as add).
Confirm: IPC `shots:update`.
Escape: cancel.

## Delete shot

Click delete icon (🗑) → confirmation dialog if rundown has been started at least once (warn: "Rundown has been run; delete this shot?"). Otherwise delete immediately.
IPC `shots:delete`.

## Reorder

Drag-and-drop via drag handle. On drop: IPC `shots:reorder` with new ordered array of shot IDs.
Use a lightweight DnD library (e.g. `@dnd-kit/core`).

## IPC channels

All handlers in `src/main/server/ipc/shots.ts`:

| Channel | Payload | Returns |
|---|---|---|
| `shots:list` | `{ rundownId: string }` | `Shot[]` (ordered by order_index) |
| `shots:create` | `{ rundownId, cameraId, durationMs, label? }` | `Shot` |
| `shots:update` | `{ id, cameraId?, durationMs?, label? }` | `Shot` |
| `shots:delete` | `{ id: string }` | `void` |
| `shots:reorder` | `{ ids: string[] }` | `void` |

## Acceptance criteria

- Can add a shot with camera, duration, and optional label
- Can edit a shot inline
- Can delete a shot (with confirmation if rundown was previously run)
- Drag-and-drop reorder persists after app restart
- Shot list loads for the selected rundown
- `yarn test` passes
