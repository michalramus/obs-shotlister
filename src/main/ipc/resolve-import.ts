/**
 * DaVinci Resolve CSV import logic.
 *
 * parseTimecode and parseResolveCSV are pure functions (unit-testable).
 * confirmResolveImport mutates the database.
 *
 * IPC registration (ipcMain.handle) happens in src/main/index.ts.
 */

import Database from 'better-sqlite3'
import { getRundown } from './rundowns'
import { createShot } from './shots'
import type { ParsedRow, ParseResult, ConfirmImportInput } from '../../shared/ipc-contract'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Timecode parsing
// ---------------------------------------------------------------------------

/**
 * Parses a timecode string HH:MM:SS:FF to milliseconds.
 * durationMs = (HH*3600 + MM*60 + SS) * 1000 + (FF / fps) * 1000
 */
export function parseTimecode(timecode: string, fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`Invalid fps: ${fps}`)
  }
  const parts = timecode.split(':')
  if (parts.length !== 4) {
    throw new Error(`Invalid timecode format: "${timecode}". Expected HH:MM:SS:FF`)
  }

  const [hh, mm, ss, ff] = parts.map((p) => {
    const n = parseInt(p, 10)
    if (isNaN(n)) throw new Error(`Invalid timecode part "${p}" in "${timecode}"`)
    return n
  })

  return (hh * 3600 + mm * 60 + ss) * 1000 + Math.round((ff / fps) * 1000)
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/**
 * Splits one CSV record into fields, honouring double-quoted fields so that a
 * marker name containing a comma does not shift every later column.
 * A doubled quote inside a quoted field is a literal quote.
 */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
    } else if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      fields.push(field)
      field = ''
    } else {
      field += char
    }
  }
  fields.push(field)
  return fields
}

/**
 * Parses a DaVinci Resolve marker CSV export.
 * Expects columns: Name, Duration, Color (case-insensitive header matching).
 */
export function parseResolveCSV(csvContent: string): ParseResult {
  const lines = csvContent.trim().split('\n')
  if (lines.length < 1) {
    throw new Error('CSV is empty')
  }

  const headers = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase())

  const nameIdx = headers.indexOf('name')
  const durationIdx = headers.indexOf('duration')
  const colorIdx = headers.indexOf('color')

  if (nameIdx === -1 || durationIdx === -1 || colorIdx === -1) {
    throw new Error(
      `CSV missing required columns. Expected: Name, Duration, Color. Got: ${lines[0]}`,
    )
  }

  const rows: ParsedRow[] = []
  const colorSet = new Set<string>()

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    const cols = splitCsvLine(line)
    const label = (cols[nameIdx] ?? '').trim()
    const durationTimecode = (cols[durationIdx] ?? '').trim()
    const resolveColor = (cols[colorIdx] ?? '').trim()

    rows.push({ label, durationTimecode, resolveColor })
    if (resolveColor) colorSet.add(resolveColor)
  }

  return { colors: Array.from(colorSet), rows }
}

// ---------------------------------------------------------------------------
// Import confirmation
// ---------------------------------------------------------------------------

export function confirmResolveImport(
  db: Database.Database,
  input: ConfirmImportInput,
): import('../../shared/types').Shot[] {
  const { rundownId, mode, mapping, rows, fps } = input

  // Resolve markers map to Cameras by their colour, and a Call has no Camera to
  // map to — these Rundowns are not authored in Resolve at all. Refused rather
  // than silently importing items no Live session would agree to start on.
  const rundown = getRundown(db, rundownId)
  if (rundown?.kind === 'voice') {
    throw new Error('Cannot import a Resolve CSV into a Voice-over Rundown')
  }

  // All-or-nothing: a bad timecode partway through must not leave the rundown
  // holding half an import.
  const run = db.transaction((): import('../../shared/types').Shot[] => {
    if (mode === 'replace') {
      db.prepare('DELETE FROM shots WHERE rundown_id = ?').run(rundownId)
    }

    const imported: import('../../shared/types').Shot[] = []

    for (const row of rows) {
      const cameraId = mapping[row.resolveColor]
      if (!cameraId) continue // unmapped — skip

      const durationMs = parseTimecode(row.durationTimecode, fps)

      const shot = createShot(db, {
        rundownId,
        cameraId,
        durationMs,
        label: row.label || null,
      })

      imported.push(shot)
    }

    return imported
  })

  return run()
}
