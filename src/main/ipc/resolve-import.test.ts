import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db/index'
import { parseTimecode, parseResolveCSV, confirmResolveImport } from './resolve-import'
import { listShots } from './shots'

// ---------------------------------------------------------------------------
// parseTimecode
// ---------------------------------------------------------------------------

describe('parseTimecode', () => {
  it('parses a simple timecode at 25fps', () => {
    // 00:00:05:00 = 5 seconds = 5000ms
    expect(parseTimecode('00:00:05:00', 25)).toBe(5000)
  })

  it('converts frames to milliseconds', () => {
    // 00:00:00:25 at 25fps = 1000ms
    expect(parseTimecode('00:00:00:25', 25)).toBe(1000)
  })

  it('handles hours minutes seconds and frames', () => {
    // 01:02:03:12 at 25fps
    // = (3600 + 120 + 3) * 1000 + (12/25) * 1000
    // = 3723000 + 480 = 3723480
    expect(parseTimecode('01:02:03:12', 25)).toBe(3723480)
  })

  it('works at 30fps', () => {
    // 00:00:01:15 at 30fps = 1000 + 500 = 1500ms
    expect(parseTimecode('00:00:01:15', 30)).toBe(1500)
  })

  it('works at 24fps', () => {
    // 00:00:00:12 at 24fps = 500ms
    expect(parseTimecode('00:00:00:12', 24)).toBe(500)
  })

  it('returns 0 for 00:00:00:00', () => {
    expect(parseTimecode('00:00:00:00', 25)).toBe(0)
  })

  it('throws on malformed timecode', () => {
    expect(() => parseTimecode('invalid', 25)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// parseResolveCSV
// ---------------------------------------------------------------------------

describe('parseResolveCSV', () => {
  const csvContent = [
    'Name,Duration,Color,Notes',
    'Opening wide,00:00:05:00,Red,',
    'Interview,00:01:00:00,Blue,some note',
    'B-roll,00:00:30:00,Orange,',
  ].join('\n')

  it('extracts label from Name column', () => {
    const result = parseResolveCSV(csvContent)
    expect(result.rows[0].label).toBe('Opening wide')
  })

  it('extracts durationTimecode from Duration column', () => {
    const result = parseResolveCSV(csvContent)
    expect(result.rows[0].durationTimecode).toBe('00:00:05:00')
  })

  it('extracts resolveColor from Color column', () => {
    const result = parseResolveCSV(csvContent)
    expect(result.rows[0].resolveColor).toBe('Red')
    expect(result.rows[1].resolveColor).toBe('Blue')
  })

  it('returns unique colors found in the CSV', () => {
    const result = parseResolveCSV(csvContent)
    expect(result.colors).toContain('Red')
    expect(result.colors).toContain('Blue')
    expect(result.colors).toContain('Orange')
    expect(result.colors).toHaveLength(3)
  })

  it('parses all rows', () => {
    const result = parseResolveCSV(csvContent)
    expect(result.rows).toHaveLength(3)
  })

  it('throws on CSV missing required columns', () => {
    expect(() => parseResolveCSV('InvalidHeader\nsome,data')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// confirmResolveImport — append mode
// ---------------------------------------------------------------------------

describe('confirmResolveImport — append', () => {
  function openDb(): Database.Database {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    applyMigrations(db)
    return db
  }

  function seedDb(db: Database.Database): { rundownId: string; cameraId1: string; cameraId2: string } {
    const projectId = 'p1'
    const rundownId = 'rd-1'
    const cameraId1 = 'cam-1'
    const cameraId2 = 'cam-2'
    db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(projectId, 'P', 1000)
    db.prepare('INSERT INTO rundowns (id, project_id, name, created_at) VALUES (?, ?, ?, ?)').run(
      rundownId, projectId, 'Morning', 1000,
    )
    db.prepare('INSERT INTO cameras (id, project_id, number, name, color) VALUES (?, ?, ?, ?, ?)').run(
      cameraId1, projectId, 1, 'Wide', '#e74c3c',
    )
    db.prepare('INSERT INTO cameras (id, project_id, number, name, color) VALUES (?, ?, ?, ?, ?)').run(
      cameraId2, projectId, 2, 'Close', '#3498db',
    )
    return { rundownId, cameraId1, cameraId2 }
  }

  it('appends imported shots to an empty rundown', () => {
    const db = openDb()
    const { rundownId, cameraId1 } = seedDb(db)

    const rows = [
      { label: 'Opening', durationTimecode: '00:00:05:00', resolveColor: 'Red' },
    ]
    const mapping: Record<string, string | null> = { Red: cameraId1 }

    const shots = confirmResolveImport(db, {
      rundownId,
      mode: 'append',
      mapping,
      rows,
      fps: 25,
    })

    expect(shots).toHaveLength(1)
    expect(shots[0].label).toBe('Opening')
    expect(shots[0].cameraId).toBe(cameraId1)
    expect(shots[0].durationMs).toBe(5000)

    db.close()
  })

  it('skips rows with unmapped colors (null mapping)', () => {
    const db = openDb()
    const { rundownId, cameraId1 } = seedDb(db)

    const rows = [
      { label: 'Opening', durationTimecode: '00:00:05:00', resolveColor: 'Red' },
      { label: 'B-roll', durationTimecode: '00:00:10:00', resolveColor: 'Orange' },
    ]
    const mapping: Record<string, string | null> = { Red: cameraId1, Orange: null }

    const shots = confirmResolveImport(db, { rundownId, mode: 'append', mapping, rows, fps: 25 })

    expect(shots).toHaveLength(1)
    expect(shots[0].label).toBe('Opening')

    db.close()
  })

  it('appends after existing shots', () => {
    const db = openDb()
    const { rundownId, cameraId1, cameraId2 } = seedDb(db)

    // Pre-existing shot
    db.prepare(
      'INSERT INTO shots (id, rundown_id, camera_id, duration_ms, order_index) VALUES (?, ?, ?, ?, ?)',
    ).run('existing-1', rundownId, cameraId1, 3000, 0)

    const rows = [
      { label: 'New Shot', durationTimecode: '00:00:02:00', resolveColor: 'Blue' },
    ]
    const mapping: Record<string, string | null> = { Blue: cameraId2 }

    confirmResolveImport(db, { rundownId, mode: 'append', mapping, rows, fps: 25 })

    const all = listShots(db, rundownId)
    expect(all).toHaveLength(2)
    expect(all[0].id).toBe('existing-1')
    expect(all[1].label).toBe('New Shot')

    db.close()
  })
})

// ---------------------------------------------------------------------------
// confirmResolveImport — replace mode
// ---------------------------------------------------------------------------

describe('confirmResolveImport — replace', () => {
  function openDb(): Database.Database {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    applyMigrations(db)
    return db
  }

  it('deletes existing shots before inserting', () => {
    const db = openDb()
    const projectId = 'p1'
    const rundownId = 'rd-1'
    const cameraId = 'cam-1'
    db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(projectId, 'P', 1000)
    db.prepare('INSERT INTO rundowns (id, project_id, name, created_at) VALUES (?, ?, ?, ?)').run(
      rundownId, projectId, 'Morning', 1000,
    )
    db.prepare('INSERT INTO cameras (id, project_id, number, name, color) VALUES (?, ?, ?, ?, ?)').run(
      cameraId, projectId, 1, 'Wide', '#e74c3c',
    )
    db.prepare(
      'INSERT INTO shots (id, rundown_id, camera_id, duration_ms, order_index) VALUES (?, ?, ?, ?, ?)',
    ).run('old-shot', rundownId, cameraId, 9000, 0)

    const rows = [
      { label: 'New', durationTimecode: '00:00:01:00', resolveColor: 'Red' },
    ]

    const shots = confirmResolveImport(db, {
      rundownId,
      mode: 'replace',
      mapping: { Red: cameraId },
      rows,
      fps: 25,
    })

    expect(shots).toHaveLength(1)
    expect(shots[0].label).toBe('New')

    const allShots = listShots(db, rundownId)
    expect(allShots).toHaveLength(1)
    expect(allShots[0].label).toBe('New')

    db.close()
  })
})
