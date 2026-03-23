# Feature: Project Management

## Dependencies
- `specs/data-model.md` (types, schema)

## Goal

Allow the operator to create, rename, and delete projects, and configure cameras per project (name, color, Resolve marker color).

## UI layout

Rendered in the Electron renderer (`src/renderer/`).

```
┌─────────────────────────────────────────┐
│  [Project dropdown ▾]  [+ New Project]  │  ← header bar
└─────────────────────────────────────────┘
```

Active project is selected from a dropdown. All other panels (rundowns, shotlist) are scoped to the active project.

## Project CRUD

### Create
- Button: `+ New Project` → modal with name text input
- On confirm: IPC `projects:create` → add to store, set as active

### Rename
- In dropdown or settings panel: click project name → inline edit or modal
- On confirm: IPC `projects:rename`

### Delete
- In settings panel or dropdown: delete button → confirmation dialog ("Delete project and all its data?")
- On confirm: IPC `projects:delete` → removes from store; if active, set active to first remaining or null

## Camera configuration panel

Accessible via a settings/gear icon on the active project. Shown as a modal or side panel.

```
Cameras
──────────────────────────────────────────
#  Name          Color    Resolve color
1  Main Wide     🟥       Red
2  Close-up      🟦       Blue
3  Overhead      🟩       Green
[+ Add camera]
```

Each camera row:
- Number (auto-assigned, editable)
- Name (text input)
- Color (color picker → hex)
- Resolve color (dropdown: `Red`, `Blue`, `Green`, `Yellow`, `Cyan`, `Pink`, `Purple`, `Fuchsia`, `Rose`, `Lavender`, `Sky`, `Mint`, `Lemon`, `Sand`, `Cocoa`, `Cream` — standard Resolve marker colors)

Actions per row:
- Edit inline
- Delete (with confirmation if camera is used in shots)

On save: IPC `cameras:upsert` for each changed camera.

## IPC channels

All handlers in `src/main/server/ipc/projects.ts`:

| Channel | Payload | Returns |
|---|---|---|
| `projects:list` | — | `Project[]` |
| `projects:create` | `{ name: string }` | `Project` |
| `projects:rename` | `{ id: string, name: string }` | `Project` |
| `projects:delete` | `{ id: string }` | `void` |
| `cameras:list` | `{ projectId: string }` | `Camera[]` |
| `cameras:upsert` | `Camera` (partial ok, id optional for create) | `Camera` |
| `cameras:delete` | `{ id: string }` | `void` |

## Acceptance criteria

- Can create a project, select it, and see it persist after app restart
- Can rename and delete a project
- Can add cameras with number, name, hex color, and Resolve color
- Deleting a project removes all its cameras, rundowns, and shots (cascade)
- `yarn test` passes (unit tests for IPC handlers)
