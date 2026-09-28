import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { openMemoryDb } from '../db/memory-db.fixture'
import { createLiveSession } from '../live/session'
import { buildRundownState } from './socket'

/**
 * The payload every phone draws from (ADR-0003), which had no tests: a mistake
 * here is invisible until a camera operator is looking at the wrong thing.
 */
function seed(db: Database.Database): void {
  db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?,?,?)').run('p1', 'Gig', 1)
  db.prepare(
    'INSERT INTO cameras (id, project_id, number, name, color, obs_scene) VALUES (?,?,?,?,?,?)',
  ).run('c1', 'p1', 1, 'Wide', '#f00', 'Scene 1')
  db.prepare('INSERT INTO parts (id, project_id, number, name, color) VALUES (?,?,?,?,?)').run(
    'pt1',
    'p1',
    1,
    'gitara',
    '#0f0',
  )
  db.prepare(
    'INSERT INTO rundowns (id, project_id, name, created_at, order_index, kind) VALUES (?,?,?,?,?,?)',
  ).run('rd1', 'p1', 'Set one', 2, 0, 'camera')
  for (const [id, order] of [
    ['s1', 0],
    ['s2', 1],
    ['s3', 2],
  ] as const) {
    db.prepare(
      'INSERT INTO shots (id, rundown_id, camera_id, duration_ms, order_index, transition_ms) VALUES (?,?,?,?,?,?)',
    ).run(id, 'rd1', 'c1', 5000, order, 0)
  }
}

describe('buildRundownState', () => {
  let db: Database.Database
  let session: ReturnType<typeof createLiveSession>

  beforeEach(() => {
    db = openMemoryDb()
    seed(db)
    session = createLiveSession(db)
  })

  afterEach(() => {
    db.close()
  })

  it('is empty when nothing is selected, so a fresh phone draws nothing', () => {
    expect(buildRundownState(db, session)).toEqual({
      rundown: null,
      shots: [],
      cameras: [],
      parts: [],
    })
  })

  it('carries the Rundown, its Shots, and the Project Cameras and Parts', () => {
    session.setActiveRundown('rd1')
    const payload = buildRundownState(db, session)

    expect(payload.rundown?.id).toBe('rd1')
    expect(payload.shots.map((s) => s.id)).toEqual(['s1', 's2', 's3'])
    expect(payload.cameras.map((c) => c.id)).toEqual(['c1'])
    // Every Part the Project owns, not just those in picker scope — a phone
    // that cannot name a Call is worse than one carrying unused Parts.
    expect(payload.parts.map((p) => p.id)).toEqual(['pt1'])
  })

  it('prefers the queue hidden flags over a plain read', () => {
    session.setActiveRundown('rd1')
    session.start('rd1')
    session.next()

    const override = session.getShotsForPhones()
    expect(override).toBeDefined()
    const payload = buildRundownState(db, session, override)

    // s1 is spent, so a phone must not still offer it as pending.
    expect(payload.shots.find((s) => s.id === 's1')?.hidden).toBe(true)
    expect(payload.shots.find((s) => s.id === 's2')?.hidden).toBe(false)
  })

  it('reports no override while nothing is queued, so the phone derives it', () => {
    session.setActiveRundown('rd1')
    expect(session.getShotsForPhones()).toBeUndefined()
  })

  it('still names the Project Cameras when a Project is open but no Rundown is', () => {
    session.setActiveProject('p1')
    const payload = buildRundownState(db, session)

    expect(payload.rundown).toBeNull()
    expect(payload.shots).toEqual([])
    expect(payload.cameras.map((c) => c.id)).toEqual(['c1'])
  })

  it('blanks out rather than throwing when the selected Rundown has vanished', () => {
    session.setActiveRundown('rd1')
    db.prepare('DELETE FROM rundowns WHERE id = ?').run('rd1')

    expect(buildRundownState(db, session)).toEqual({
      rundown: null,
      shots: [],
      cameras: [],
      parts: [],
    })
  })
})
