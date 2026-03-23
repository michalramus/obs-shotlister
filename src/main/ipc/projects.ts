/**
 * IPC handler logic for project and camera CRUD operations.
 *
 * Each function accepts a Database instance so it can be tested with an
 * in-memory database without requiring an Electron context.
 *
 * IPC registration (ipcMain.handle) happens in src/main/index.ts.
 */

import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type { Project, Camera } from '../../shared/types'

// ---------------------------------------------------------------------------
// Row shapes returned from better-sqlite3
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: string
  name: string
  created_at: number
}

interface CameraRow {
  id: string
  project_id: string
  number: number
  name: string
  color: string
  resolve_color: string | null
  obs_scene: string | null
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
  }
}

function rowToCamera(row: CameraRow): Camera {
  return {
    id: row.id,
    projectId: row.project_id,
    number: row.number,
    name: row.name,
    color: row.color,
    resolveColor: row.resolve_color,
    obsScene: row.obs_scene,
  }
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function listProjects(db: Database.Database): Project[] {
  const rows = db
    .prepare('SELECT id, name, created_at FROM projects ORDER BY created_at ASC')
    .all() as ProjectRow[]
  return rows.map(rowToProject)
}

export function createProject(db: Database.Database, name: string): Project {
  if (!name.trim()) {
    throw new Error('Project name must not be empty')
  }

  const id = randomUUID()
  const createdAt = Date.now()

  db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(id, name, createdAt)

  return { id, name, createdAt }
}

export function renameProject(db: Database.Database, id: string, name: string): Project {
  if (!name.trim()) {
    throw new Error('Project name must not be empty')
  }

  const result = db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id)

  if (result.changes === 0) {
    throw new Error(`Project not found: ${id}`)
  }

  const row = db.prepare('SELECT id, name, created_at FROM projects WHERE id = ?').get(id) as ProjectRow
  return rowToProject(row)
}

export function deleteProject(db: Database.Database, id: string): void {
  const result = db.prepare('DELETE FROM projects WHERE id = ?').run(id)

  if (result.changes === 0) {
    throw new Error(`Project not found: ${id}`)
  }
}

// ---------------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------------

export function listCameras(db: Database.Database, projectId: string): Camera[] {
  const rows = db
    .prepare(
      'SELECT id, project_id, number, name, color, resolve_color, obs_scene FROM cameras WHERE project_id = ? ORDER BY number ASC',
    )
    .all(projectId) as CameraRow[]
  return rows.map(rowToCamera)
}

export function getCameraById(db: Database.Database, id: string): Camera | null {
  const row = db
    .prepare('SELECT id, project_id, number, name, color, resolve_color, obs_scene FROM cameras WHERE id = ?')
    .get(id) as CameraRow | undefined
  return row ? rowToCamera(row) : null
}

export type CameraUpsertInput = Omit<Camera, 'id'> & { id?: string }

export function upsertCamera(db: Database.Database, input: CameraUpsertInput): Camera {
  if (input.id) {
    // Update existing camera
    const result = db
      .prepare(
        'UPDATE cameras SET project_id = ?, number = ?, name = ?, color = ?, resolve_color = ?, obs_scene = ? WHERE id = ?',
      )
      .run(input.projectId, input.number, input.name, input.color, input.resolveColor ?? null, input.obsScene ?? null, input.id)

    if (result.changes === 0) {
      throw new Error(`Camera not found: ${input.id}`)
    }

    const row = db
      .prepare('SELECT id, project_id, number, name, color, resolve_color, obs_scene FROM cameras WHERE id = ?')
      .get(input.id) as CameraRow
    return rowToCamera(row)
  } else {
    // Insert new camera — foreign key enforcement will throw if projectId is invalid
    const id = randomUUID()
    db.prepare(
      'INSERT INTO cameras (id, project_id, number, name, color, resolve_color, obs_scene) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, input.projectId, input.number, input.name, input.color, input.resolveColor ?? null, input.obsScene ?? null)

    return {
      id,
      projectId: input.projectId,
      number: input.number,
      name: input.name,
      color: input.color,
      resolveColor: input.resolveColor ?? null,
      obsScene: input.obsScene ?? null,
    }
  }
}

export function deleteCamera(db: Database.Database, id: string): void {
  const result = db.prepare('DELETE FROM cameras WHERE id = ?').run(id)

  if (result.changes === 0) {
    throw new Error(`Camera not found: ${id}`)
  }
}
