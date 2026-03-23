# Feature: DaVinci Resolve CSV Import

## Dependencies
- `specs/data-model.md`
- `specs/project-management.md` (cameras with `resolveColor` configured)
- `specs/rundown-management.md` (active rundown to import into)

## Goal

Import shots from a DaVinci Resolve marker CSV export into the active rundown.

## Resolve CSV format

Standard Resolve marker export columns (relevant ones):

| Column | Example | Usage |
|---|---|---|
| `Name` | `Opening wide` | → shot `label` |
| `Duration` | `00:00:05:00` | → `durationMs` (timecode at 25fps default, configurable) |
| `Color` | `Red` | → camera lookup via project color mapping |

## Import flow

### Step 1: File picker
- `Import from Resolve` button → Electron `dialog.showOpenDialog` for `.csv` file
- IPC channel: `shots:import-csv:parse` — reads file, returns parsed rows

### Step 1b: FPS setting

Before or alongside the mapping step, show an FPS selector:
- Label: `Timecode FPS`
- Dropdown: `23.976`, `24`, `25` (default), `29.97`, `30`, `50`, `59.94`, `60`

### Step 2: Color → Camera mapping dialog

Show a mapping table. Pre-fills from project camera `resolveColor` settings:

```
Map Resolve colors to cameras
──────────────────────────────
Resolve color   Camera
Red             [CAM1 — Main Wide    ▾]
Blue            [CAM2 — Close-up     ▾]
Green           [CAM3 — Overhead     ▾]
Orange          [— unmapped —        ▾]
```

- Each row: Resolve color found in CSV → dropdown of project cameras (or "unmapped")
- Pre-fills: for each CSV color, find a project camera where `resolveColor === csvColor`
- User can override any mapping
- Unmapped colors → shots will be skipped (shown in preview with warning)

### Step 3: Import mode

Radio buttons:
- **Append** — add shots after existing shots in rundown
- **Replace** — delete all existing shots, replace with imported shots

### Step 4: Preview table

```
#   Color   Camera        Label           Duration
1   Red     CAM1 Wide     Opening wide    0:05
2   Blue    CAM2 Close    Interview       1:00
3   Orange  ⚠ unmapped    B-roll          0:30  ← will be skipped
```

### Step 5: Confirm

`Import {n} shots` button (count excludes unmapped).
IPC `shots:import-csv:confirm` → inserts shots, returns new `Shot[]`.
Updates store; closes dialog.

## Timecode parsing

`Duration` column is timecode `HH:MM:SS:FF`.

FPS is set by the user **in the import dialog** (not in project settings). Default: 25fps. Common options offered: 23.976, 24, 25, 29.97, 30, 50, 59.94, 60.

`durationMs = (HH*3600 + MM*60 + SS) * 1000 + (FF / fps) * 1000`

## IPC channels

| Channel | Payload | Returns |
|---|---|---|
| `shots:import-csv:parse` | `{ filePath: string }` | `{ colors: string[], rows: ParsedRow[] }` |
| `shots:import-csv:confirm` | `{ rundownId, mode: 'append'\|'replace', mapping: Record<string, string\|null>, rows: ParsedRow[], fps: number }` | `Shot[]` |

```ts
interface ParsedRow {
  label: string
  durationTimecode: string
  resolveColor: string
}
```

## Acceptance criteria

- File picker opens and reads a valid Resolve CSV
- Color → camera mapping pre-fills from project camera settings
- User can override mappings
- Preview shows correct shots; unmapped colors are flagged
- Append and replace modes work correctly
- Duration timecode converts to ms correctly (unit tested)
- `yarn test` passes
