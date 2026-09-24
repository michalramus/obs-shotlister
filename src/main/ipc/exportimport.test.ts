import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db/index'
import {
  exportProject,
  exportRundown,
  exportDatabase,
  importProject,
  importRundown,
  importDatabase,
} from './exportimport'

function openMemoryDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  return db
}

/**
 * A Project holding one Camera Rundown and one Voice-over Rundown, with Parts
 * at two scopes and a Lyric — everything an export has to carry across.
 */
function seed(db: Database.Database): void {
  db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('p1', 'Gig', 1)
  db.prepare(
    'INSERT INTO cameras (id, project_id, number, name, color, obs_scene) VALUES (?,?,?,?,?,?)',
  ).run('c1', 'p1', 1, 'Wide', '#f00', 'Scene 1')

  db.prepare(
    "INSERT INTO rundowns (id, project_id, name, created_at, order_index, folder, kind) VALUES ('rdc','p1','Set',1,0,'Day 1','camera')",
  ).run()
  db.prepare(
    "INSERT INTO rundowns (id, project_id, name, created_at, order_index, folder, kind) VALUES ('rdv','p1','Song',2,1,'Day 1','voice')",
  ).run()

  // Project scope, folder scope, and one belonging to the voice Rundown itself.
  db.prepare('INSERT INTO parts (id, project_id, number, name, color) VALUES (?,?,?,?,?)').run(
    'pt1',
    'p1',
    1,
    'gitara',
    '#0f0',
  )
  db.prepare(
    "INSERT INTO parts (id, project_id, number, name, color, folder) VALUES ('pt2','p1',2,'refren','#00f','Day 1')",
  ).run()
  db.prepare(
    "INSERT INTO parts (id, project_id, number, name, color, rundown_id) VALUES ('pt3','p1',3,'outro','#ff0','rdv')",
  ).run()

  db.prepare(
    'INSERT INTO shots (id, rundown_id, camera_id, duration_ms, order_index, transition_ms) VALUES (?,?,?,?,?,?)',
  ).run('s1', 'rdc', 'c1', 5000, 0, 0)
  db.prepare(
    'INSERT INTO shots (id, rundown_id, part_id, duration_ms, label, order_index, transition_ms) VALUES (?,?,?,?,?,?,?)',
  ).run('v1', 'rdv', 'pt1', 8000, 'intro riff', 0, 0)
  db.prepare(
    'INSERT INTO shots (id, rundown_id, part_id, duration_ms, order_index, transition_ms) VALUES (?,?,?,?,?,?)',
  ).run('v2', 'rdv', 'pt3', 9000, 1, 0)

  db.prepare('INSERT INTO lyrics (id, rundown_id, start_ms, end_ms, text) VALUES (?,?,?,?,?)').run(
    'l1',
    'rdv',
    0,
    4000,
    'first line',
  )
}

describe('exporting and importing a Project', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    seed(db)
  })

  afterEach(() => {
    db.close()
  })

  it('brings a Voice-over Rundown back as voice, not camera', () => {
    const newId = importProject(db, exportProject(db, 'p1'))
    const kinds = db
      .prepare('SELECT name, kind FROM rundowns WHERE project_id = ? ORDER BY name')
      .all(newId) as { name: string; kind: string }[]
    expect(kinds).toEqual([
      { name: 'Set', kind: 'camera' },
      { name: 'Song', kind: 'voice' },
    ])
  })

  it('brings every Call back still pointing at its Part', () => {
    const newId = importProject(db, exportProject(db, 'p1'))
    const calls = db
      .prepare(
        `SELECT s.label, s.duration_ms, p.name AS part FROM shots s
           JOIN rundowns r ON r.id = s.rundown_id
           LEFT JOIN parts p ON p.id = s.part_id
          WHERE r.project_id = ? AND r.kind = 'voice'
          ORDER BY s.order_index`,
      )
      .all(newId)
    expect(calls).toEqual([
      { label: 'intro riff', duration_ms: 8000, part: 'gitara' },
      { label: null, duration_ms: 9000, part: 'outro' },
    ])
  })

  it('brings the Parts back at the scope they were defined at', () => {
    const newId = importProject(db, exportProject(db, 'p1'))
    const parts = db
      .prepare(
        `SELECT p.name, p.folder, r.name AS rundown FROM parts p
           LEFT JOIN rundowns r ON r.id = p.rundown_id
          WHERE p.project_id = ? ORDER BY p.name`,
      )
      .all(newId)
    expect(parts).toEqual([
      { name: 'gitara', folder: null, rundown: null },
      { name: 'outro', folder: null, rundown: 'Song' },
      { name: 'refren', folder: 'Day 1', rundown: null },
    ])
  })

  it('brings the Lyrics back', () => {
    const newId = importProject(db, exportProject(db, 'p1'))
    const lyrics = db
      .prepare(
        `SELECT l.start_ms, l.end_ms, l.text FROM lyrics l
           JOIN rundowns r ON r.id = l.rundown_id
          WHERE r.project_id = ?`,
      )
      .all(newId)
    expect(lyrics).toEqual([{ start_ms: 0, end_ms: 4000, text: 'first line' }])
  })

  it('leaves a Camera Rundown on its Cameras and off any Part', () => {
    const newId = importProject(db, exportProject(db, 'p1'))
    const shots = db
      .prepare(
        `SELECT s.part_id, c.name AS camera FROM shots s
           JOIN rundowns r ON r.id = s.rundown_id
           LEFT JOIN cameras c ON c.id = s.camera_id
          WHERE r.project_id = ? AND r.kind = 'camera'`,
      )
      .all(newId)
    expect(shots).toEqual([{ part_id: null, camera: 'Wide' }])
  })
})

describe('exporting and importing one Rundown', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    seed(db)
  })

  afterEach(() => {
    db.close()
  })

  it('carries the Kind, the Calls, their Parts and the Lyrics', () => {
    const exported = exportRundown(db, 'rdv')

    db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('p2', 'Other', 2)
    const newId = importRundown(db, 'p2', exported)

    const rundown = db.prepare('SELECT kind FROM rundowns WHERE id = ?').get(newId)
    expect(rundown).toEqual({ kind: 'voice' })

    const calls = db
      .prepare(
        `SELECT p.name AS part FROM shots s LEFT JOIN parts p ON p.id = s.part_id
          WHERE s.rundown_id = ? ORDER BY s.order_index`,
      )
      .all(newId)
    expect(calls).toEqual([{ part: 'gitara' }, { part: 'outro' }])

    expect(db.prepare('SELECT COUNT(*) AS n FROM lyrics WHERE rundown_id = ?').get(newId)).toEqual({
      n: 1,
    })
  })

  it('reuses a Part the target Project already has by that name', () => {
    const exported = exportRundown(db, 'rdv')
    db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('p2', 'Other', 2)
    db.prepare('INSERT INTO parts (id, project_id, number, name, color) VALUES (?,?,?,?,?)').run(
      'other-gitara',
      'p2',
      1,
      'gitara',
      '#abc',
    )

    const newId = importRundown(db, 'p2', exported)

    // One "gitara", not two, or the same name would fork into two cached clips.
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM parts WHERE project_id='p2' AND name='gitara'").get(),
    ).toEqual({ n: 1 })
    const first = db
      .prepare('SELECT part_id FROM shots WHERE rundown_id = ? ORDER BY order_index LIMIT 1')
      .get(newId)
    expect(first).toEqual({ part_id: 'other-gitara' })
  })

  it('gives an imported Part a free number rather than colliding', () => {
    const exported = exportRundown(db, 'rdv')
    db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('p2', 'Other', 2)
    // Occupies number 1, which "gitara" was exported with.
    db.prepare('INSERT INTO parts (id, project_id, number, name, color) VALUES (?,?,?,?,?)').run(
      'taken',
      'p2',
      1,
      'something else',
      '#abc',
    )

    expect(() => importRundown(db, 'p2', exported)).not.toThrow()
    const numbers = db
      .prepare("SELECT number FROM parts WHERE project_id='p2' ORDER BY number")
      .all() as { number: number }[]
    expect(new Set(numbers.map((n) => n.number)).size).toBe(numbers.length)
  })
})

describe('exporting and importing the whole database', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    seed(db)
  })

  afterEach(() => {
    db.close()
  })

  it('round-trips Parts, Calls, Kinds and Lyrics unchanged', () => {
    const before = {
      parts: db.prepare('SELECT * FROM parts ORDER BY id').all(),
      shots: db.prepare('SELECT * FROM shots ORDER BY id').all(),
      rundowns: db.prepare('SELECT * FROM rundowns ORDER BY id').all(),
      lyrics: db.prepare('SELECT * FROM lyrics ORDER BY id').all(),
    }

    importDatabase(db, exportDatabase(db))

    expect(db.prepare('SELECT * FROM parts ORDER BY id').all()).toEqual(before.parts)
    expect(db.prepare('SELECT * FROM shots ORDER BY id').all()).toEqual(before.shots)
    expect(db.prepare('SELECT * FROM rundowns ORDER BY id').all()).toEqual(before.rundowns)
    expect(db.prepare('SELECT * FROM lyrics ORDER BY id').all()).toEqual(before.lyrics)
  })
})
