import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db/index'
import {
  listProjects,
  createProject,
  renameProject,
  deleteProject,
  listCameras,
  upsertCamera,
  deleteCamera,
} from './projects'
import type { Project, Camera } from '../../shared/types'

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

// ---------------------------------------------------------------------------
// projects:list
// ---------------------------------------------------------------------------

describe('listProjects', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
  })

  afterEach(() => {
    db.close()
  })

  it('returns an empty array when there are no projects', () => {
    const result = listProjects(db)
    expect(result).toEqual([])
  })

  it('returns all projects ordered by createdAt ascending', () => {
    db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('p2', 'B', 2000)
    db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('p1', 'A', 1000)

    const result = listProjects(db)
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe('p1')
    expect(result[1].id).toBe('p2')
  })

  it('returns projects with correct shape', () => {
    db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('p1', 'Alpha', 1234)
    const result = listProjects(db)
    const p = result[0] as Project
    expect(p.id).toBe('p1')
    expect(p.name).toBe('Alpha')
    expect(p.createdAt).toBe(1234)
  })
})

// ---------------------------------------------------------------------------
// projects:create
// ---------------------------------------------------------------------------

describe('createProject', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
  })

  afterEach(() => {
    db.close()
  })

  it('creates and returns a project with a generated id', () => {
    const project = createProject(db, 'My Project')
    expect(project.id).toBeTypeOf('string')
    expect(project.id.length).toBeGreaterThan(0)
    expect(project.name).toBe('My Project')
    expect(project.createdAt).toBeTypeOf('number')
  })

  it('persists the created project so it appears in listProjects', () => {
    createProject(db, 'Persist Test')
    const all = listProjects(db)
    expect(all).toHaveLength(1)
    expect(all[0].name).toBe('Persist Test')
  })

  it('generates unique ids for multiple projects', () => {
    const a = createProject(db, 'Alpha')
    const b = createProject(db, 'Beta')
    expect(a.id).not.toBe(b.id)
  })

  it('throws if name is empty', () => {
    expect(() => createProject(db, '')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// projects:rename
// ---------------------------------------------------------------------------

describe('renameProject', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1', 'Original')
  })

  afterEach(() => {
    db.close()
  })

  it('renames the project and returns the updated record', () => {
    const updated = renameProject(db, 'p1', 'Renamed')
    expect(updated.id).toBe('p1')
    expect(updated.name).toBe('Renamed')
  })

  it('persists the rename', () => {
    renameProject(db, 'p1', 'Persisted')
    const all = listProjects(db)
    expect(all[0].name).toBe('Persisted')
  })

  it('throws if the project does not exist', () => {
    expect(() => renameProject(db, 'nonexistent', 'X')).toThrow()
  })

  it('throws if name is empty', () => {
    expect(() => renameProject(db, 'p1', '')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// projects:delete
// ---------------------------------------------------------------------------

describe('deleteProject', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1', 'Alpha')
    insertProject(db, 'p2', 'Beta')
  })

  afterEach(() => {
    db.close()
  })

  it('removes the project from the database', () => {
    deleteProject(db, 'p1')
    const all = listProjects(db)
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe('p2')
  })

  it('throws if the project does not exist', () => {
    expect(() => deleteProject(db, 'nonexistent')).toThrow()
  })

  it('cascades deletion to cameras belonging to the project', () => {
    db.prepare('INSERT INTO cameras (id, project_id, number, name, color) VALUES (?, ?, ?, ?, ?)').run(
      'cam-1', 'p1', 1, 'Main', '#e74c3c',
    )
    deleteProject(db, 'p1')
    const cam = db.prepare('SELECT id FROM cameras WHERE id = ?').get('cam-1')
    expect(cam).toBeUndefined()
  })

  it('cascades deletion to rundowns belonging to the project', () => {
    db.prepare('INSERT INTO rundowns (id, project_id, name, created_at) VALUES (?, ?, ?, ?)').run(
      'rd-1', 'p1', 'Morning', 1000,
    )
    deleteProject(db, 'p1')
    const rd = db.prepare('SELECT id FROM rundowns WHERE id = ?').get('rd-1')
    expect(rd).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// cameras:list
// ---------------------------------------------------------------------------

describe('listCameras', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1', 'Alpha')
    insertProject(db, 'p2', 'Beta')
  })

  afterEach(() => {
    db.close()
  })

  it('returns an empty array when the project has no cameras', () => {
    expect(listCameras(db, 'p1')).toEqual([])
  })

  it('returns cameras for the specified project only', () => {
    db.prepare('INSERT INTO cameras (id, project_id, number, name, color) VALUES (?, ?, ?, ?, ?)').run(
      'cam-1', 'p1', 1, 'Wide', '#e74c3c',
    )
    db.prepare('INSERT INTO cameras (id, project_id, number, name, color) VALUES (?, ?, ?, ?, ?)').run(
      'cam-2', 'p2', 1, 'Close', '#3498db',
    )
    const result = listCameras(db, 'p1')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('cam-1')
  })

  it('returns cameras ordered by number ascending', () => {
    db.prepare('INSERT INTO cameras (id, project_id, number, name, color) VALUES (?, ?, ?, ?, ?)').run(
      'cam-3', 'p1', 3, 'C', '#000',
    )
    db.prepare('INSERT INTO cameras (id, project_id, number, name, color) VALUES (?, ?, ?, ?, ?)').run(
      'cam-1', 'p1', 1, 'A', '#000',
    )
    db.prepare('INSERT INTO cameras (id, project_id, number, name, color) VALUES (?, ?, ?, ?, ?)').run(
      'cam-2', 'p1', 2, 'B', '#000',
    )
    const result = listCameras(db, 'p1')
    expect(result.map((c: Camera) => c.number)).toEqual([1, 2, 3])
  })

  it('maps resolve_color column to resolveColor field', () => {
    db.prepare(
      'INSERT INTO cameras (id, project_id, number, name, color, resolve_color) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('cam-1', 'p1', 1, 'Wide', '#e74c3c', 'Red')
    const result = listCameras(db, 'p1')
    expect(result[0].resolveColor).toBe('Red')
  })

  it('maps null resolve_color to null resolveColor', () => {
    db.prepare(
      'INSERT INTO cameras (id, project_id, number, name, color, resolve_color) VALUES (?, ?, ?, ?, ?, NULL)',
    ).run('cam-1', 'p1', 1, 'Wide', '#e74c3c')
    const result = listCameras(db, 'p1')
    expect(result[0].resolveColor).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// cameras:upsert
// ---------------------------------------------------------------------------

describe('upsertCamera', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1', 'Alpha')
  })

  afterEach(() => {
    db.close()
  })

  it('creates a new camera when no id is provided', () => {
    const cam = upsertCamera(db, { projectId: 'p1', number: 1, name: 'Wide', color: '#e74c3c', resolveColor: null })
    expect(cam.id).toBeTypeOf('string')
    expect(cam.id.length).toBeGreaterThan(0)
    expect(cam.name).toBe('Wide')
    expect(cam.number).toBe(1)
    expect(cam.color).toBe('#e74c3c')
    expect(cam.resolveColor).toBeNull()
  })

  it('creates a new camera with a resolve color', () => {
    const cam = upsertCamera(db, { projectId: 'p1', number: 1, name: 'Wide', color: '#e74c3c', resolveColor: 'Red' })
    expect(cam.resolveColor).toBe('Red')
  })

  it('persists the new camera in listCameras', () => {
    upsertCamera(db, { projectId: 'p1', number: 1, name: 'Wide', color: '#e74c3c', resolveColor: null })
    expect(listCameras(db, 'p1')).toHaveLength(1)
  })

  it('updates an existing camera when id is provided', () => {
    const created = upsertCamera(db, { projectId: 'p1', number: 1, name: 'Wide', color: '#e74c3c', resolveColor: null })
    const updated = upsertCamera(db, { id: created.id, projectId: 'p1', number: 2, name: 'Close-up', color: '#3498db', resolveColor: 'Blue' })
    expect(updated.id).toBe(created.id)
    expect(updated.name).toBe('Close-up')
    expect(updated.number).toBe(2)
    expect(updated.color).toBe('#3498db')
    expect(updated.resolveColor).toBe('Blue')
  })

  it('does not create a duplicate when updating', () => {
    const created = upsertCamera(db, { projectId: 'p1', number: 1, name: 'Wide', color: '#e74c3c', resolveColor: null })
    upsertCamera(db, { id: created.id, projectId: 'p1', number: 1, name: 'Wide Renamed', color: '#e74c3c', resolveColor: null })
    expect(listCameras(db, 'p1')).toHaveLength(1)
  })

  it('throws if projectId refers to a non-existent project', () => {
    expect(() =>
      upsertCamera(db, { projectId: 'nonexistent', number: 1, name: 'Wide', color: '#e74c3c', resolveColor: null }),
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// cameras:delete
// ---------------------------------------------------------------------------

describe('deleteCamera', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1', 'Alpha')
    db.prepare('INSERT INTO cameras (id, project_id, number, name, color) VALUES (?, ?, ?, ?, ?)').run(
      'cam-1', 'p1', 1, 'Wide', '#e74c3c',
    )
    db.prepare('INSERT INTO cameras (id, project_id, number, name, color) VALUES (?, ?, ?, ?, ?)').run(
      'cam-2', 'p1', 2, 'Close', '#3498db',
    )
  })

  afterEach(() => {
    db.close()
  })

  it('removes the specified camera', () => {
    deleteCamera(db, 'cam-1')
    const remaining = listCameras(db, 'p1')
    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe('cam-2')
  })

  it('throws if the camera does not exist', () => {
    expect(() => deleteCamera(db, 'nonexistent')).toThrow()
  })
})
