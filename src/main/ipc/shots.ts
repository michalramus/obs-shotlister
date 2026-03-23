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
  }
}

// ---------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------

export function listShots(db: Database.Database, rundownId: string): Shot[] {
  const rows = db
    .prepare(
      'SELECT id, rundown_id, camera_id, duration_ms, label, order_index FROM shots WHERE rundown_id = ? ORDER BY order_index ASC',
    )
    .all(rundownId) as ShotRow[]
  return rows.map(rowToShot)
}

export interface CreateShotInput {
  rundownId: string
  cameraId: string
  durationMs: number
  label?: string | null
}

export function createShot(db: Database.Database, input: CreateShotInput): Shot {
  const id = randomUUID()

  // Compute next orderIndex
  const maxRow = db
    .prepare('SELECT COALESCE(MAX(order_index), -1) as max_idx FROM shots WHERE rundown_id = ?')
    .get(input.rundownId) as { max_idx: number }
  const orderIndex = maxRow.max_idx + 1

  db.prepare(
    'INSERT INTO shots (id, rundown_id, camera_id, duration_ms, label, order_index) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, input.rundownId, input.cameraId, input.durationMs, input.label ?? null, orderIndex)

  return {
    id,
    rundownId: input.rundownId,
    cameraId: input.cameraId,
    durationMs: input.durationMs,
    label: input.label ?? null,
    orderIndex,
  }
}

export interface UpdateShotInput {
  id: string
  cameraId?: string
  durationMs?: number
  label?: string | null
}

export function updateShot(db: Database.Database, input: UpdateShotInput): Shot {
  // Check existence first
  const existing = db
    .prepare('SELECT id, rundown_id, camera_id, duration_ms, label, order_index FROM shots WHERE id = ?')
    .get(input.id) as ShotRow | undefined

  if (!existing) {
    throw new Error(`Shot not found: ${input.id}`)
  }

  const cameraId = input.cameraId ?? existing.camera_id
  const durationMs = input.durationMs ?? existing.duration_ms
  // label can be explicitly set to null to clear it
  const label = 'label' in input ? (input.label ?? null) : existing.label

  db.prepare(
    'UPDATE shots SET camera_id = ?, duration_ms = ?, label = ? WHERE id = ?',
  ).run(cameraId, durationMs, label, input.id)

  const updated = db
    .prepare('SELECT id, rundown_id, camera_id, duration_ms, label, order_index FROM shots WHERE id = ?')
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
