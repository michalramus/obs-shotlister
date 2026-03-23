# Feature: Data Model

## Goal

Define the SQLite schema, TypeScript types, and Zustand store shape used across all features.

## SQLite schema

```sql
CREATE TABLE projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL  -- Unix ms
);

CREATE TABLE cameras (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number        INTEGER NOT NULL,
  name          TEXT NOT NULL,
  color         TEXT NOT NULL,          -- hex, e.g. '#e74c3c'
  resolve_color TEXT,                   -- Resolve marker color name, e.g. 'Red'
  UNIQUE(project_id, number)
);

CREATE TABLE rundowns (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE shots (
  id           TEXT PRIMARY KEY,
  rundown_id   TEXT NOT NULL REFERENCES rundowns(id) ON DELETE CASCADE,
  camera_id    TEXT NOT NULL REFERENCES cameras(id),
  duration_ms  INTEGER NOT NULL,
  label        TEXT,
  order_index  INTEGER NOT NULL
);
```

All IDs are UUIDs (use `crypto.randomUUID()`). Schema applied via migrations in `src/main/db/index.ts` on app start.

## TypeScript types (`src/shared/types.ts`)

```ts
export interface Project {
  id: string
  name: string
  createdAt: number
}

export interface Camera {
  id: string
  projectId: string
  number: number
  name: string
  color: string        // hex
  resolveColor: string | null
}

export interface Rundown {
  id: string
  projectId: string
  name: string
  createdAt: number
}

export interface Shot {
  id: string
  rundownId: string
  cameraId: string
  durationMs: number
  label: string | null
  orderIndex: number
}
```

## Zustand store (`src/renderer/store.ts`)

```ts
interface AppStore {
  // Data
  projects: Project[]
  cameras: Camera[]           // cameras for active project
  rundowns: Rundown[]         // rundowns for active project
  shots: Shot[]               // shots for active rundown

  // Selection
  activeProjectId: string | null
  activeRundownId: string | null

  // Live playback state
  liveIndex: number | null    // index into shots[] of current live shot
  startedAt: number | null    // Date.now() when live shot started
  running: boolean            // whether rundown is started

  // Actions (call IPC, then update store)
  setActiveProject: (id: string | null) => void
  setActiveRundown: (id: string | null) => void
  setLiveState: (liveIndex: number | null, startedAt: number | null, running: boolean) => void
}
```

## Acceptance criteria

- `src/shared/types.ts` exists with all interfaces
- SQLite migration runs on app start without error
- All tables are created with correct constraints
- `yarn test` passes
