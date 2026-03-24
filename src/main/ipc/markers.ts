import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type { Marker } from '../../shared/types'

interface MarkerRow {
  id: string
  rundown_id: string
  position_ms: number
  label: string | null
}

function rowToMarker(row: MarkerRow): Marker {
  return {
    id: row.id,
    rundownId: row.rundown_id,
    positionMs: row.position_ms,
    label: row.label,
  }
}

export function listMarkers(db: Database.Database, rundownId: string): Marker[] {
  const rows = db
    .prepare(
      'SELECT id, rundown_id, position_ms, label FROM markers WHERE rundown_id = ? ORDER BY position_ms ASC',
    )
    .all(rundownId) as MarkerRow[]
  return rows.map(rowToMarker)
}

export interface UpsertMarkerInput {
  id?: string
  rundownId: string
  positionMs: number
  label?: string | null
}

export function upsertMarker(db: Database.Database, input: UpsertMarkerInput): Marker {
  const id = input.id ?? randomUUID()
  db.prepare(
    'INSERT INTO markers (id, rundown_id, position_ms, label) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET position_ms = excluded.position_ms, label = excluded.label',
  ).run(id, input.rundownId, input.positionMs, input.label ?? null)
  const row = db
    .prepare('SELECT id, rundown_id, position_ms, label FROM markers WHERE id = ?')
    .get(id) as MarkerRow
  return rowToMarker(row)
}

export function deleteMarker(db: Database.Database, id: string): void {
  const result = db.prepare('DELETE FROM markers WHERE id = ?').run(id)
  if (result.changes === 0) throw new Error(`Marker not found: ${id}`)
}
