import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from './index'

// All migration tests use an in-memory SQLite database so they run without
// an Electron context (no app.getPath) and leave no files on disk.

function openMemoryDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  return db
}

describe('applyMigrations', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
  })

  afterEach(() => {
    db.close()
  })

  describe('table creation', () => {
    it('creates the projects table', () => {
      applyMigrations(db)
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'")
        .get() as { name: string } | undefined
      expect(row?.name).toBe('projects')
    })

    it('creates the cameras table', () => {
      applyMigrations(db)
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cameras'")
        .get() as { name: string } | undefined
      expect(row?.name).toBe('cameras')
    })

    it('creates the rundowns table', () => {
      applyMigrations(db)
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rundowns'")
        .get() as { name: string } | undefined
      expect(row?.name).toBe('rundowns')
    })

    it('creates the shots table', () => {
      applyMigrations(db)
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shots'")
        .get() as { name: string } | undefined
      expect(row?.name).toBe('shots')
    })
  })

  describe('idempotency', () => {
    it('can be called multiple times without error', () => {
      expect(() => {
        applyMigrations(db)
        applyMigrations(db)
        applyMigrations(db)
      }).not.toThrow()
    })
  })

  describe('projects table constraints', () => {
    it('requires name to be NOT NULL', () => {
      applyMigrations(db)
      expect(() => {
        db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, NULL, ?)').run('p1', 1)
      }).toThrow()
    })

    it('requires created_at to be NOT NULL', () => {
      applyMigrations(db)
      expect(() => {
        db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, NULL)').run('p1', 'Proj')
      }).toThrow()
    })

    it('enforces PRIMARY KEY uniqueness', () => {
      applyMigrations(db)
      db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('p1', 'Project A', 1000)
      expect(() => {
        db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('p1', 'Project B', 2000)
      }).toThrow()
    })
  })

  describe('cameras table constraints', () => {
    beforeEach(() => {
      applyMigrations(db)
      db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('proj-1', 'Test Project', 1000)
    })

    it('enforces UNIQUE(project_id, number)', () => {
      db.prepare(
        'INSERT INTO cameras (id, project_id, number, name, color) VALUES (?, ?, ?, ?, ?)',
      ).run('cam-1', 'proj-1', 1, 'Camera A', '#e74c3c')
      expect(() => {
        db.prepare(
          'INSERT INTO cameras (id, project_id, number, name, color) VALUES (?, ?, ?, ?, ?)',
        ).run('cam-2', 'proj-1', 1, 'Camera B', '#3498db')
      }).toThrow()
    })

    it('allows same number for different projects', () => {
      db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('proj-2', 'Other Project', 2000)
      db.prepare(
        'INSERT INTO cameras (id, project_id, number, name, color) VALUES (?, ?, ?, ?, ?)',
      ).run('cam-1', 'proj-1', 1, 'Camera A', '#e74c3c')
      expect(() => {
        db.prepare(
          'INSERT INTO cameras (id, project_id, number, name, color) VALUES (?, ?, ?, ?, ?)',
        ).run('cam-2', 'proj-2', 1, 'Camera A', '#e74c3c')
      }).not.toThrow()
    })

    it('cascades delete from projects to cameras', () => {
      db.prepare(
        'INSERT INTO cameras (id, project_id, number, name, color) VALUES (?, ?, ?, ?, ?)',
      ).run('cam-1', 'proj-1', 1, 'Camera A', '#e74c3c')

      db.prepare('DELETE FROM projects WHERE id = ?').run('proj-1')

      const cam = db.prepare('SELECT id FROM cameras WHERE id = ?').get('cam-1')
      expect(cam).toBeUndefined()
    })

    it('allows resolve_color to be NULL', () => {
      expect(() => {
        db.prepare(
          'INSERT INTO cameras (id, project_id, number, name, color, resolve_color) VALUES (?, ?, ?, ?, ?, ?)',
        ).run('cam-1', 'proj-1', 1, 'Camera A', '#e74c3c', null)
      }).not.toThrow()
    })
  })

  describe('rundowns table constraints', () => {
    beforeEach(() => {
      applyMigrations(db)
      db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('proj-1', 'Test Project', 1000)
    })

    it('cascades delete from projects to rundowns', () => {
      db.prepare('INSERT INTO rundowns (id, project_id, name, created_at) VALUES (?, ?, ?, ?)').run(
        'rd-1',
        'proj-1',
        'Morning Show',
        1000,
      )

      db.prepare('DELETE FROM projects WHERE id = ?').run('proj-1')

      const rd = db.prepare('SELECT id FROM rundowns WHERE id = ?').get('rd-1')
      expect(rd).toBeUndefined()
    })
  })

  describe('shots table constraints', () => {
    beforeEach(() => {
      applyMigrations(db)
      db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('proj-1', 'Test Project', 1000)
      db.prepare('INSERT INTO rundowns (id, project_id, name, created_at) VALUES (?, ?, ?, ?)').run(
        'rd-1',
        'proj-1',
        'Morning Show',
        1000,
      )
      db.prepare(
        'INSERT INTO cameras (id, project_id, number, name, color) VALUES (?, ?, ?, ?, ?)',
      ).run('cam-1', 'proj-1', 1, 'Camera A', '#e74c3c')
    })

    it('cascades delete from rundowns to shots', () => {
      db.prepare(
        'INSERT INTO shots (id, rundown_id, camera_id, duration_ms, order_index) VALUES (?, ?, ?, ?, ?)',
      ).run('shot-1', 'rd-1', 'cam-1', 5000, 0)

      db.prepare('DELETE FROM rundowns WHERE id = ?').run('rd-1')

      const shot = db.prepare('SELECT id FROM shots WHERE id = ?').get('shot-1')
      expect(shot).toBeUndefined()
    })

    it('allows label to be NULL', () => {
      expect(() => {
        db.prepare(
          'INSERT INTO shots (id, rundown_id, camera_id, duration_ms, label, order_index) VALUES (?, ?, ?, ?, ?, ?)',
        ).run('shot-1', 'rd-1', 'cam-1', 5000, null, 0)
      }).not.toThrow()
    })

    it('requires duration_ms to be NOT NULL', () => {
      expect(() => {
        db.prepare(
          'INSERT INTO shots (id, rundown_id, camera_id, duration_ms, order_index) VALUES (?, ?, ?, NULL, ?)',
        ).run('shot-1', 'rd-1', 'cam-1', 0)
      }).toThrow()
    })
  })
})
