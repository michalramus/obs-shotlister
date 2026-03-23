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
    ).run(id, rundownId, cameraId, 5000, i)
    shotIds.push(id)
  }
  return { rundownId, shotIds }
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
    expect(state.skippedIds).toEqual([])
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

  it('returns to idle state but preserves skippedIds', () => {
    const { rundownId, shotIds } = seedRundownWithShots(db)
    startLive(db, rundownId)
    // Skip the next shot
    skipNext(db)
    const stopped = stopLive(db)

    expect(stopped.running).toBe(false)
    expect(stopped.liveIndex).toBeNull()
    expect(stopped.startedAt).toBeNull()
    // Skipped shot id should be preserved
    expect(stopped.skippedIds).toContain(shotIds[1])
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

    // Small delay to ensure timestamps differ
    const state = nextShot(db)
    expect(state.liveIndex).toBe(1)
    expect(state.startedAt).toBeGreaterThanOrEqual(startedAt1)
  })

  it('skips over skipped shots', () => {
    const { rundownId } = seedRundownWithShots(db, 3) // shots 0,1,2
    startLive(db, rundownId)
    skipNext(db) // skip shot at index 1
    const state = nextShot(db)
    // should land on index 2 (index 1 is skipped)
    expect(state.liveIndex).toBe(2)
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

  it('adds the next shot id to skippedIds without advancing liveIndex', () => {
    const { rundownId, shotIds } = seedRundownWithShots(db, 3)
    startLive(db, rundownId)
    const state = skipNext(db)

    expect(state.liveIndex).toBe(0) // unchanged
    expect(state.skippedIds).toContain(shotIds[1]) // next shot marked skipped
  })

  it('does not double-add the same shot', () => {
    const { rundownId, shotIds } = seedRundownWithShots(db, 3)
    startLive(db, rundownId)
    skipNext(db)
    skipNext(db)
    const state = getLiveState(db)
    const occurrences = state.skippedIds.filter((id) => id === shotIds[1]).length
    expect(occurrences).toBe(1)
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

  it('resets liveIndex to 0, clears skippedIds, keeps running=true', () => {
    const { rundownId } = seedRundownWithShots(db, 3)
    startLive(db, rundownId)
    skipNext(db)
    nextShot(db) // advance to 2

    const state = restartLive(db)
    expect(state.liveIndex).toBe(0)
    expect(state.skippedIds).toEqual([])
    expect(state.running).toBe(true)
  })
})
