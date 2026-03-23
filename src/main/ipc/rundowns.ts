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
  }
}

// ---------------------------------------------------------------------------
// Rundowns
// ---------------------------------------------------------------------------

export function getRundown(db: Database.Database, id: string): Rundown | null {
  const row = db
    .prepare('SELECT id, project_id, name, created_at FROM rundowns WHERE id = ?')
    .get(id) as RundownRow | undefined
  return row ? rowToRundown(row) : null
}

export function listRundowns(db: Database.Database, projectId: string): Rundown[] {
  const rows = db
    .prepare(
      'SELECT id, project_id, name, created_at FROM rundowns WHERE project_id = ? ORDER BY created_at ASC',
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

  // Foreign key enforcement will throw if projectId is invalid
  db.prepare('INSERT INTO rundowns (id, project_id, name, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    projectId,
    name,
    createdAt,
  )

  return { id, projectId, name, createdAt }
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
    .prepare('SELECT id, project_id, name, created_at FROM rundowns WHERE id = ?')
    .get(id) as RundownRow
  return rowToRundown(row)
}

export function deleteRundown(db: Database.Database, id: string): void {
  const result = db.prepare('DELETE FROM rundowns WHERE id = ?').run(id)

  if (result.changes === 0) {
    throw new Error(`Rundown not found: ${id}`)
  }
}
