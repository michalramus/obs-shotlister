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
import type {
  CreateShotInput,
  UpdateShotInput,
  SplitShotInput,
  DeleteShotMode,
} from '../../shared/ipc-contract'

// ---------------------------------------------------------------------------
// Row shapes returned from better-sqlite3
// ---------------------------------------------------------------------------

interface ShotRow {
  id: string
  rundown_id: string
  camera_id: string | null
  part_id: string | null
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
    partId: row.part_id,
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
      'SELECT id, rundown_id, camera_id, part_id, duration_ms, label, order_index, transition_name, transition_ms FROM shots WHERE rundown_id = ? ORDER BY order_index ASC',
    )
    .all(rundownId) as ShotRow[]
  return rows.map(rowToShot)
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
  const cameraId = input.cameraId ?? null
  const partId = input.partId ?? null

  db.prepare(
    'INSERT INTO shots (id, rundown_id, camera_id, part_id, duration_ms, label, order_index, transition_name, transition_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    input.rundownId,
    cameraId,
    partId,
    input.durationMs,
    input.label ?? null,
    orderIndex,
    transitionName,
    transitionMs,
  )

  return {
    id,
    rundownId: input.rundownId,
    cameraId,
    partId,
    durationMs: input.durationMs,
    label: input.label ?? null,
    orderIndex,
    transitionName,
    transitionMs,
  }
}

export function updateShot(db: Database.Database, input: UpdateShotInput): Shot {
  // Check existence first
  const existing = db
    .prepare(
      'SELECT id, rundown_id, camera_id, part_id, duration_ms, label, order_index, transition_name, transition_ms FROM shots WHERE id = ?',
    )
    .get(input.id) as ShotRow | undefined

  if (!existing) {
    throw new Error(`Shot not found: ${input.id}`)
  }

  const cameraId = input.cameraId ?? existing.camera_id
  // Assigning a Part never clears the Camera, and vice versa: both targets are
  // retained so converting a Rundown away from its Kind and back is exact.
  const partId = input.partId ?? existing.part_id
  const durationMs = input.durationMs ?? existing.duration_ms
  // label can be explicitly set to null to clear it
  const label = 'label' in input ? (input.label ?? null) : existing.label
  // transitionName can be explicitly set to null to clear it
  const transitionName =
    'transitionName' in input ? (input.transitionName ?? null) : existing.transition_name
  const transitionMs = input.transitionMs ?? existing.transition_ms

  db.prepare(
    'UPDATE shots SET camera_id = ?, part_id = ?, duration_ms = ?, label = ?, transition_name = ?, transition_ms = ? WHERE id = ?',
  ).run(cameraId, partId, durationMs, label, transitionName, transitionMs, input.id)

  const updated = db
    .prepare(
      'SELECT id, rundown_id, camera_id, part_id, duration_ms, label, order_index, transition_name, transition_ms FROM shots WHERE id = ?',
    )
    .get(input.id) as ShotRow
  return rowToShot(updated)
}

export function deleteShot(
  db: Database.Database,
  id: string,
  mode: DeleteShotMode = 'extend',
): void {
  const existing = db
    .prepare('SELECT id, rundown_id, duration_ms, order_index FROM shots WHERE id = ?')
    .get(id) as Pick<ShotRow, 'id' | 'rundown_id' | 'duration_ms' | 'order_index'> | undefined

  if (!existing) {
    throw new Error(`Shot not found: ${id}`)
  }

  if (mode === 'ripple') {
    db.prepare('DELETE FROM shots WHERE id = ?').run(id)
    return
  }

  // Prefer the shot to the left; deleting the first shot has none, so the shot
  // to the right absorbs the time instead and the timeline still starts at 0.
  const neighbour = (db
    .prepare(
      'SELECT id FROM shots WHERE rundown_id = ? AND order_index < ? ORDER BY order_index DESC LIMIT 1',
    )
    .get(existing.rundown_id, existing.order_index) ??
    db
      .prepare(
        'SELECT id FROM shots WHERE rundown_id = ? AND order_index > ? ORDER BY order_index ASC LIMIT 1',
      )
      .get(existing.rundown_id, existing.order_index)) as { id: string } | undefined

  const run = db.transaction(() => {
    if (neighbour) {
      db.prepare('UPDATE shots SET duration_ms = duration_ms + ? WHERE id = ?').run(
        existing.duration_ms,
        neighbour.id,
      )
    }
    db.prepare('DELETE FROM shots WHERE id = ?').run(id)
  })
  run()
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

export function splitShot(
  db: Database.Database,
  input: SplitShotInput,
): { first: Shot; second: Shot } {
  const existing = db
    .prepare(
      'SELECT id, rundown_id, camera_id, part_id, duration_ms, label, order_index, transition_name, transition_ms FROM shots WHERE id = ?',
    )
    .get(input.shotId) as ShotRow | undefined
  if (!existing) throw new Error(`Shot not found: ${input.shotId}`)
  if (input.atMs <= 0 || input.atMs >= existing.duration_ms) {
    throw new Error(
      `Invalid split position: ${input.atMs} (shot duration: ${existing.duration_ms})`,
    )
  }

  const newId = randomUUID()
  const newOrderIndex = existing.order_index + 1

  const doSplit = db.transaction(() => {
    // Shift all subsequent shots up by 1
    db.prepare(
      'UPDATE shots SET order_index = order_index + 1 WHERE rundown_id = ? AND order_index > ?',
    ).run(existing.rundown_id, existing.order_index)
    // Update existing shot duration
    db.prepare('UPDATE shots SET duration_ms = ? WHERE id = ?').run(input.atMs, input.shotId)
    // Insert new shot. The half that is split off inherits whichever target the
    // caller did not name, so splitting a Call in a Voice-over Rundown does not
    // silently produce an item with no Part — which a Live session would then
    // refuse to start on.
    db.prepare(
      'INSERT INTO shots (id, rundown_id, camera_id, part_id, duration_ms, label, order_index, transition_name, transition_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      newId,
      existing.rundown_id,
      input.newCameraId ?? existing.camera_id,
      input.newPartId ?? existing.part_id,
      existing.duration_ms - input.atMs,
      null,
      newOrderIndex,
      null,
      0,
    )
  })
  doSplit()

  const first = db
    .prepare(
      'SELECT id, rundown_id, camera_id, part_id, duration_ms, label, order_index, transition_name, transition_ms FROM shots WHERE id = ?',
    )
    .get(input.shotId) as ShotRow
  const second = db
    .prepare(
      'SELECT id, rundown_id, camera_id, part_id, duration_ms, label, order_index, transition_name, transition_ms FROM shots WHERE id = ?',
    )
    .get(newId) as ShotRow

  return { first: rowToShot(first), second: rowToShot(second) }
}
