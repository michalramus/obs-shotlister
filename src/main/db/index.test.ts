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
        db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, NULL)').run(
          'p1',
          'Proj',
        )
      }).toThrow()
    })

    it('enforces PRIMARY KEY uniqueness', () => {
      applyMigrations(db)
      db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(
        'p1',
        'Project A',
        1000,
      )
      expect(() => {
        db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(
          'p1',
          'Project B',
          2000,
        )
      }).toThrow()
    })
  })

  describe('cameras table constraints', () => {
    beforeEach(() => {
      applyMigrations(db)
      db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(
        'proj-1',
        'Test Project',
        1000,
      )
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
      db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(
        'proj-2',
        'Other Project',
        2000,
      )
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
      db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(
        'proj-1',
        'Test Project',
        1000,
      )
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
      db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(
        'proj-1',
        'Test Project',
        1000,
      )
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

describe('indexes', () => {
  let database: Database.Database

  beforeEach(() => {
    database = new Database(':memory:')
    applyMigrations(database)
  })

  afterEach(() => {
    database.close()
  })

  it.each([
    ['idx_shots_rundown', 'shots'],
    ['idx_cameras_project', 'cameras'],
    ['idx_rundowns_project', 'rundowns'],
    ['idx_markers_rundown', 'markers'],
  ])('creates %s', (name, table) => {
    const row = database
      .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(name) as { name: string; tbl_name: string } | undefined
    expect(row).toEqual({ name, tbl_name: table })
  })

  it('uses the shots index instead of scanning when listing a rundown', () => {
    const plan = database
      .prepare(
        'EXPLAIN QUERY PLAN SELECT id FROM shots WHERE rundown_id = ? ORDER BY order_index ASC',
      )
      .all('r1') as Array<{ detail: string }>
    const detail = plan.map((p) => p.detail).join(' ')
    expect(detail).toContain('idx_shots_rundown')
    expect(detail).not.toContain('SCAN shots')
  })

  it('adds const_length_ms to transition_mappings on a fresh database', () => {
    const cols = database.prepare('PRAGMA table_info(transition_mappings)').all() as Array<{
      name: string
    }>
    expect(cols.map((c) => c.name)).toContain('const_length_ms')
  })
})

// ---------------------------------------------------------------------------
// Upgrading a database written before Voice-over Rundowns existed.
//
// Every other migration here adds a column and is safe to replay. Dropping the
// NOT NULL on shots.camera_id is not: SQLite cannot do it in place, so the
// table is rebuilt, and a rebuild that loses a row or a constraint loses an
// operator's Rundown. These tests run the upgrade against the real pre-feature
// schema rather than against a fresh database.
// ---------------------------------------------------------------------------

/** The schema exactly as it stood before Kind, Parts and Lyrics were added. */
function openLegacyDb(): Database.Database {
  const db = openMemoryDb()
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE cameras (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      number INTEGER NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL,
      resolve_color TEXT, obs_scene TEXT,
      UNIQUE(project_id, number)
    );
    CREATE TABLE rundowns (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, created_at INTEGER NOT NULL,
      order_index INTEGER NOT NULL DEFAULT 0, folder TEXT
    );
    CREATE TABLE shots (
      id TEXT PRIMARY KEY,
      rundown_id TEXT NOT NULL REFERENCES rundowns(id) ON DELETE CASCADE,
      camera_id TEXT NOT NULL REFERENCES cameras(id),
      duration_ms INTEGER NOT NULL, label TEXT, order_index INTEGER NOT NULL,
      transition_name TEXT, transition_ms INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE live_state (
      id INTEGER PRIMARY KEY CHECK (id = 1), rundown_id TEXT,
      skipped_ids TEXT NOT NULL DEFAULT '[]', project_id TEXT
    );
    INSERT OR IGNORE INTO live_state (id, skipped_ids) VALUES (1, '[]');

    INSERT INTO projects VALUES ('p1', 'Gig', 1000);
    INSERT INTO cameras VALUES ('c1', 'p1', 1, 'Wide', '#e74c3c', 'Red', 'Scene 1');
    INSERT INTO rundowns VALUES ('rd1', 'p1', 'Set one', 2000, 0, 'Day 1');
    INSERT INTO shots VALUES ('s1', 'rd1', 'c1', 5000, 'intro', 0, 'fade', 500);
    INSERT INTO shots VALUES ('s2', 'rd1', 'c1', 9000, NULL, 1, NULL, 0);
  `)
  return db
}

function columnIsNotNull(db: Database.Database, table: string, column: string): boolean {
  const columns = db.pragma(`table_info(${table})`) as { name: string; notnull: number }[]
  return columns.find((c) => c.name === column)?.notnull === 1
}

describe('upgrading a pre-Voice-over database', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openLegacyDb()
  })

  afterEach(() => {
    db.close()
  })

  it('migrates existing Rundowns to the camera Kind', () => {
    applyMigrations(db)
    const row = db.prepare('SELECT kind FROM rundowns WHERE id = ?').get('rd1') as { kind: string }
    expect(row.kind).toBe('camera')
  })

  it('keeps every Shot, with its Camera, label, order and transition intact', () => {
    applyMigrations(db)
    const shots = db.prepare('SELECT * FROM shots ORDER BY order_index').all() as Record<
      string,
      unknown
    >[]
    expect(shots).toHaveLength(2)
    expect(shots[0]).toMatchObject({
      id: 's1',
      rundown_id: 'rd1',
      camera_id: 'c1',
      part_id: null,
      duration_ms: 5000,
      label: 'intro',
      order_index: 0,
      transition_name: 'fade',
      transition_ms: 500,
    })
    expect(shots[1]).toMatchObject({ id: 's2', camera_id: 'c1', label: null, transition_ms: 0 })
  })

  it('drops the NOT NULL on camera_id so a Call can exist without one', () => {
    applyMigrations(db)
    expect(columnIsNotNull(db, 'shots', 'camera_id')).toBe(false)
    expect(() =>
      db
        .prepare('INSERT INTO shots (id, rundown_id, duration_ms, order_index) VALUES (?, ?, ?, ?)')
        .run('s3', 'rd1', 1000, 2),
    ).not.toThrow()
  })

  it('keeps the rest of the shots constraints through the rebuild', () => {
    applyMigrations(db)
    // rundown_id stays required and still cascades; camera_id stays a real FK.
    expect(columnIsNotNull(db, 'shots', 'rundown_id')).toBe(true)
    expect(() =>
      db
        .prepare(
          'INSERT INTO shots (id, rundown_id, camera_id, duration_ms, order_index) VALUES (?, ?, ?, ?, ?)',
        )
        .run('s4', 'rd1', 'nope', 1000, 3),
    ).toThrow()

    db.prepare('DELETE FROM rundowns WHERE id = ?').run('rd1')
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM shots').get() as { n: number }
    expect(remaining.n).toBe(0)
  })

  it('leaves foreign key enforcement on after the rebuild', () => {
    applyMigrations(db)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('rebuilds only once, and replaying the migrations changes nothing', () => {
    applyMigrations(db)
    const before = db.prepare('SELECT * FROM shots ORDER BY id').all()
    applyMigrations(db)
    applyMigrations(db)
    expect(db.prepare('SELECT * FROM shots ORDER BY id').all()).toEqual(before)
    expect(columnIsNotNull(db, 'shots', 'camera_id')).toBe(false)
  })

  it('preserves the shots index the hot reads depend on', () => {
    applyMigrations(db)
    const index = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_shots_rundown'")
      .get()
    expect(index).toBeDefined()
  })
})
