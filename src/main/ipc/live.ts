/**
 * IPC handler logic for live playback state.
 *
 * State machine: idle → running → idle
 * Progress fields (running, live_shot_id, started_at) are kept in memory only —
 * they are never persisted to the database.
 * Selection fields (rundown_id, project_id) are persisted to the live_state row.
 * An in-memory liveQueue tracks which shots are visible during the session.
 *
 * IPC registration (ipcMain.handle) happens in src/main/index.ts.
 * Socket.io broadcast is initiated in src/main/index.ts after each action.
 */

import Database from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LiveState {
  rundownId: string | null
  projectId: string | null
  liveIndex: number | null
  startedAt: number | null
  running: boolean
}

interface LiveStateRow {
  rundown_id: string | null
  project_id: string | null
}

interface ShotRow {
  id: string
  order_index: number
  duration_ms: number
}

interface LiveQueueEntry extends ShotRow {
  hidden: boolean
}

// ---------------------------------------------------------------------------
// In-memory live progress state
// ---------------------------------------------------------------------------

let liveQueue: LiveQueueEntry[] = []
let liveShotId: string | null = null
let startedAt: number | null = null
let running = false

export function getLiveQueue(): LiveQueueEntry[] {
  return liveQueue
}

export function getVisibleQueue(): LiveQueueEntry[] {
  return liveQueue.filter((s) => !s.hidden)
}

/** Resets all in-memory live progress state. Use in tests or on app shutdown. */
export function resetInMemoryLiveState(): void {
  liveQueue = []
  liveShotId = null
  startedAt = null
  running = false
}

export function clearLiveState(db: Database.Database): void {
  db.prepare(`UPDATE live_state SET rundown_id = NULL WHERE id = 1`).run()
  liveQueue = []
  liveShotId = null
  startedAt = null
  running = false
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToLiveState(row: LiveStateRow, liveIndex: number | null): LiveState {
  return {
    rundownId: row.rundown_id,
    projectId: row.project_id,
    liveIndex,
    startedAt,
    running,
  }
}

function getShotsForRundown(db: Database.Database, rundownId: string): ShotRow[] {
  return db
    .prepare(
      'SELECT id, order_index, duration_ms FROM shots WHERE rundown_id = ? ORDER BY order_index ASC',
    )
    .all(rundownId) as ShotRow[]
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function getLiveState(db: Database.Database): LiveState {
  const row = db
    .prepare('SELECT rundown_id, project_id FROM live_state WHERE id = 1')
    .get() as LiveStateRow

  let liveIndex: number | null = null
  if (running && liveQueue.length > 0) {
    liveIndex = liveQueue.findIndex((s) => s.id === liveShotId)
    if (liveIndex === -1) liveIndex = null
  }

  return rowToLiveState(row, liveIndex)
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function setActiveRundown(db: Database.Database, rundownId: string | null): void {
  db.prepare('UPDATE live_state SET rundown_id = ? WHERE id = 1').run(rundownId)
}

export function setActiveProject(db: Database.Database, projectId: string | null): void {
  db.prepare('UPDATE live_state SET project_id = ? WHERE id = 1').run(projectId)
}

export function startLive(db: Database.Database, rundownId: string): LiveState {
  const shots = getShotsForRundown(db, rundownId)

  if (shots.length === 0) {
    throw new Error('Cannot start: rundown has no shots')
  }

  const stateRow = db.prepare('SELECT project_id FROM live_state WHERE id = 1').get() as Pick<
    LiveStateRow,
    'project_id'
  >

  // Persist rundown selection (not progress)
  db.prepare('UPDATE live_state SET rundown_id = ? WHERE id = 1').run(rundownId)

  liveShotId = shots[0].id
  startedAt = Date.now()
  running = true
  liveQueue = shots.map((s) => ({ ...s, hidden: false }))

  return {
    rundownId,
    projectId: stateRow.project_id,
    liveIndex: 0,
    startedAt,
    running: true,
  }
}

export function stopLive(db: Database.Database): LiveState {
  const row = db
    .prepare('SELECT rundown_id, project_id FROM live_state WHERE id = 1')
    .get() as LiveStateRow

  liveShotId = null
  startedAt = null
  running = false
  liveQueue = []

  return {
    rundownId: row.rundown_id,
    projectId: row.project_id,
    liveIndex: null,
    startedAt: null,
    running: false,
  }
}

export interface NextShotResult {
  state: LiveState
  hiddenShotId: string | null
}

export function nextShot(db: Database.Database): NextShotResult {
  const row = db
    .prepare('SELECT rundown_id, project_id FROM live_state WHERE id = 1')
    .get() as LiveStateRow

  if (!running || !row.rundown_id) {
    throw new Error('Cannot advance: not running')
  }

  const visible = getVisibleQueue()
  const currentIndex = visible.findIndex((s) => s.id === liveShotId)
  const nextEntry = visible[currentIndex + 1]

  if (!nextEntry) {
    // Past last shot → transition to idle
    liveShotId = null
    startedAt = null
    running = false
    liveQueue = []
    return {
      state: {
        rundownId: row.rundown_id,
        projectId: row.project_id,
        liveIndex: null,
        startedAt: null,
        running: false,
      },
      hiddenShotId: null,
    }
  }

  const hiddenShotId = liveShotId

  // Mark current shot as hidden
  liveQueue = liveQueue.map((s) => (s.id === liveShotId ? { ...s, hidden: true } : s))

  const newLiveIndex = liveQueue.findIndex((s) => s.id === nextEntry.id)

  liveShotId = nextEntry.id
  startedAt = Date.now()

  return {
    state: {
      rundownId: row.rundown_id,
      projectId: row.project_id,
      liveIndex: newLiveIndex === -1 ? null : newLiveIndex,
      startedAt,
      running: true,
    },
    hiddenShotId,
  }
}

export interface SkipNextResult {
  state: LiveState
  hiddenShotId: string | null
}

export function skipNext(db: Database.Database): SkipNextResult {
  const row = db
    .prepare('SELECT rundown_id, project_id FROM live_state WHERE id = 1')
    .get() as LiveStateRow

  if (!running || !row.rundown_id) {
    throw new Error('Cannot skip: not running')
  }

  const visible = getVisibleQueue()
  const currentIndex = visible.findIndex((s) => s.id === liveShotId)

  const toSkip = visible[currentIndex + 1]
  if (!toSkip) {
    // Nothing to skip — return current state unchanged
    return {
      state: rowToLiveState(row, currentIndex === -1 ? null : currentIndex),
      hiddenShotId: null,
    }
  }

  // Mark the next visible shot as hidden (no DB deletion)
  liveQueue = liveQueue.map((s) => (s.id === toSkip.id ? { ...s, hidden: true } : s))

  const newLiveIndex = liveQueue.findIndex((s) => s.id === liveShotId)

  return {
    state: rowToLiveState(row, newLiveIndex === -1 ? null : newLiveIndex),
    hiddenShotId: toSkip.id,
  }
}

export function restartLive(db: Database.Database): LiveState {
  const row = db
    .prepare('SELECT rundown_id, project_id FROM live_state WHERE id = 1')
    .get() as LiveStateRow

  if (!row.rundown_id) {
    throw new Error('Cannot restart: no active rundown')
  }

  const shots = getShotsForRundown(db, row.rundown_id)
  if (shots.length === 0) {
    throw new Error('Cannot restart: rundown has no shots')
  }

  liveQueue = shots.map((s) => ({ ...s, hidden: false }))

  liveShotId = shots[0].id
  startedAt = Date.now()
  running = true

  return {
    rundownId: row.rundown_id,
    projectId: row.project_id,
    liveIndex: 0,
    startedAt,
    running: true,
  }
}
