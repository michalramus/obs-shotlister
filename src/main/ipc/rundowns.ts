/**
 * IPC handler logic for rundown CRUD operations.
 *
 * Each function accepts a Database instance so it can be tested with an
 * in-memory database without requiring an Electron context.
 *
 * IPC registration (ipcMain.handle) happens in src/main/index.ts.
 */

import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type { Rundown, RundownKind } from '../../shared/types'

// ---------------------------------------------------------------------------
// Row shapes returned from better-sqlite3
// ---------------------------------------------------------------------------

interface RundownRow {
  id: string
  project_id: string
  name: string
  created_at: number
  order_index: number
  folder: string | null
  kind: RundownKind
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function rowToRundown(row: RundownRow): Rundown {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    createdAt: row.created_at,
    orderIndex: row.order_index,
    folder: row.folder ?? null,
    kind: row.kind,
  }
}

// ---------------------------------------------------------------------------
// Rundowns
// ---------------------------------------------------------------------------

export function getRundown(db: Database.Database, id: string): Rundown | null {
  const row = db
    .prepare(
      'SELECT id, project_id, name, created_at, order_index, folder, kind FROM rundowns WHERE id = ?',
    )
    .get(id) as RundownRow | undefined
  return row ? rowToRundown(row) : null
}

export function listRundowns(db: Database.Database, projectId: string): Rundown[] {
  const rows = db
    .prepare(
      'SELECT id, project_id, name, created_at, order_index, folder, kind FROM rundowns WHERE project_id = ? ORDER BY order_index ASC, created_at ASC',
    )
    .all(projectId) as RundownRow[]
  return rows.map(rowToRundown)
}

export function createRundown(db: Database.Database, projectId: string, name: string): Rundown {
  if (!name.trim()) {
    throw new Error('Rundown name must not be empty')
  }

  const id = randomUUID()
  const createdAt = Date.now()

  const orderIndexRow = db
    .prepare(
      'SELECT COALESCE(MAX(order_index), -1) + 1 AS next_index FROM rundowns WHERE project_id = ?',
    )
    .get(projectId) as { next_index: number }
  const orderIndex = orderIndexRow.next_index

  // Foreign key enforcement will throw if projectId is invalid
  db.prepare(
    'INSERT INTO rundowns (id, project_id, name, created_at, order_index) VALUES (?, ?, ?, ?, ?)',
  ).run(id, projectId, name, createdAt, orderIndex)

  return { id, projectId, name, createdAt, orderIndex, folder: null, kind: 'camera' }
}

export function reorderRundowns(db: Database.Database, ids: string[]): void {
  const update = db.prepare('UPDATE rundowns SET order_index = ? WHERE id = ?')
  const transaction = db.transaction(() => {
    for (let i = 0; i < ids.length; i++) {
      update.run(i, ids[i])
    }
  })
  transaction()
}

export function setRundownFolder(
  db: Database.Database,
  id: string,
  folder: string | null,
): Rundown {
  const result = db.prepare('UPDATE rundowns SET folder = ? WHERE id = ?').run(folder, id)

  if (result.changes === 0) {
    throw new Error(`Rundown not found: ${id}`)
  }

  const row = db
    .prepare(
      'SELECT id, project_id, name, created_at, order_index, folder, kind FROM rundowns WHERE id = ?',
    )
    .get(id) as RundownRow
  return rowToRundown(row)
}

export function renameRundown(db: Database.Database, id: string, name: string): Rundown {
  if (!name.trim()) {
    throw new Error('Rundown name must not be empty')
  }

  const result = db.prepare('UPDATE rundowns SET name = ? WHERE id = ?').run(name, id)

  if (result.changes === 0) {
    throw new Error(`Rundown not found: ${id}`)
  }

  const row = db
    .prepare(
      'SELECT id, project_id, name, created_at, order_index, folder, kind FROM rundowns WHERE id = ?',
    )
    .get(id) as RundownRow
  return rowToRundown(row)
}

/**
 * Converts a Rundown between Kinds.
 *
 * Nothing but `rundowns.kind` moves. Shots and Calls share one table and the
 * Kind decides which target column is read, so both `camera_id` and `part_id`
 * are left untouched: that is what makes converting away and back restore the
 * original assignments exactly, and what carries order, durations, labels and
 * transitions across for free.
 */
export function setRundownKind(db: Database.Database, id: string, kind: RundownKind): Rundown {
  const result = db.prepare('UPDATE rundowns SET kind = ? WHERE id = ?').run(kind, id)

  if (result.changes === 0) {
    throw new Error(`Rundown not found: ${id}`)
  }

  const row = db
    .prepare(
      'SELECT id, project_id, name, created_at, order_index, folder, kind FROM rundowns WHERE id = ?',
    )
    .get(id) as RundownRow
  return rowToRundown(row)
}

/**
 * How many of a Rundown's items have no target for its *current* Kind.
 *
 * A Rundown born in one Kind has nothing in the other column, so right after a
 * conversion every item counts. A Live session consults this before starting;
 * the refusal itself lives with the session, not here.
 */
export function unassignedItemCount(db: Database.Database, rundownId: string): number {
  const rundown = getRundown(db, rundownId)
  if (!rundown) {
    throw new Error(`Rundown not found: ${rundownId}`)
  }

  const column = rundown.kind === 'voice' ? 'part_id' : 'camera_id'
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM shots WHERE rundown_id = ? AND ${column} IS NULL`)
    .get(rundownId) as { count: number }
  return row.count
}

/**
 * Deletes a Rundown, refusing while a Part it owns is used somewhere else.
 *
 * A Rundown-scoped Part is cascaded away with its Rundown, but a Call's
 * `part_id` is a hard foreign key with no cascade — so the delete is already
 * refused by SQLite. It just says `FOREIGN KEY constraint failed`, which tells
 * the operator nothing about which Rundown to look in or what to do. Counting
 * first turns that into the same kind of refusal deleting a Part in use gives.
 */
export function deleteRundown(db: Database.Database, id: string): void {
  const { count } = db
    .prepare(
      `SELECT COUNT(*) AS count FROM shots s
         JOIN parts p ON p.id = s.part_id
        WHERE p.rundown_id = ? AND s.rundown_id != ?`,
    )
    .get(id, id) as { count: number }

  if (count > 0) {
    const calls = count === 1 ? '1 Call' : `${count} Calls`
    throw new Error(
      `Cannot delete this Rundown: ${calls} in other Rundowns use a Part defined here. ` +
        'Promote those Parts to Project or folder scope first.',
    )
  }

  const result = db.prepare('DELETE FROM rundowns WHERE id = ?').run(id)

  if (result.changes === 0) {
    throw new Error(`Rundown not found: ${id}`)
  }
}

/**
 * Renames a folder across the Project.
 *
 * A folder is a TEXT column on both `rundowns` and `parts`, not an entity, so
 * there is no single row to rename. Both tables therefore have to move in the
 * same transaction (ADR 0006) — a partial rename would strand a folder's Parts
 * out of scope of the very Rundowns they were written for.
 *
 * Renaming onto an existing folder name merges the two, which is the expected
 * reading of a folder that is only ever a label.
 */
export function renameFolder(
  db: Database.Database,
  projectId: string,
  from: string,
  to: string,
): void {
  if (!from.trim() || !to.trim()) {
    throw new Error('Folder name must not be empty')
  }

  const renameRundowns = db.prepare(
    'UPDATE rundowns SET folder = ? WHERE project_id = ? AND folder = ?',
  )
  const renameParts = db.prepare('UPDATE parts SET folder = ? WHERE project_id = ? AND folder = ?')

  const apply = db.transaction(() => {
    renameRundowns.run(to, projectId, from)
    renameParts.run(to, projectId, from)
  })
  apply()
}
