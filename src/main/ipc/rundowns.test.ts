import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db/index'
import { listRundowns, createRundown, renameRundown, deleteRundown } from './rundowns'
import type { Rundown } from '../../shared/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openMemoryDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  return db
}

function insertProject(db: Database.Database, id: string, name: string): void {
  db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(id, name, Date.now())
}

function insertRundown(db: Database.Database, id: string, projectId: string, name: string, createdAt = 1000): void {
  db.prepare('INSERT INTO rundowns (id, project_id, name, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    projectId,
    name,
    createdAt,
  )
}

// ---------------------------------------------------------------------------
// listRundowns
// ---------------------------------------------------------------------------

describe('listRundowns', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1', 'Project A')
    insertProject(db, 'p2', 'Project B')
  })

  afterEach(() => {
    db.close()
  })

  it('returns empty array when project has no rundowns', () => {
    expect(listRundowns(db, 'p1')).toEqual([])
  })

  it('returns rundowns for the specified project only', () => {
    insertRundown(db, 'rd-1', 'p1', 'Morning', 1000)
    insertRundown(db, 'rd-2', 'p2', 'Other', 2000)
    const result = listRundowns(db, 'p1')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('rd-1')
  })

  it('returns rundowns ordered by createdAt ascending', () => {
    insertRundown(db, 'rd-2', 'p1', 'Evening', 2000)
    insertRundown(db, 'rd-1', 'p1', 'Morning', 1000)
    const result = listRundowns(db, 'p1')
    expect(result[0].id).toBe('rd-1')
    expect(result[1].id).toBe('rd-2')
  })

  it('returns rundowns with correct shape', () => {
    insertRundown(db, 'rd-1', 'p1', 'Morning', 9999)
    const result = listRundowns(db, 'p1')
    const rd = result[0] as Rundown
    expect(rd.id).toBe('rd-1')
    expect(rd.projectId).toBe('p1')
    expect(rd.name).toBe('Morning')
    expect(rd.createdAt).toBe(9999)
  })
})

// ---------------------------------------------------------------------------
// createRundown
// ---------------------------------------------------------------------------

describe('createRundown', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1', 'Project A')
  })

  afterEach(() => {
    db.close()
  })

  it('creates and returns a rundown with a generated id', () => {
    const rd = createRundown(db, 'p1', 'Morning')
    expect(rd.id).toBeTypeOf('string')
    expect(rd.id.length).toBeGreaterThan(0)
    expect(rd.name).toBe('Morning')
    expect(rd.projectId).toBe('p1')
    expect(rd.createdAt).toBeTypeOf('number')
  })

  it('persists the rundown so it appears in listRundowns', () => {
    createRundown(db, 'p1', 'Morning')
    expect(listRundowns(db, 'p1')).toHaveLength(1)
  })

  it('generates unique ids for multiple rundowns', () => {
    const a = createRundown(db, 'p1', 'Morning')
    const b = createRundown(db, 'p1', 'Evening')
    expect(a.id).not.toBe(b.id)
  })

  it('throws if name is empty', () => {
    expect(() => createRundown(db, 'p1', '')).toThrow()
  })

  it('throws if projectId does not exist', () => {
    expect(() => createRundown(db, 'nonexistent', 'Morning')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// renameRundown
// ---------------------------------------------------------------------------

describe('renameRundown', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1', 'Project A')
    insertRundown(db, 'rd-1', 'p1', 'Original')
  })

  afterEach(() => {
    db.close()
  })

  it('renames and returns the updated rundown', () => {
    const updated = renameRundown(db, 'rd-1', 'Renamed')
    expect(updated.id).toBe('rd-1')
    expect(updated.name).toBe('Renamed')
  })

  it('persists the rename', () => {
    renameRundown(db, 'rd-1', 'Persisted')
    expect(listRundowns(db, 'p1')[0].name).toBe('Persisted')
  })

  it('throws if rundown does not exist', () => {
    expect(() => renameRundown(db, 'nonexistent', 'X')).toThrow()
  })

  it('throws if name is empty', () => {
    expect(() => renameRundown(db, 'rd-1', '')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// deleteRundown
// ---------------------------------------------------------------------------

describe('deleteRundown', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1', 'Project A')
    insertRundown(db, 'rd-1', 'p1', 'Morning', 1000)
    insertRundown(db, 'rd-2', 'p1', 'Evening', 2000)
  })

  afterEach(() => {
    db.close()
  })

  it('removes the rundown from the database', () => {
    deleteRundown(db, 'rd-1')
    const all = listRundowns(db, 'p1')
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe('rd-2')
  })

  it('throws if rundown does not exist', () => {
    expect(() => deleteRundown(db, 'nonexistent')).toThrow()
  })

  it('cascades deletion to shots', () => {
    db.prepare('INSERT INTO cameras (id, project_id, number, name, color) VALUES (?, ?, ?, ?, ?)').run(
      'cam-1',
      'p1',
      1,
      'Wide',
      '#e74c3c',
    )
    db.prepare(
      'INSERT INTO shots (id, rundown_id, camera_id, duration_ms, order_index) VALUES (?, ?, ?, ?, ?)',
    ).run('shot-1', 'rd-1', 'cam-1', 5000, 0)
    deleteRundown(db, 'rd-1')
    const shot = db.prepare('SELECT id FROM shots WHERE id = ?').get('shot-1')
    expect(shot).toBeUndefined()
  })
})
