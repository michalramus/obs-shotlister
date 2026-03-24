/**
 * IPC handler logic for live playback state.
 *
 * State machine: idle → running → idle
 * All mutations persist to the live_state singleton row in SQLite.
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
  live_shot_id: string | null
  started_at: number | null
  running: number
}

interface ShotRow {
  id: string
  order_index: number
  duration_ms: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToLiveState(row: LiveStateRow, liveIndex: number | null): LiveState {
  return {
    rundownId: row.rundown_id,
    projectId: row.project_id,
    liveIndex,
    startedAt: row.started_at,
    running: row.running === 1,
  }
}

function getShotsForRundown(db: Database.Database, rundownId: string): ShotRow[] {
  return db
    .prepare('SELECT id, order_index, duration_ms FROM shots WHERE rundown_id = ? ORDER BY order_index ASC')
    .all(rundownId) as ShotRow[]
}

function liveShotIdToIndex(shots: ShotRow[], liveShotId: string | null): number | null {
  if (!liveShotId) return null
  const idx = shots.findIndex((s) => s.id === liveShotId)
  return idx === -1 ? null : idx
}

export function findNext(shots: ShotRow[], fromIndex: number): number | null {
  const next = fromIndex + 1
  return next < shots.length ? next : null
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function getLiveState(db: Database.Database): LiveState {
  const row = db.prepare('SELECT * FROM live_state WHERE id = 1').get() as LiveStateRow
  let liveIndex: number | null = null

  if (row.rundown_id && row.live_shot_id) {
    const shots = getShotsForRundown(db, row.rundown_id)
    liveIndex = liveShotIdToIndex(shots, row.live_shot_id)
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

  const stateRow = db.prepare('SELECT project_id FROM live_state WHERE id = 1').get() as Pick<LiveStateRow, 'project_id'>
  const liveShotId = shots[0].id
  const startedAt = Date.now()

  db.prepare(
    'UPDATE live_state SET rundown_id = ?, live_shot_id = ?, started_at = ?, running = 1 WHERE id = 1',
  ).run(rundownId, liveShotId, startedAt)

  return {
    rundownId,
    projectId: stateRow.project_id,
    liveIndex: 0,
    startedAt,
    running: true,
  }
}

export function stopLive(db: Database.Database): LiveState {
  const row = db.prepare('SELECT * FROM live_state WHERE id = 1').get() as LiveStateRow

  db.prepare(
    'UPDATE live_state SET live_shot_id = NULL, started_at = NULL, running = 0 WHERE id = 1',
  ).run()

  return {
    rundownId: row.rundown_id,
    projectId: row.project_id,
    liveIndex: null,
    startedAt: null,
    running: false,
  }
}

export function nextShot(db: Database.Database): LiveState {
  const row = db.prepare('SELECT * FROM live_state WHERE id = 1').get() as LiveStateRow

  if (!row.running || !row.rundown_id) {
    throw new Error('Cannot advance: not running')
  }

  const shots = getShotsForRundown(db, row.rundown_id)
  const currentIndex = liveShotIdToIndex(shots, row.live_shot_id) ?? 0

  const nextIndex = findNext(shots, currentIndex)

  if (nextIndex === null) {
    // Past last shot → transition to idle
    db.prepare(
      'UPDATE live_state SET live_shot_id = NULL, started_at = NULL, running = 0 WHERE id = 1',
    ).run()
    return {
      rundownId: row.rundown_id,
      projectId: row.project_id,
      liveIndex: null,
      startedAt: null,
      running: false,
    }
  }

  const liveShotId = shots[nextIndex].id
  const startedAt = Date.now()

  db.prepare(
    'UPDATE live_state SET live_shot_id = ?, started_at = ? WHERE id = 1',
  ).run(liveShotId, startedAt)

  return {
    rundownId: row.rundown_id,
    projectId: row.project_id,
    liveIndex: nextIndex,
    startedAt,
    running: true,
  }
}

export function skipNext(db: Database.Database): LiveState {
  const row = db.prepare('SELECT * FROM live_state WHERE id = 1').get() as LiveStateRow

  if (!row.running || !row.rundown_id) {
    throw new Error('Cannot skip: not running')
  }

  const shots = getShotsForRundown(db, row.rundown_id)
  const currentIndex = liveShotIdToIndex(shots, row.live_shot_id) ?? 0

  // Find the next shot after current
  const nextIndex = findNext(shots, currentIndex)
  if (nextIndex === null) {
    // Nothing to skip
    return rowToLiveState(row, currentIndex)
  }

  const nextShot = shots[nextIndex]
  const durationMs = nextShot.duration_ms

  // In a transaction: extend current shot's started_at back by next shot's duration,
  // then delete the next shot
  const skipTx = db.transaction(() => {
    db.prepare(
      'UPDATE live_state SET started_at = started_at - ? WHERE id = 1',
    ).run(durationMs)
    db.prepare('DELETE FROM shots WHERE id = ?').run(nextShot.id)
  })
  skipTx()

  const updatedRow = db.prepare('SELECT * FROM live_state WHERE id = 1').get() as LiveStateRow

  return {
    rundownId: updatedRow.rundown_id,
    projectId: updatedRow.project_id,
    liveIndex: currentIndex,
    startedAt: updatedRow.started_at,
    running: true,
  }
}

export function restartLive(db: Database.Database): LiveState {
  const row = db.prepare('SELECT * FROM live_state WHERE id = 1').get() as LiveStateRow

  if (!row.rundown_id) {
    throw new Error('Cannot restart: no active rundown')
  }

  const shots = getShotsForRundown(db, row.rundown_id)
  if (shots.length === 0) {
    throw new Error('Cannot restart: rundown has no shots')
  }

  const liveShotId = shots[0].id
  const startedAt = Date.now()

  db.prepare(
    'UPDATE live_state SET live_shot_id = ?, started_at = ?, running = 1 WHERE id = 1',
  ).run(liveShotId, startedAt)

  return {
    rundownId: row.rundown_id,
    projectId: row.project_id,
    liveIndex: 0,
    startedAt,
    running: true,
  }
}
