/**
 * IPC handler logic for shot CRUD and reorder operations.
 *
 * Each function accepts a Database instance so it can be tested with an
 * in-memory database without requiring an Electron context.
 *
 * IPC registration (ipcMain.handle) happens in src/main/index.ts.
 */

import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type { Shot } from '../../shared/types'

// ---------------------------------------------------------------------------
// Row shapes returned from better-sqlite3
// ---------------------------------------------------------------------------

interface ShotRow {
  id: string
  rundown_id: string
  camera_id: string
  duration_ms: number
  label: string | null
  order_index: number
  transition_name: string | null
  transition_ms: number
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function rowToShot(row: ShotRow): Shot {
  return {
    id: row.id,
    rundownId: row.rundown_id,
    cameraId: row.camera_id,
    durationMs: row.duration_ms,
    label: row.label,
    orderIndex: row.order_index,
    transitionName: row.transition_name ?? null,
    transitionMs: row.transition_ms ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------

export function listShots(db: Database.Database, rundownId: string): Shot[] {
  const rows = db
    .prepare(
      'SELECT id, rundown_id, camera_id, duration_ms, label, order_index, transition_name, transition_ms FROM shots WHERE rundown_id = ? ORDER BY order_index ASC',
    )
    .all(rundownId) as ShotRow[]
  return rows.map(rowToShot)
}

export interface CreateShotInput {
  rundownId: string
  cameraId: string
  durationMs: number
  label?: string | null
  transitionName?: string | null
  transitionMs?: number
}

export function createShot(db: Database.Database, input: CreateShotInput): Shot {
  const id = randomUUID()

  // Compute next orderIndex
  const maxRow = db
    .prepare('SELECT COALESCE(MAX(order_index), -1) as max_idx FROM shots WHERE rundown_id = ?')
    .get(input.rundownId) as { max_idx: number }
  const orderIndex = maxRow.max_idx + 1

  const transitionName = input.transitionName ?? null
  const transitionMs = input.transitionMs ?? 0

  db.prepare(
    'INSERT INTO shots (id, rundown_id, camera_id, duration_ms, label, order_index, transition_name, transition_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, input.rundownId, input.cameraId, input.durationMs, input.label ?? null, orderIndex, transitionName, transitionMs)

  return {
    id,
    rundownId: input.rundownId,
    cameraId: input.cameraId,
    durationMs: input.durationMs,
    label: input.label ?? null,
    orderIndex,
    transitionName,
    transitionMs,
  }
}

export interface UpdateShotInput {
  id: string
  cameraId?: string
  durationMs?: number
  label?: string | null
  transitionName?: string | null
  transitionMs?: number
}

export function updateShot(db: Database.Database, input: UpdateShotInput): Shot {
  // Check existence first
  const existing = db
    .prepare('SELECT id, rundown_id, camera_id, duration_ms, label, order_index, transition_name, transition_ms FROM shots WHERE id = ?')
    .get(input.id) as ShotRow | undefined

  if (!existing) {
    throw new Error(`Shot not found: ${input.id}`)
  }

  const cameraId = input.cameraId ?? existing.camera_id
  const durationMs = input.durationMs ?? existing.duration_ms
  // label can be explicitly set to null to clear it
  const label = 'label' in input ? (input.label ?? null) : existing.label
  // transitionName can be explicitly set to null to clear it
  const transitionName = 'transitionName' in input ? (input.transitionName ?? null) : existing.transition_name
  const transitionMs = input.transitionMs ?? existing.transition_ms

  db.prepare(
    'UPDATE shots SET camera_id = ?, duration_ms = ?, label = ?, transition_name = ?, transition_ms = ? WHERE id = ?',
  ).run(cameraId, durationMs, label, transitionName, transitionMs, input.id)

  const updated = db
    .prepare('SELECT id, rundown_id, camera_id, duration_ms, label, order_index, transition_name, transition_ms FROM shots WHERE id = ?')
    .get(input.id) as ShotRow
  return rowToShot(updated)
}

export function deleteShot(db: Database.Database, id: string): void {
  const result = db.prepare('DELETE FROM shots WHERE id = ?').run(id)

  if (result.changes === 0) {
    throw new Error(`Shot not found: ${id}`)
  }
}

export function reorderShots(db: Database.Database, ids: string[]): void {
  const update = db.prepare('UPDATE shots SET order_index = ? WHERE id = ?')
  const updateAll = db.transaction(() => {
    ids.forEach((id, index) => {
      update.run(index, id)
    })
  })
  updateAll()
}

export interface SplitShotInput {
  shotId: string
  atMs: number
  newCameraId: string
}

export function splitShot(db: Database.Database, input: SplitShotInput): { first: Shot; second: Shot } {
  const existing = db.prepare('SELECT id, rundown_id, camera_id, duration_ms, label, order_index, transition_name, transition_ms FROM shots WHERE id = ?').get(input.shotId) as ShotRow | undefined
  if (!existing) throw new Error(`Shot not found: ${input.shotId}`)
  if (input.atMs <= 0 || input.atMs >= existing.duration_ms) {
    throw new Error(`Invalid split position: ${input.atMs} (shot duration: ${existing.duration_ms})`)
  }

  const newId = randomUUID()
  const newOrderIndex = existing.order_index + 1

  const doSplit = db.transaction(() => {
    // Shift all subsequent shots up by 1
    db.prepare('UPDATE shots SET order_index = order_index + 1 WHERE rundown_id = ? AND order_index > ?')
      .run(existing.rundown_id, existing.order_index)
    // Update existing shot duration
    db.prepare('UPDATE shots SET duration_ms = ? WHERE id = ?').run(input.atMs, input.shotId)
    // Insert new shot
    db.prepare('INSERT INTO shots (id, rundown_id, camera_id, duration_ms, label, order_index, transition_name, transition_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(newId, existing.rundown_id, input.newCameraId, existing.duration_ms - input.atMs, null, newOrderIndex, null, 0)
  })
  doSplit()

  const first = db.prepare('SELECT id, rundown_id, camera_id, duration_ms, label, order_index, transition_name, transition_ms FROM shots WHERE id = ?').get(input.shotId) as ShotRow
  const second = db.prepare('SELECT id, rundown_id, camera_id, duration_ms, label, order_index, transition_name, transition_ms FROM shots WHERE id = ?').get(newId) as ShotRow

  return { first: rowToShot(first), second: rowToShot(second) }
}
