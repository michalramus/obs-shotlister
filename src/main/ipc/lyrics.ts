/**
 * IPC handler logic for the Lyrics Track.
 *
 * A Lyric is an orientation aid only: never spoken, never sent to the Phone
 * view or the Cue Tray. Lines on one Rundown must be disjoint, so the lane
 * stays readable.
 *
 * Each function accepts a Database instance so it can be tested with an
 * in-memory database without requiring an Electron context.
 *
 * IPC registration (ipcMain.handle) happens in src/main/index.ts.
 */

import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type { Lyric } from '../../shared/types'
import type { LyricUpsertInput } from '../../shared/ipc-contract'

// ---------------------------------------------------------------------------
// Row shapes returned from better-sqlite3
// ---------------------------------------------------------------------------

interface LyricRow {
  id: string
  rundown_id: string
  start_ms: number
  end_ms: number
  text: string
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function rowToLyric(row: LyricRow): Lyric {
  return {
    id: row.id,
    rundownId: row.rundown_id,
    startMs: row.start_ms,
    endMs: row.end_ms,
    text: row.text,
  }
}

// ---------------------------------------------------------------------------
// Lyrics
// ---------------------------------------------------------------------------

export function listLyrics(db: Database.Database, rundownId: string): Lyric[] {
  const rows = db
    .prepare(
      'SELECT id, rundown_id, start_ms, end_ms, text FROM lyrics WHERE rundown_id = ? ORDER BY start_ms ASC',
    )
    .all(rundownId) as LyricRow[]
  return rows.map(rowToLyric)
}

export function upsertLyric(db: Database.Database, input: LyricUpsertInput): Lyric {
  if (input.endMs <= input.startMs) {
    throw new Error('Lyric must end after it starts')
  }
  if (!input.text.trim()) {
    throw new Error('Lyric text must not be empty')
  }

  const id = input.id ?? randomUUID()

  // Ranges are half-open [startMs, endMs), so a line ending exactly where the
  // next begins is legal — that is the normal shape of consecutive sung lines.
  // On an update the row being written is excluded, or it would overlap itself.
  const clash = db
    .prepare(
      'SELECT id FROM lyrics WHERE rundown_id = ? AND id != ? AND start_ms < ? AND end_ms > ? LIMIT 1',
    )
    .get(input.rundownId, id, input.endMs, input.startMs) as { id: string } | undefined
  if (clash) {
    throw new Error(`Lyric overlaps an existing line: ${clash.id}`)
  }

  db.prepare(
    'INSERT INTO lyrics (id, rundown_id, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET rundown_id = excluded.rundown_id, start_ms = excluded.start_ms, end_ms = excluded.end_ms, text = excluded.text',
  ).run(id, input.rundownId, input.startMs, input.endMs, input.text)

  const row = db
    .prepare('SELECT id, rundown_id, start_ms, end_ms, text FROM lyrics WHERE id = ?')
    .get(id) as LyricRow
  return rowToLyric(row)
}

export function deleteLyric(db: Database.Database, id: string): void {
  const result = db.prepare('DELETE FROM lyrics WHERE id = ?').run(id)

  if (result.changes === 0) {
    throw new Error(`Lyric not found: ${id}`)
  }
}
