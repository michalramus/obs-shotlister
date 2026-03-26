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
import type { Rundown } from '../../shared/types'

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
  }
}

// ---------------------------------------------------------------------------
// Rundowns
// ---------------------------------------------------------------------------

export function getRundown(db: Database.Database, id: string): Rundown | null {
  const row = db
    .prepare('SELECT id, project_id, name, created_at, order_index, folder FROM rundowns WHERE id = ?')
    .get(id) as RundownRow | undefined
  return row ? rowToRundown(row) : null
}

export function listRundowns(db: Database.Database, projectId: string): Rundown[] {
  const rows = db
    .prepare(
      'SELECT id, project_id, name, created_at, order_index, folder FROM rundowns WHERE project_id = ? ORDER BY order_index ASC, created_at ASC',
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
    .prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS next_index FROM rundowns WHERE project_id = ?')
    .get(projectId) as { next_index: number }
  const orderIndex = orderIndexRow.next_index

  // Foreign key enforcement will throw if projectId is invalid
  db.prepare('INSERT INTO rundowns (id, project_id, name, created_at, order_index) VALUES (?, ?, ?, ?, ?)').run(
    id,
    projectId,
    name,
    createdAt,
    orderIndex,
  )

  return { id, projectId, name, createdAt, orderIndex, folder: null }
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

export function setRundownFolder(db: Database.Database, id: string, folder: string | null): Rundown {
  const result = db.prepare('UPDATE rundowns SET folder = ? WHERE id = ?').run(folder, id)

  if (result.changes === 0) {
    throw new Error(`Rundown not found: ${id}`)
  }

  const row = db
    .prepare('SELECT id, project_id, name, created_at, order_index, folder FROM rundowns WHERE id = ?')
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
    .prepare('SELECT id, project_id, name, created_at, order_index, folder FROM rundowns WHERE id = ?')
    .get(id) as RundownRow
  return rowToRundown(row)
}

export function deleteRundown(db: Database.Database, id: string): void {
  const result = db.prepare('DELETE FROM rundowns WHERE id = ?').run(id)

  if (result.changes === 0) {
    throw new Error(`Rundown not found: ${id}`)
  }
}
