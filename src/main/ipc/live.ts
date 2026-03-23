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
import type { Shot } from '../../shared/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LiveState {
  rundownId: string | null
  liveIndex: number | null
  startedAt: number | null
  running: boolean
  skippedIds: string[]
}

interface LiveStateRow {
  rundown_id: string | null
  live_shot_id: string | null
  started_at: number | null
  running: number
  skipped_ids: string
}

interface ShotRow {
  id: string
  order_index: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToLiveState(row: LiveStateRow, liveIndex: number | null): LiveState {
  return {
    rundownId: row.rundown_id,
    liveIndex,
    startedAt: row.started_at,
    running: row.running === 1,
    skippedIds: JSON.parse(row.skipped_ids) as string[],
  }
}

function getShotsForRundown(db: Database.Database, rundownId: string): ShotRow[] {
  return db
    .prepare('SELECT id, order_index FROM shots WHERE rundown_id = ? ORDER BY order_index ASC')
    .all(rundownId) as ShotRow[]
}

function liveShotIdToIndex(shots: ShotRow[], liveShotId: string | null): number | null {
  if (!liveShotId) return null
  const idx = shots.findIndex((s) => s.id === liveShotId)
  return idx === -1 ? null : idx
}

function findNextNonSkipped(shots: ShotRow[], fromIndex: number, skippedIds: string[]): number | null {
  for (let i = fromIndex + 1; i < shots.length; i++) {
    if (!skippedIds.includes(shots[i].id)) {
      return i
    }
  }
  return null
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

export function startLive(db: Database.Database, rundownId: string): LiveState {
  const shots = getShotsForRundown(db, rundownId)

  if (shots.length === 0) {
    throw new Error('Cannot start: rundown has no shots')
  }

  const liveShotId = shots[0].id
  const startedAt = Date.now()

  db.prepare(
    'UPDATE live_state SET rundown_id = ?, live_shot_id = ?, started_at = ?, running = 1, skipped_ids = ? WHERE id = 1',
  ).run(rundownId, liveShotId, startedAt, '[]')

  return {
    rundownId,
    liveIndex: 0,
    startedAt,
    running: true,
    skippedIds: [],
  }
}

export function stopLive(db: Database.Database): LiveState {
  const row = db.prepare('SELECT * FROM live_state WHERE id = 1').get() as LiveStateRow

  db.prepare(
    'UPDATE live_state SET live_shot_id = NULL, started_at = NULL, running = 0 WHERE id = 1',
  ).run()

  return {
    rundownId: row.rundown_id,
    liveIndex: null,
    startedAt: null,
    running: false,
    skippedIds: JSON.parse(row.skipped_ids) as string[],
  }
}

export function nextShot(db: Database.Database): LiveState {
  const row = db.prepare('SELECT * FROM live_state WHERE id = 1').get() as LiveStateRow

  if (!row.running || !row.rundown_id) {
    throw new Error('Cannot advance: not running')
  }

  const shots = getShotsForRundown(db, row.rundown_id)
  const skippedIds = JSON.parse(row.skipped_ids) as string[]
  const currentIndex = liveShotIdToIndex(shots, row.live_shot_id) ?? 0

  const nextIndex = findNextNonSkipped(shots, currentIndex, skippedIds)

  if (nextIndex === null) {
    // Past last shot → transition to idle
    db.prepare(
      'UPDATE live_state SET live_shot_id = NULL, started_at = NULL, running = 0 WHERE id = 1',
    ).run()
    return {
      rundownId: row.rundown_id,
      liveIndex: null,
      startedAt: null,
      running: false,
      skippedIds,
    }
  }

  const liveShotId = shots[nextIndex].id
  const startedAt = Date.now()

  db.prepare(
    'UPDATE live_state SET live_shot_id = ?, started_at = ? WHERE id = 1',
  ).run(liveShotId, startedAt)

  return {
    rundownId: row.rundown_id,
    liveIndex: nextIndex,
    startedAt,
    running: true,
    skippedIds,
  }
}

export function skipNext(db: Database.Database): LiveState {
  const row = db.prepare('SELECT * FROM live_state WHERE id = 1').get() as LiveStateRow

  if (!row.running || !row.rundown_id) {
    throw new Error('Cannot skip: not running')
  }

  const shots = getShotsForRundown(db, row.rundown_id)
  const skippedIds = JSON.parse(row.skipped_ids) as string[]
  const currentIndex = liveShotIdToIndex(shots, row.live_shot_id) ?? 0

  // Find the next shot after current (regardless of skip status) and mark it skipped
  // We skip the next physical shot in the ordered list that isn't already skipped
  // Actually per spec: marks "next queued shot (after liveIndex) as skipped"
  // Find first non-skipped shot after current
  let nextToSkip: Shot | ShotRow | null = null
  for (let i = currentIndex + 1; i < shots.length; i++) {
    if (!skippedIds.includes(shots[i].id)) {
      nextToSkip = shots[i]
      break
    }
  }

  if (!nextToSkip) {
    // Nothing to skip
    return rowToLiveState(row, currentIndex)
  }

  if (!skippedIds.includes(nextToSkip.id)) {
    skippedIds.push(nextToSkip.id)
  }

  db.prepare('UPDATE live_state SET skipped_ids = ? WHERE id = 1').run(JSON.stringify(skippedIds))

  return {
    rundownId: row.rundown_id,
    liveIndex: currentIndex,
    startedAt: row.started_at,
    running: true,
    skippedIds,
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
    'UPDATE live_state SET live_shot_id = ?, started_at = ?, running = 1, skipped_ids = ? WHERE id = 1',
  ).run(liveShotId, startedAt, '[]')

  return {
    rundownId: row.rundown_id,
    liveIndex: 0,
    startedAt,
    running: true,
    skippedIds: [],
  }
}
