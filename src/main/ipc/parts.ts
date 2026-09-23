/**
 * IPC handler logic for Part CRUD, scoping and colour operations.
 *
 * Each function accepts a Database instance so it can be tested with an
 * in-memory database without requiring an Electron context.
 *
 * IPC registration (ipcMain.handle) happens in src/main/index.ts.
 */

import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type { Part } from '../../shared/types'
import type { PartScope, PartUpsertInput } from '../../shared/ipc-contract'
import { nextCameraColor } from '../../shared/camera-palette'

// ---------------------------------------------------------------------------
// Row shapes returned from better-sqlite3
// ---------------------------------------------------------------------------

interface PartRow {
  id: string
  project_id: string
  number: number
  name: string
  color: string
  folder: string | null
  rundown_id: string | null
}

const PART_COLUMNS = 'id, project_id, number, name, color, folder, rundown_id'

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function rowToPart(row: PartRow): Part {
  return {
    id: row.id,
    projectId: row.project_id,
    number: row.number,
    name: row.name,
    color: row.color,
    folder: row.folder ?? null,
    rundownId: row.rundown_id ?? null,
  }
}

/**
 * The `folder` / `rundown_id` pair a scope stores.
 *
 * Scope lives in two nullable columns rather than a discriminator, because a
 * folder is a TEXT column on `rundowns` and not an entity (ADR 0006) — there is
 * nothing to point a foreign key at.
 */
function scopeToColumns(scope: PartScope): { folder: string | null; rundownId: string | null } {
  switch (scope.kind) {
    case 'project':
      return { folder: null, rundownId: null }
    case 'folder':
      return { folder: scope.folder, rundownId: null }
    case 'rundown':
      return { folder: null, rundownId: scope.rundownId }
  }
}

function getPartRow(db: Database.Database, id: string): PartRow | undefined {
  return db.prepare(`SELECT ${PART_COLUMNS} FROM parts WHERE id = ?`).get(id) as PartRow | undefined
}

/**
 * The lowest number not yet taken in the Project, starting at 1.
 *
 * `number` is unique per Project and not per scope, so this has to consider
 * every Part the Project owns: a Rundown-scoped Part still consumes a number,
 * because promoting it later must not have to renumber it.
 */
function lowestFreeNumber(db: Database.Database, projectId: string): number {
  const rows = db
    .prepare('SELECT number FROM parts WHERE project_id = ? ORDER BY number ASC')
    .all(projectId) as { number: number }[]

  let candidate = 1
  for (const row of rows) {
    if (row.number > candidate) break
    if (row.number === candidate) candidate++
  }
  return candidate
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

export function listParts(db: Database.Database, projectId: string): Part[] {
  const rows = db
    .prepare(`SELECT ${PART_COLUMNS} FROM parts WHERE project_id = ? ORDER BY number ASC`)
    .all(projectId) as PartRow[]
  return rows.map(rowToPart)
}

export function getPart(db: Database.Database, id: string): Part | null {
  const row = getPartRow(db, id)
  return row ? rowToPart(row) : null
}

/**
 * Every Part a Rundown may choose from: the additive union of Project scope,
 * its folder's scope and its own (ADR 0006).
 *
 * A narrower scope only ever adds. Nothing here can hide or redefine a broader
 * Part, which is what keeps a Part name meaning one thing — and therefore one
 * cached clip — wherever it is looked at.
 *
 * This governs the picker only. A Call's `part_id` is a hard foreign key, so a
 * Rundown moving between folders never breaks an existing Call; the Part simply
 * stops being offered for new ones.
 */
export function listPartsInScope(db: Database.Database, rundownId: string): Part[] {
  const rundown = db.prepare('SELECT project_id, folder FROM rundowns WHERE id = ?').get(rundownId) as
    | { project_id: string; folder: string | null }
    | undefined

  if (!rundown) {
    throw new Error(`Rundown not found: ${rundownId}`)
  }

  // `folder = ?` is never true when the Rundown's folder is NULL, so a foldered
  // Rundown and a loose one fall out of the same statement.
  const rows = db
    .prepare(
      `SELECT ${PART_COLUMNS} FROM parts
       WHERE project_id = ?
         AND (
           (folder IS NULL AND rundown_id IS NULL)
           OR (rundown_id IS NULL AND folder = ?)
           OR rundown_id = ?
         )
       ORDER BY number ASC`,
    )
    .all(rundown.project_id, rundown.folder, rundownId) as PartRow[]
  return rows.map(rowToPart)
}

/**
 * Creates a Part when `id` is absent and updates one when it is present.
 *
 * Omitted `number` and `color` are only filled in on create; on update they
 * keep whatever the Part already had, so a rename never disturbs its identity
 * on the timeline.
 *
 * A rename deliberately leaves `part_renders` alone. That row is what lets the
 * render state tell *stale* (a clip exists, for the old name) from *missing* (a
 * Part never rendered at all) — deleting it here would turn every rename into a
 * Part that looks like it was never rendered.
 */
export function upsertPart(db: Database.Database, input: PartUpsertInput): Part {
  const name = input.name.trim()
  if (!name) {
    throw new Error('Part name must not be empty')
  }

  if (input.id) {
    const existing = getPartRow(db, input.id)
    if (!existing) {
      throw new Error(`Part not found: ${input.id}`)
    }

    const scope = input.scope ? scopeToColumns(input.scope) : { folder: existing.folder, rundownId: existing.rundown_id }

    db.prepare(
      'UPDATE parts SET project_id = ?, number = ?, name = ?, color = ?, folder = ?, rundown_id = ? WHERE id = ?',
    ).run(
      input.projectId,
      input.number ?? existing.number,
      name,
      input.color ?? existing.color,
      scope.folder,
      scope.rundownId,
      input.id,
    )

    return rowToPart(getPartRow(db, input.id) as PartRow)
  }

  const id = randomUUID()
  const number = input.number ?? lowestFreeNumber(db, input.projectId)
  // Parts are read at a glance on the timeline exactly as Cameras are, so they
  // draw from the same palette and by the same "first colour still free" rule.
  const color = input.color ?? nextCameraColor(listParts(db, input.projectId))
  const scope = scopeToColumns(input.scope ?? { kind: 'project' })

  // Foreign key enforcement will throw if projectId or rundownId is invalid
  db.prepare(
    'INSERT INTO parts (id, project_id, number, name, color, folder, rundown_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, input.projectId, number, name, color, scope.folder, scope.rundownId)

  return {
    id,
    projectId: input.projectId,
    number,
    name,
    color,
    folder: scope.folder,
    rundownId: scope.rundownId,
  }
}

/**
 * Deletes a Part, refusing while any Call still references it.
 *
 * The refusal carries the count because the alternative — a cascade — would
 * silently gut a Rundown the operator cannot see from the Parts panel. This
 * matches how deleting a Camera behaves.
 */
export function deletePart(db: Database.Database, id: string): void {
  const existing = getPartRow(db, id)
  if (!existing) {
    throw new Error(`Part not found: ${id}`)
  }

  const { count } = db.prepare('SELECT COUNT(*) AS count FROM shots WHERE part_id = ?').get(id) as {
    count: number
  }

  if (count > 0) {
    const calls = count === 1 ? '1 Call references it' : `${count} Calls reference it`
    throw new Error(`Cannot delete Part "${existing.name}": ${calls}`)
  }

  db.prepare('DELETE FROM parts WHERE id = ?').run(id)
}

/**
 * Moves a Part to another scope, keeping its id.
 *
 * Keeping the id is the whole point: every Call already pointing at the Part
 * survives promotion untouched, and because the Announcement cache is keyed on
 * the Part's text rather than its scope, no audio has to be re-rendered.
 */
export function promotePart(db: Database.Database, id: string, scope: PartScope): Part {
  const columns = scopeToColumns(scope)
  const result = db
    .prepare('UPDATE parts SET folder = ?, rundown_id = ? WHERE id = ?')
    .run(columns.folder, columns.rundownId, id)

  if (result.changes === 0) {
    throw new Error(`Part not found: ${id}`)
  }

  return rowToPart(getPartRow(db, id) as PartRow)
}

/**
 * Sets one colour on several Parts at once.
 *
 * Grouping Parts by colour — all the zwrotkas green — is a convention the
 * operator applies, not a model: there is no Group entity, only this bulk
 * write. It runs in one transaction so a bad id cannot leave half a "group"
 * recoloured.
 */
export function setPartsColor(db: Database.Database, ids: string[], color: string): Part[] {
  if (!color.trim()) {
    throw new Error('Part color must not be empty')
  }

  const update = db.prepare('UPDATE parts SET color = ? WHERE id = ?')
  const apply = db.transaction(() => {
    for (const id of ids) {
      const result = update.run(color, id)
      if (result.changes === 0) {
        throw new Error(`Part not found: ${id}`)
      }
    }
  })
  apply()

  return ids
    .map((id) => rowToPart(getPartRow(db, id) as PartRow))
    .sort((a, b) => a.number - b.number)
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
export function renameFolder(db: Database.Database, projectId: string, from: string, to: string): void {
  if (!from.trim() || !to.trim()) {
    throw new Error('Folder name must not be empty')
  }

  const renameRundowns = db.prepare('UPDATE rundowns SET folder = ? WHERE project_id = ? AND folder = ?')
  const renameParts = db.prepare('UPDATE parts SET folder = ? WHERE project_id = ? AND folder = ?')

  const apply = db.transaction(() => {
    renameRundowns.run(to, projectId, from)
    renameParts.run(to, projectId, from)
  })
  apply()
}
