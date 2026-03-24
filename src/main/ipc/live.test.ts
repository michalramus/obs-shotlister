import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db/index'
import { getLiveState, startLive, stopLive, nextShot, skipNext, restartLive } from './live'

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

function seedRundownWithShots(
  db: Database.Database,
  shotCount = 3,
  durationMs = 5000,
): { rundownId: string; shotIds: string[] } {
  const projectId = 'p1'
  const rundownId = 'rd-1'
  const cameraId = 'cam-1'
  db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(projectId, 'P', 1000)
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
  const shotIds: string[] = []
  for (let i = 0; i < shotCount; i++) {
    const id = `shot-${i}`
    db.prepare(
      'INSERT INTO shots (id, rundown_id, camera_id, duration_ms, order_index) VALUES (?, ?, ?, ?, ?)',
    ).run(id, rundownId, cameraId, durationMs, i)
    shotIds.push(id)
  }
  return { rundownId, shotIds }
}

function getShotIds(db: Database.Database, rundownId: string): string[] {
  return (db.prepare('SELECT id FROM shots WHERE rundown_id = ? ORDER BY order_index ASC').all(rundownId) as { id: string }[]).map((r) => r.id)
}

// ---------------------------------------------------------------------------
// getLiveState
// ---------------------------------------------------------------------------

describe('getLiveState', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
  })

  afterEach(() => {
    db.close()
  })

  it('returns default idle state after migrations', () => {
    const state = getLiveState(db)
    expect(state.running).toBe(false)
    expect(state.liveIndex).toBeNull()
    expect(state.startedAt).toBeNull()
    expect(state.rundownId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// startLive
// ---------------------------------------------------------------------------

describe('startLive', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
  })

  afterEach(() => {
    db.close()
  })

  it('sets running=true, liveIndex=0, and records startedAt', () => {
    const { rundownId } = seedRundownWithShots(db)
    const before = Date.now()
    const state = startLive(db, rundownId)
    const after = Date.now()

    expect(state.running).toBe(true)
    expect(state.liveIndex).toBe(0)
    expect(state.rundownId).toBe(rundownId)
    expect(state.startedAt).toBeGreaterThanOrEqual(before)
    expect(state.startedAt).toBeLessThanOrEqual(after)
  })

  it('persists state so getLiveState returns updated values', () => {
    const { rundownId } = seedRundownWithShots(db)
    startLive(db, rundownId)
    const state = getLiveState(db)
    expect(state.running).toBe(true)
    expect(state.liveIndex).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// stopLive
// ---------------------------------------------------------------------------

describe('stopLive', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
  })

  afterEach(() => {
    db.close()
  })

  it('returns to idle state', () => {
    const { rundownId } = seedRundownWithShots(db)
    startLive(db, rundownId)
    const stopped = stopLive(db)

    expect(stopped.running).toBe(false)
    expect(stopped.liveIndex).toBeNull()
    expect(stopped.startedAt).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// nextShot
// ---------------------------------------------------------------------------

describe('nextShot', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
  })

  afterEach(() => {
    db.close()
  })

  it('advances liveIndex and resets startedAt', () => {
    const { rundownId } = seedRundownWithShots(db)
    const started = startLive(db, rundownId)
    const startedAt1 = started.startedAt as number

    const state = nextShot(db)
    expect(state.liveIndex).toBe(1)
    expect(state.startedAt).toBeGreaterThanOrEqual(startedAt1)
  })

  it('transitions to idle when advancing past last shot', () => {
    const { rundownId } = seedRundownWithShots(db, 1) // only 1 shot
    startLive(db, rundownId)
    const state = nextShot(db)
    expect(state.running).toBe(false)
    expect(state.liveIndex).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// skipNext
// ---------------------------------------------------------------------------

describe('skipNext', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
  })

  afterEach(() => {
    db.close()
  })

  it('deletes the next shot and extends started_at back by its duration', () => {
    const { rundownId, shotIds } = seedRundownWithShots(db, 3, 5000)
    startLive(db, rundownId)

    // Capture started_at before skip
    const before = getLiveState(db)
    const beforeStartedAt = before.startedAt as number

    const state = skipNext(db)

    expect(state.liveIndex).toBe(0) // unchanged
    // started_at moved back by 5000ms (next shot's duration)
    expect(state.startedAt).toBe(beforeStartedAt - 5000)

    // shot-1 (the next shot) should be deleted
    const remaining = getShotIds(db, rundownId)
    expect(remaining).not.toContain(shotIds[1])
    expect(remaining).toContain(shotIds[0])
    expect(remaining).toContain(shotIds[2])
  })

  it('does nothing when there is no next shot', () => {
    const { rundownId } = seedRundownWithShots(db, 1)
    startLive(db, rundownId)
    const before = getLiveState(db)
    const state = skipNext(db)
    expect(state.liveIndex).toBe(0)
    expect(state.startedAt).toBe(before.startedAt)
    expect(getShotIds(db, rundownId)).toHaveLength(1)
  })

  it('throws when not running', () => {
    const { rundownId } = seedRundownWithShots(db, 3)
    // not started
    expect(() => skipNext(db)).toThrow('Cannot skip: not running')
    void rundownId
  })
})

// ---------------------------------------------------------------------------
// restartLive
// ---------------------------------------------------------------------------

describe('restartLive', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
  })

  afterEach(() => {
    db.close()
  })

  it('resets liveIndex to 0 and keeps running=true', () => {
    const { rundownId } = seedRundownWithShots(db, 3)
    startLive(db, rundownId)
    nextShot(db) // advance to 1

    const state = restartLive(db)
    expect(state.liveIndex).toBe(0)
    expect(state.running).toBe(true)
  })
})
