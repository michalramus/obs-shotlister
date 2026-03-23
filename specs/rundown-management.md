# Feature: Rundown Management

## Dependencies
- `specs/data-model.md`
- `specs/project-management.md` (active project must exist)

## Goal

Left sidebar listing all rundowns for the active project with full CRUD.

## UI layout

```
┌──────────────────┐
│ Rundowns         │
│ ────────────     │
│ ▶ Morning show   │  ← active (highlighted)
│   Afternoon      │
│   Evening        │
│                  │
│ [+ New Rundown]  │
└──────────────────┘
```

## Behaviour

### Select
- Click any rundown → sets as active; shotlist panel loads its shots

### Create
- `+ New Rundown` button → inline input appears at bottom of list
- Enter to confirm, Escape to cancel
- IPC `rundowns:create` → prepend/append to list, set as active

### Rename
- Double-click rundown name → inline edit
- Enter to confirm, Escape to cancel
- IPC `rundowns:rename`

### Delete
- Right-click or hover → show delete icon
- Click delete → confirmation dialog
- IPC `rundowns:delete`
- If deleted rundown was active: set active to first remaining or null

## IPC channels

All handlers in `src/main/server/ipc/rundowns.ts`:

| Channel | Payload | Returns |
|---|---|---|
| `rundowns:list` | `{ projectId: string }` | `Rundown[]` |
| `rundowns:create` | `{ projectId: string, name: string }` | `Rundown` |
| `rundowns:rename` | `{ id: string, name: string }` | `Rundown` |
| `rundowns:delete` | `{ id: string }` | `void` |

## Acceptance criteria

- Rundowns list updates when active project changes
- Can create, rename, delete rundowns
- Active rundown is visually highlighted
- Rundown list persists after app restart
- `yarn test` passes
