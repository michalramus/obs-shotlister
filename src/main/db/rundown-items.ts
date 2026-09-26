/**
 * The `shots` table, owned in one place.
 *
 * A row here is a Rundown item: a Shot in a Camera Rundown, a Call in a
 * Voice-over one. Its nine columns used to be spelled out by every reader and
 * every writer — the IPC handlers, both import paths, the exporter — and each
 * added column then had to be remembered independently. It never was: `part_id`
 * missed update and split (16a9674), and Kind, Parts, Calls and Lyrics missed
 * export and import (34fc215). Both were the same bug twice.
 *
 * So the column list, the row mapper, the absent-vs-null patch rule and the
 * Kind-to-column rule live here, and callers pass fields rather than SQL. A new
 * column is added to {@link RundownItemRow} and {@link COLUMN_FOR}, and the
 * compiler then points at everything that has to carry it.
 *
 * Takes a Database instance like the rest of `src/main/db`, so it is testable
 * against `:memory:` with no Electron context.
 */

import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type { RundownKind, Shot } from '../../shared/types'
import type { DeleteShotMode } from '../../shared/ipc-contract'
import { targetFieldOf } from '../../shared/rundown-item'

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

/** One `shots` row exactly as better-sqlite3 hands it back. */
export interface RundownItemRow {
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

/**
 * An item row as it comes back from an export file: the same columns, but
 * nothing is guaranteed to be there. Import reads rows through this so a file
 * written by an older version is missing fields rather than shape.
 */
export type ImportedItemRow = Partial<RundownItemRow>

/**
 * Column for each field of a stored item — the one place the two spellings meet.
 *
 * `satisfies` is what makes this load-bearing: adding a field to {@link Shot}
 * without a column here fails to compile, which is the check that was missing
 * when a column reached one writer and not the others.
 *
 * `hidden` is excluded because it is a Live queue flag and never a stored fact.
 */
const COLUMN_FOR = {
  id: 'id',
  rundownId: 'rundown_id',
  cameraId: 'camera_id',
  partId: 'part_id',
  durationMs: 'duration_ms',
  label: 'label',
  orderIndex: 'order_index',
  transitionName: 'transition_name',
  transitionMs: 'transition_ms',
} as const satisfies Record<Exclude<keyof Shot, 'hidden'>, keyof RundownItemRow>

/** Columns in a fixed order, so the SELECT list and the INSERT binds agree. */
const COLUMNS = Object.values(COLUMN_FOR)
const COLUMN_LIST = COLUMNS.join(', ')

/** Everything an edit may change: not the identity, not the position. */
const MUTABLE_COLUMNS = [
  'camera_id',
  'part_id',
  'duration_ms',
  'label',
  'transition_name',
  'transition_ms',
] as const satisfies readonly (keyof RundownItemRow)[]

const SELECT_BY_RUNDOWN = `SELECT ${COLUMN_LIST} FROM shots WHERE rundown_id = ? ORDER BY order_index ASC`
const SELECT_BY_ID = `SELECT ${COLUMN_LIST} FROM shots WHERE id = ?`
const SELECT_ALL = `SELECT ${COLUMN_LIST} FROM shots ORDER BY order_index ASC`
const INSERT_SQL = `INSERT INTO shots (${COLUMN_LIST}) VALUES (${COLUMNS.map(() => '?').join(', ')})`
const UPDATE_SQL = `UPDATE shots SET ${MUTABLE_COLUMNS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`

function bind(row: RundownItemRow): (string | number | null)[] {
  return COLUMNS.map((column) => row[column])
}

export function rowToItem(row: RundownItemRow): Shot {
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
// The Kind-to-column rule
// ---------------------------------------------------------------------------

/**
 * The column a Rundown of this Kind assigns through.
 *
 * Derived from the one Kind decision in `src/shared/rundown-item.ts` rather
 * than a second copy of it: the views ask the same question of a `Shot` object
 * and must never answer it differently from a query.
 */
export function targetColumnOf(kind: RundownKind): 'camera_id' | 'part_id' {
  return COLUMN_FOR[targetFieldOf(kind)]
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function listItems(db: Database.Database, rundownId: string): Shot[] {
  const rows = db.prepare(SELECT_BY_RUNDOWN).all(rundownId) as RundownItemRow[]
  return rows.map(rowToItem)
}

export function getItem(db: Database.Database, id: string): Shot | undefined {
  const row = getItemRow(db, id)
  return row ? rowToItem(row) : undefined
}

export function getItemRow(db: Database.Database, id: string): RundownItemRow | undefined {
  return db.prepare(SELECT_BY_ID).get(id) as RundownItemRow | undefined
}

/**
 * Raw rows for one Rundown, and every row in the table.
 *
 * Export writes the database's own spelling, so it wants rows and not `Shot`s.
 * It used to get them from `SELECT *` cast to `any`, which carried whatever the
 * schema happened to hold — including, for a while, nothing new at all.
 */
export function listItemRows(db: Database.Database, rundownId: string): RundownItemRow[] {
  return db.prepare(SELECT_BY_RUNDOWN).all(rundownId) as RundownItemRow[]
}

export function allItemRows(db: Database.Database): RundownItemRow[] {
  return db.prepare(SELECT_ALL).all() as RundownItemRow[]
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * A new item. Only the Rundown and the duration are required: an id and a
 * position are minted when the caller has none, which is what a fresh item
 * wants and an import already knows.
 */
export interface NewRundownItem {
  id?: string
  rundownId: string
  cameraId?: string | null
  partId?: string | null
  durationMs: number
  label?: string | null
  orderIndex?: number
  transitionName?: string | null
  transitionMs?: number
}

export function insertItem(db: Database.Database, fields: NewRundownItem): Shot {
  const row: RundownItemRow = {
    id: fields.id ?? randomUUID(),
    rundown_id: fields.rundownId,
    camera_id: fields.cameraId ?? null,
    part_id: fields.partId ?? null,
    duration_ms: fields.durationMs,
    label: fields.label ?? null,
    order_index: fields.orderIndex ?? nextOrderIndex(db, fields.rundownId),
    transition_name: fields.transitionName ?? null,
    transition_ms: fields.transitionMs ?? 0,
  }
  db.prepare(INSERT_SQL).run(...bind(row))
  return rowToItem(row)
}

/** Where an item appended to this Rundown lands. */
export function nextOrderIndex(db: Database.Database, rundownId: string): number {
  const { max_idx } = db
    .prepare('SELECT COALESCE(MAX(order_index), -1) AS max_idx FROM shots WHERE rundown_id = ?')
    .get(rundownId) as { max_idx: number }
  return max_idx + 1
}

/**
 * An edit to an existing item. Identity and position are not editable here —
 * position moves through {@link reorderItems}.
 */
export interface RundownItemPatch {
  cameraId?: string | null
  partId?: string | null
  durationMs?: number
  label?: string | null
  transitionName?: string | null
  transitionMs?: number
}

/**
 * Applies a patch, resolving absent against explicitly null.
 *
 * Absent keeps the current value; an explicit null clears it. `??` collapsed
 * the two, so a caller written against the nullable contract could never
 * unassign an item (888272f).
 *
 * Assigning a Part never clears the Camera, and vice versa: both targets are
 * retained so converting a Rundown away from its Kind and back is exact.
 */
export function updateItem(db: Database.Database, id: string, patch: RundownItemPatch): Shot {
  const existing = getItemRow(db, id)
  if (!existing) throw new Error(`Shot not found: ${id}`)

  const row: RundownItemRow = {
    ...existing,
    camera_id: nullable(patch, 'cameraId', existing.camera_id),
    part_id: nullable(patch, 'partId', existing.part_id),
    label: nullable(patch, 'label', existing.label),
    transition_name: nullable(patch, 'transitionName', existing.transition_name),
    // Never null in the schema, so absent and null mean the same thing here.
    duration_ms: patch.durationMs ?? existing.duration_ms,
    transition_ms: patch.transitionMs ?? existing.transition_ms,
  }

  db.prepare(UPDATE_SQL).run(...MUTABLE_COLUMNS.map((column) => row[column]), id)
  return rowToItem(row)
}

/**
 * One nullable field's new value: mentioned means set (null clears), unmentioned
 * means leave it alone.
 */
function nullable<K extends 'cameraId' | 'partId' | 'label' | 'transitionName'>(
  patch: RundownItemPatch,
  key: K,
  current: string | null,
): string | null {
  return key in patch ? (patch[key] ?? null) : current
}

/**
 * Removes an item, either closing the gap it leaves or letting a neighbour
 * absorb its time.
 *
 * `ripple` shortens the Rundown; `extend` keeps its total length, which is what
 * editing against Reference media needs.
 */
export function deleteItem(
  db: Database.Database,
  id: string,
  mode: DeleteShotMode = 'extend',
): void {
  const existing = getItemRow(db, id)
  if (!existing) throw new Error(`Shot not found: ${id}`)

  if (mode === 'ripple') {
    db.prepare('DELETE FROM shots WHERE id = ?').run(id)
    return
  }

  // Prefer the item to the left; deleting the first has none, so the item to
  // the right absorbs the time instead and the timeline still starts at 0.
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

  db.transaction(() => {
    if (neighbour) {
      db.prepare('UPDATE shots SET duration_ms = duration_ms + ? WHERE id = ?').run(
        existing.duration_ms,
        neighbour.id,
      )
    }
    db.prepare('DELETE FROM shots WHERE id = ?').run(id)
  })()
}

/** Renumbers items to the given order, which is the order the operator sees. */
export function reorderItems(db: Database.Database, ids: string[]): void {
  const update = db.prepare('UPDATE shots SET order_index = ? WHERE id = ?')
  db.transaction(() => {
    ids.forEach((id, index) => {
      update.run(index, id)
    })
  })()
}

/** Opens a slot directly after `orderIndex` by pushing everything after it up. */
export function shiftOrderAfter(
  db: Database.Database,
  rundownId: string,
  orderIndex: number,
): void {
  db.prepare(
    'UPDATE shots SET order_index = order_index + 1 WHERE rundown_id = ? AND order_index > ?',
  ).run(rundownId, orderIndex)
}
