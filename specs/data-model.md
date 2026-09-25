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

### Voice-over additions

Rundowns carry a Kind, items carry both targets, and Parts, Lyrics and the speech cache are their
own tables. `shots.camera_id` became nullable — a Call has no Camera — which needs a table rebuild
rather than the idempotent `ALTER TABLE` pattern used for every other column.

```sql
ALTER TABLE rundowns ADD COLUMN kind TEXT NOT NULL DEFAULT 'camera';  -- 'camera' | 'voice'
ALTER TABLE shots    ADD COLUMN part_id TEXT REFERENCES parts(id);
-- shots.camera_id rebuilt as nullable

CREATE TABLE parts (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number     INTEGER NOT NULL,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL,
  folder     TEXT,                                            -- folder scope, NULL otherwise
  rundown_id TEXT REFERENCES rundowns(id) ON DELETE CASCADE,   -- rundown scope, NULL otherwise
  UNIQUE(project_id, number)
);

CREATE TABLE lyrics (
  id         TEXT PRIMARY KEY,
  rundown_id TEXT NOT NULL REFERENCES rundowns(id) ON DELETE CASCADE,
  start_ms   INTEGER NOT NULL,
  end_ms     INTEGER NOT NULL,
  text       TEXT NOT NULL
);

-- One row per synthesised clip, content-addressed on (text, Voice, engine). The
-- duration is stored because flush placement schedules the phrase backwards from
-- the first countdown number.
CREATE TABLE speech_clips (
  hash        TEXT PRIMARY KEY,
  text        TEXT NOT NULL,
  voice       TEXT NOT NULL,
  engine      TEXT NOT NULL,
  duration_ms INTEGER NOT NULL
);

-- Which clip a Part was last rendered to: a content-addressed clip carries no
-- Part identity, so without this a renamed Part (stale) is indistinguishable
-- from one never rendered (missing).
CREATE TABLE part_renders (
  part_id TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  voice   TEXT NOT NULL,
  engine  TEXT NOT NULL,
  hash    TEXT NOT NULL,
  PRIMARY KEY (part_id, voice, engine)
);
```

Clip files themselves are not in the database: they live in `speech/` under the app data folder,
named by hash, and downloaded voice models in `piper-voices/` beside them.

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

export type RundownKind = 'camera' | 'voice'

/** One item of a Rundown: a Shot in a Camera Rundown, a Call in a Voice-over one. */
export interface Shot {
  id: string
  rundownId: string
  cameraId: string | null   // the target read in a Camera Rundown
  partId: string | null     // the target read in a Voice-over Rundown
  durationMs: number
  label: string | null
  orderIndex: number
}

export interface Part {
  id: string
  projectId: string
  number: number
  name: string
  color: string             // hex
  folder: string | null     // folder scope
  rundownId: string | null  // rundown scope
}

export interface Lyric {
  id: string
  rundownId: string
  startMs: number
  endMs: number
  text: string
}
```

`Rundown` carries `kind: RundownKind`. Both targets on an item are kept across a conversion, so
converting a Rundown away from its Kind and back restores the original assignments exactly; an item
whose target for the current Kind is null is unassigned and a Live session refuses to start.

## Zustand store (`src/renderer/store.ts`)

```ts
interface AppStore {
  // Data
  projects: Project[]
  cameras: Camera[]           // cameras for active project
  rundowns: Rundown[]         // rundowns for active project
  shots: Shot[]               // shots or calls for active rundown
  parts: Part[]               // parts in scope for active rundown
  lyrics: Lyric[]             // lyrics for active rundown

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
