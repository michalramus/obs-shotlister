import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db/index'
import { listShots, createShot, updateShot, deleteShot, reorderShots } from './shots'
import type { Shot } from '../../shared/types'

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

function seed(db: Database.Database): { projectId: string; rundownId: string; cameraId: string } {
  const projectId = 'p1'
  const rundownId = 'rd-1'
  const cameraId = 'cam-1'
  db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(projectId, 'Proj', 1000)
  db.prepare('INSERT INTO rundowns (id, project_id, name, created_at) VALUES (?, ?, ?, ?)').run(
    rundownId,
    projectId,
    'Morning',
    1000,
  )
  db.prepare('INSERT INTO cameras (id, project_id, number, name, color) VALUES (?, ?, ?, ?, ?)').run(
    cameraId,
    projectId,
    1,
    'Wide',
    '#e74c3c',
  )
  return { projectId, rundownId, cameraId }
}

// ---------------------------------------------------------------------------
// listShots
// ---------------------------------------------------------------------------

describe('listShots', () => {
  let db: Database.Database
  let ids: { projectId: string; rundownId: string; cameraId: string }

  beforeEach(() => {
    db = openMemoryDb()
    ids = seed(db)
  })

  afterEach(() => {
    db.close()
  })

  it('returns empty array when rundown has no shots', () => {
    expect(listShots(db, ids.rundownId)).toEqual([])
  })

  it('returns shots ordered by order_index ascending', () => {
    db.prepare(
      'INSERT INTO shots (id, rundown_id, camera_id, duration_ms, order_index) VALUES (?, ?, ?, ?, ?)',
    ).run('s2', ids.rundownId, ids.cameraId, 1000, 2)
    db.prepare(
      'INSERT INTO shots (id, rundown_id, camera_id, duration_ms, order_index) VALUES (?, ?, ?, ?, ?)',
    ).run('s1', ids.rundownId, ids.cameraId, 2000, 1)
    const result = listShots(db, ids.rundownId)
    expect(result[0].id).toBe('s1')
    expect(result[1].id).toBe('s2')
  })

  it('returns shots with correct shape', () => {
    db.prepare(
      'INSERT INTO shots (id, rundown_id, camera_id, duration_ms, label, order_index) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('s1', ids.rundownId, ids.cameraId, 5000, 'Opening', 0)
    const result = listShots(db, ids.rundownId)
    const s = result[0] as Shot
    expect(s.id).toBe('s1')
    expect(s.rundownId).toBe(ids.rundownId)
    expect(s.cameraId).toBe(ids.cameraId)
    expect(s.durationMs).toBe(5000)
    expect(s.label).toBe('Opening')
    expect(s.orderIndex).toBe(0)
  })

  it('maps null label to null', () => {
    db.prepare(
      'INSERT INTO shots (id, rundown_id, camera_id, duration_ms, order_index) VALUES (?, ?, ?, ?, ?)',
    ).run('s1', ids.rundownId, ids.cameraId, 5000, 0)
    const result = listShots(db, ids.rundownId)
    expect(result[0].label).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// createShot
// ---------------------------------------------------------------------------

describe('createShot', () => {
  let db: Database.Database
  let ids: { projectId: string; rundownId: string; cameraId: string }

  beforeEach(() => {
    db = openMemoryDb()
    ids = seed(db)
  })

  afterEach(() => {
    db.close()
  })

  it('creates a shot with generated id and correct fields', () => {
    const shot = createShot(db, {
      rundownId: ids.rundownId,
      cameraId: ids.cameraId,
      durationMs: 5000,
      label: 'Opening',
    })
    expect(shot.id).toBeTypeOf('string')
    expect(shot.id.length).toBeGreaterThan(0)
    expect(shot.rundownId).toBe(ids.rundownId)
    expect(shot.cameraId).toBe(ids.cameraId)
    expect(shot.durationMs).toBe(5000)
    expect(shot.label).toBe('Opening')
    expect(shot.orderIndex).toBe(0)
  })

  it('creates a shot without label (null)', () => {
    const shot = createShot(db, {
      rundownId: ids.rundownId,
      cameraId: ids.cameraId,
      durationMs: 3000,
    })
    expect(shot.label).toBeNull()
  })

  it('assigns orderIndex = max existing + 1', () => {
    const s1 = createShot(db, { rundownId: ids.rundownId, cameraId: ids.cameraId, durationMs: 1000 })
    const s2 = createShot(db, { rundownId: ids.rundownId, cameraId: ids.cameraId, durationMs: 2000 })
    expect(s1.orderIndex).toBe(0)
    expect(s2.orderIndex).toBe(1)
  })

  it('persists the shot so it appears in listShots', () => {
    createShot(db, { rundownId: ids.rundownId, cameraId: ids.cameraId, durationMs: 1000 })
    expect(listShots(db, ids.rundownId)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// updateShot
// ---------------------------------------------------------------------------

describe('updateShot', () => {
  let db: Database.Database
  let ids: { projectId: string; rundownId: string; cameraId: string }
  let shotId: string

  beforeEach(() => {
    db = openMemoryDb()
    ids = seed(db)
    const shot = createShot(db, {
      rundownId: ids.rundownId,
      cameraId: ids.cameraId,
      durationMs: 5000,
      label: 'Original',
    })
    shotId = shot.id
  })

  afterEach(() => {
    db.close()
  })

  it('updates durationMs and returns updated shot', () => {
    const updated = updateShot(db, { id: shotId, durationMs: 9000 })
    expect(updated.durationMs).toBe(9000)
    expect(updated.label).toBe('Original')
  })

  it('updates label', () => {
    const updated = updateShot(db, { id: shotId, label: 'New Label' })
    expect(updated.label).toBe('New Label')
    expect(updated.durationMs).toBe(5000)
  })

  it('updates cameraId', () => {
    db.prepare('INSERT INTO cameras (id, project_id, number, name, color) VALUES (?, ?, ?, ?, ?)').run(
      'cam-2',
      ids.projectId,
      2,
      'Close',
      '#3498db',
    )
    const updated = updateShot(db, { id: shotId, cameraId: 'cam-2' })
    expect(updated.cameraId).toBe('cam-2')
  })

  it('clears label when set to null', () => {
    const updated = updateShot(db, { id: shotId, label: null })
    expect(updated.label).toBeNull()
  })

  it('throws if shot does not exist', () => {
    expect(() => updateShot(db, { id: 'nonexistent', durationMs: 1000 })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// deleteShot
// ---------------------------------------------------------------------------

describe('deleteShot', () => {
  let db: Database.Database
  let ids: { projectId: string; rundownId: string; cameraId: string }

  beforeEach(() => {
    db = openMemoryDb()
    ids = seed(db)
  })

  afterEach(() => {
    db.close()
  })

  it('removes the shot', () => {
    const shot = createShot(db, { rundownId: ids.rundownId, cameraId: ids.cameraId, durationMs: 1000 })
    deleteShot(db, shot.id)
    expect(listShots(db, ids.rundownId)).toHaveLength(0)
  })

  it('throws if shot does not exist', () => {
    expect(() => deleteShot(db, 'nonexistent')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// reorderShots
// ---------------------------------------------------------------------------

describe('reorderShots', () => {
  let db: Database.Database
  let ids: { projectId: string; rundownId: string; cameraId: string }

  beforeEach(() => {
    db = openMemoryDb()
    ids = seed(db)
  })

  afterEach(() => {
    db.close()
  })

  it('reorders shots by assigning new orderIndex values', () => {
    const s1 = createShot(db, { rundownId: ids.rundownId, cameraId: ids.cameraId, durationMs: 1000 })
    const s2 = createShot(db, { rundownId: ids.rundownId, cameraId: ids.cameraId, durationMs: 2000 })
    const s3 = createShot(db, { rundownId: ids.rundownId, cameraId: ids.cameraId, durationMs: 3000 })

    // Reverse order
    reorderShots(db, [s3.id, s2.id, s1.id])

    const result = listShots(db, ids.rundownId)
    expect(result[0].id).toBe(s3.id)
    expect(result[1].id).toBe(s2.id)
    expect(result[2].id).toBe(s1.id)
  })

  it('persists reorder after fetch', () => {
    const s1 = createShot(db, { rundownId: ids.rundownId, cameraId: ids.cameraId, durationMs: 1000 })
    const s2 = createShot(db, { rundownId: ids.rundownId, cameraId: ids.cameraId, durationMs: 2000 })

    reorderShots(db, [s2.id, s1.id])

    const result = listShots(db, ids.rundownId)
    expect(result[0].orderIndex).toBe(0)
    expect(result[1].orderIndex).toBe(1)
  })
})
