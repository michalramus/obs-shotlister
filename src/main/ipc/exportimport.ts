/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'

// --- Export ---

export function exportProject(db: Database.Database, projectId: string): object {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId)
  if (!project) throw new Error(`Project ${projectId} not found`)
  const cameras = db.prepare('SELECT * FROM cameras WHERE project_id = ?').all(projectId)
  const rundowns = db
    .prepare('SELECT * FROM rundowns WHERE project_id = ? ORDER BY order_index ASC, created_at ASC')
    .all(projectId)
  const rundownsWithShots = rundowns.map((r: any) => ({
    ...r,
    shots: db.prepare('SELECT * FROM shots WHERE rundown_id = ? ORDER BY order_index ASC').all(r.id),
    markers: db
      .prepare('SELECT * FROM markers WHERE rundown_id = ? ORDER BY position_ms ASC')
      .all(r.id),
  }))
  return { version: 1, project, cameras, rundowns: rundownsWithShots }
}

export function exportRundown(db: Database.Database, rundownId: string): object {
  const rundown = db.prepare('SELECT * FROM rundowns WHERE id = ?').get(rundownId)
  if (!rundown) throw new Error(`Rundown ${rundownId} not found`)
  const shots = db
    .prepare('SELECT * FROM shots WHERE rundown_id = ? ORDER BY order_index ASC')
    .all(rundownId)
  const markers = db
    .prepare('SELECT * FROM markers WHERE rundown_id = ? ORDER BY position_ms ASC')
    .all(rundownId)
  return { version: 1, rundown, shots, markers }
}

export function exportDatabase(db: Database.Database): object {
  const projects = db.prepare('SELECT * FROM projects ORDER BY created_at ASC').all()
  const cameras = db.prepare('SELECT * FROM cameras ORDER BY number ASC').all()
  const rundowns = db
    .prepare('SELECT * FROM rundowns ORDER BY order_index ASC, created_at ASC')
    .all()
  const shots = db.prepare('SELECT * FROM shots ORDER BY order_index ASC').all()
  const markers = db.prepare('SELECT * FROM markers ORDER BY position_ms ASC').all()
  return { version: 1, projects, cameras, rundowns, shots, markers }
}

// --- Import ---

// Camera collision: match by number within project, reuse existing ID
export function importProject(db: Database.Database, data: any): string {
  const projectId = randomUUID()
  const now = Date.now()
  db
    .prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)')
    .run(projectId, data.project?.name ?? 'Imported Project', now)

  // Build camera ID mapping: oldId -> newId
  const cameraIdMap = new Map<string, string>()
  for (const cam of data.cameras ?? []) {
    const newId = randomUUID()
    db
      .prepare(
        'INSERT OR IGNORE INTO cameras (id, project_id, number, name, color, resolve_color, obs_scene) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        newId,
        projectId,
        cam.number,
        cam.name,
        cam.color,
        cam.resolve_color ?? null,
        cam.obs_scene ?? null,
      )
    cameraIdMap.set(cam.id, newId)
  }

  for (const rd of data.rundowns ?? []) {
    const rundownId = randomUUID()
    db
      .prepare(
        'INSERT INTO rundowns (id, project_id, name, created_at, order_index, folder) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(rundownId, projectId, rd.name, now, rd.order_index ?? 0, rd.folder ?? null)
    for (const shot of rd.shots ?? []) {
      const newCameraId = cameraIdMap.get(shot.camera_id) ?? shot.camera_id
      db
        .prepare(
          'INSERT INTO shots (id, rundown_id, camera_id, duration_ms, label, order_index, transition_name, transition_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          randomUUID(),
          rundownId,
          newCameraId,
          shot.duration_ms,
          shot.label ?? null,
          shot.order_index,
          shot.transition_name ?? null,
          shot.transition_ms ?? 0,
        )
    }
    for (const marker of rd.markers ?? []) {
      db
        .prepare('INSERT INTO markers (id, rundown_id, position_ms, label) VALUES (?, ?, ?, ?)')
        .run(randomUUID(), rundownId, marker.position_ms, marker.label ?? null)
    }
  }
  return projectId
}

export function importRundown(db: Database.Database, projectId: string, data: any): string {
  const rundownId = randomUUID()
  const now = Date.now()
  const existingCameras: any[] = db
    .prepare('SELECT * FROM cameras WHERE project_id = ?')
    .all(projectId) as any[]
  const camByNumber = new Map<number, string>(existingCameras.map((c: any) => [c.number, c.id]))

  db
    .prepare(
      'INSERT INTO rundowns (id, project_id, name, created_at, order_index, folder) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(rundownId, projectId, data.rundown?.name ?? 'Imported Rundown', now, 0, null)
  for (const shot of data.shots ?? []) {
    const importedCams: any[] = data.cameras ?? []
    const importedCam = importedCams.find((c: any) => c.id === shot.camera_id)
    const targetCameraId = importedCam
      ? (camByNumber.get(importedCam.number) ?? shot.camera_id)
      : shot.camera_id
    db
      .prepare(
        'INSERT INTO shots (id, rundown_id, camera_id, duration_ms, label, order_index, transition_name, transition_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        randomUUID(),
        rundownId,
        targetCameraId,
        shot.duration_ms,
        shot.label ?? null,
        shot.order_index,
        shot.transition_name ?? null,
        shot.transition_ms ?? 0,
      )
  }
  for (const marker of data.markers ?? []) {
    db
      .prepare('INSERT INTO markers (id, rundown_id, position_ms, label) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), rundownId, marker.position_ms, marker.label ?? null)
  }
  return rundownId
}

export function importDatabase(db: Database.Database, data: any): void {
  db.transaction(() => {
    db.exec('DELETE FROM markers')
    db.exec('DELETE FROM shots')
    db.exec('DELETE FROM rundowns')
    db.exec('DELETE FROM cameras')
    db.exec('DELETE FROM projects')
    db.exec(
      "UPDATE live_state SET rundown_id=NULL, live_shot_id=NULL, started_at=NULL, running=0, skipped_ids='[]', project_id=NULL WHERE id=1",
    )

    for (const p of data.projects ?? []) {
      db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(
        p.id,
        p.name,
        p.created_at,
      )
    }
    for (const c of data.cameras ?? []) {
      db
        .prepare(
          'INSERT INTO cameras (id, project_id, number, name, color, resolve_color, obs_scene) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          c.id,
          c.project_id,
          c.number,
          c.name,
          c.color,
          c.resolve_color ?? null,
          c.obs_scene ?? null,
        )
    }
    for (const r of data.rundowns ?? []) {
      db
        .prepare(
          'INSERT INTO rundowns (id, project_id, name, created_at, order_index, folder) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(r.id, r.project_id, r.name, r.created_at, r.order_index ?? 0, r.folder ?? null)
    }
    for (const s of data.shots ?? []) {
      db
        .prepare(
          'INSERT INTO shots (id, rundown_id, camera_id, duration_ms, label, order_index, transition_name, transition_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          s.id,
          s.rundown_id,
          s.camera_id,
          s.duration_ms,
          s.label ?? null,
          s.order_index,
          s.transition_name ?? null,
          s.transition_ms ?? 0,
        )
    }
    for (const m of data.markers ?? []) {
      db
        .prepare('INSERT INTO markers (id, rundown_id, position_ms, label) VALUES (?, ?, ?, ?)')
        .run(m.id, m.rundown_id, m.position_ms, m.label ?? null)
    }
  })()
}
