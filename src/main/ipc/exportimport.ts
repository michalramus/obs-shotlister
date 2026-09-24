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
    shots: db
      .prepare('SELECT * FROM shots WHERE rundown_id = ? ORDER BY order_index ASC')
      .all(r.id),
    markers: db
      .prepare('SELECT * FROM markers WHERE rundown_id = ? ORDER BY position_ms ASC')
      .all(r.id),
    lyrics: db.prepare('SELECT * FROM lyrics WHERE rundown_id = ? ORDER BY start_ms ASC').all(r.id),
  }))
  // Parts come whole rather than per Rundown: scope is additive, so a Rundown's
  // Calls routinely point at Parts defined on the Project or on a folder.
  const parts = db
    .prepare('SELECT * FROM parts WHERE project_id = ? ORDER BY number ASC')
    .all(projectId)
  return { version: 1, project, cameras, parts, rundowns: rundownsWithShots }
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
  const lyrics = db
    .prepare('SELECT * FROM lyrics WHERE rundown_id = ? ORDER BY start_ms ASC')
    .all(rundownId)
  // Every Part the Rundown's Calls actually use, whatever scope defined it —
  // the importing Project may have none of them.
  const parts = db
    .prepare(
      `SELECT DISTINCT p.* FROM parts p
         JOIN shots s ON s.part_id = p.id
        WHERE s.rundown_id = ?
        ORDER BY p.number ASC`,
    )
    .all(rundownId)
  return { version: 1, rundown, shots, markers, lyrics, parts }
}

export function exportDatabase(db: Database.Database): object {
  const projects = db.prepare('SELECT * FROM projects ORDER BY created_at ASC').all()
  const cameras = db.prepare('SELECT * FROM cameras ORDER BY number ASC').all()
  const rundowns = db
    .prepare('SELECT * FROM rundowns ORDER BY order_index ASC, created_at ASC')
    .all()
  const shots = db.prepare('SELECT * FROM shots ORDER BY order_index ASC').all()
  const markers = db.prepare('SELECT * FROM markers ORDER BY position_ms ASC').all()
  const parts = db.prepare('SELECT * FROM parts ORDER BY number ASC').all()
  const lyrics = db.prepare('SELECT * FROM lyrics ORDER BY start_ms ASC').all()
  return { version: 1, projects, cameras, parts, rundowns, shots, markers, lyrics }
}

// --- Import ---

// Camera collision: match by number within project, reuse existing ID
export function importProject(db: Database.Database, data: any): string {
  const projectId = randomUUID()
  const now = Date.now()
  db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(
    projectId,
    data.project?.name ?? 'Imported Project',
    now,
  )

  // Build camera ID mapping: oldId -> newId
  const cameraIdMap = new Map<string, string>()
  for (const cam of data.cameras ?? []) {
    const newId = randomUUID()
    db.prepare(
      'INSERT OR IGNORE INTO cameras (id, project_id, number, name, color, resolve_color, obs_scene) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
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

  // Parts are written before the Rundowns whose Calls point at them, and
  // Rundown-scoped ones are deferred until their Rundown exists.
  const partIdMap = new Map<string, string>()
  const deferredParts: any[] = []
  for (const part of data.parts ?? []) {
    if (part.rundown_id) {
      deferredParts.push(part)
      continue
    }
    const newId = randomUUID()
    insertPart(db, newId, projectId, part)
    partIdMap.set(part.id, newId)
  }

  const rundownIdMap = new Map<string, string>()
  for (const rd of data.rundowns ?? []) {
    const rundownId = randomUUID()
    rundownIdMap.set(rd.id, rundownId)
    db.prepare(
      'INSERT INTO rundowns (id, project_id, name, created_at, order_index, folder, kind) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      rundownId,
      projectId,
      rd.name,
      now,
      rd.order_index ?? 0,
      rd.folder ?? null,
      rd.kind === 'voice' ? 'voice' : 'camera',
    )
  }

  // Now every Rundown exists, so the Rundown-scoped Parts can be placed and
  // their ids are known before any Call is written.
  for (const part of deferredParts) {
    const newId = randomUUID()
    insertPart(db, newId, projectId, {
      ...part,
      rundown_id: rundownIdMap.get(part.rundown_id) ?? null,
    })
    partIdMap.set(part.id, newId)
  }

  for (const rd of data.rundowns ?? []) {
    const rundownId = rundownIdMap.get(rd.id) as string
    for (const shot of rd.shots ?? []) {
      db.prepare(
        'INSERT INTO shots (id, rundown_id, camera_id, part_id, duration_ms, label, order_index, transition_name, transition_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        randomUUID(),
        rundownId,
        shot.camera_id ? (cameraIdMap.get(shot.camera_id) ?? shot.camera_id) : null,
        shot.part_id ? (partIdMap.get(shot.part_id) ?? null) : null,
        shot.duration_ms,
        shot.label ?? null,
        shot.order_index,
        shot.transition_name ?? null,
        shot.transition_ms ?? 0,
      )
    }
    for (const marker of rd.markers ?? []) {
      db.prepare(
        'INSERT INTO markers (id, rundown_id, position_ms, label) VALUES (?, ?, ?, ?)',
      ).run(randomUUID(), rundownId, marker.position_ms, marker.label ?? null)
    }
    for (const lyric of rd.lyrics ?? []) {
      db.prepare(
        'INSERT INTO lyrics (id, rundown_id, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)',
      ).run(randomUUID(), rundownId, lyric.start_ms, lyric.end_ms, lyric.text)
    }
  }
  return projectId
}

/**
 * Writes one imported Part, giving it a free number in the target Project.
 *
 * `number` is unique per Project, and an import lands beside whatever is
 * already there, so the exported number is a preference rather than a promise.
 */
function insertPart(db: Database.Database, id: string, projectId: string, part: any): void {
  const taken = db.prepare('SELECT number FROM parts WHERE project_id = ?').all(projectId) as {
    number: number
  }[]
  const used = new Set(taken.map((r) => r.number))
  let number = part.number ?? 1
  while (used.has(number)) number++

  db.prepare(
    'INSERT INTO parts (id, project_id, number, name, color, folder, rundown_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    projectId,
    number,
    part.name,
    part.color ?? '#888888',
    part.folder ?? null,
    part.rundown_id ?? null,
  )
}

export function importRundown(db: Database.Database, projectId: string, data: any): string {
  const rundownId = randomUUID()
  const now = Date.now()
  const existingCameras: any[] = db
    .prepare('SELECT * FROM cameras WHERE project_id = ?')
    .all(projectId) as any[]
  const camByNumber = new Map<number, string>(existingCameras.map((c: any) => [c.number, c.id]))

  db.prepare(
    'INSERT INTO rundowns (id, project_id, name, created_at, order_index, folder, kind) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    rundownId,
    projectId,
    data.rundown?.name ?? 'Imported Rundown',
    now,
    0,
    null,
    data.rundown?.kind === 'voice' ? 'voice' : 'camera',
  )

  // Parts match on name within the Project, the way Cameras match on number:
  // importing the same song twice must not fork "gitara" into two Parts, each
  // with its own rendered clip.
  const existingParts: any[] = db
    .prepare('SELECT * FROM parts WHERE project_id = ?')
    .all(projectId) as any[]
  const partByName = new Map<string, string>(
    existingParts.map((p: any) => [String(p.name).toLowerCase(), p.id]),
  )
  const partIdMap = new Map<string, string>()
  for (const part of data.parts ?? []) {
    const match = partByName.get(String(part.name).toLowerCase())
    if (match) {
      partIdMap.set(part.id, match)
      continue
    }
    const newId = randomUUID()
    // Imported Parts land at Project scope: the folder or Rundown they were
    // scoped to does not exist here, and a Part nothing can see is worse than
    // one that is merely visible too widely.
    insertPart(db, newId, projectId, { ...part, folder: null, rundown_id: null })
    partIdMap.set(part.id, newId)
    partByName.set(String(part.name).toLowerCase(), newId)
  }

  for (const shot of data.shots ?? []) {
    const importedCams: any[] = data.cameras ?? []
    const importedCam = importedCams.find((c: any) => c.id === shot.camera_id)
    const targetCameraId = importedCam
      ? (camByNumber.get(importedCam.number) ?? shot.camera_id)
      : shot.camera_id
    db.prepare(
      'INSERT INTO shots (id, rundown_id, camera_id, part_id, duration_ms, label, order_index, transition_name, transition_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      randomUUID(),
      rundownId,
      shot.camera_id ? targetCameraId : null,
      shot.part_id ? (partIdMap.get(shot.part_id) ?? null) : null,
      shot.duration_ms,
      shot.label ?? null,
      shot.order_index,
      shot.transition_name ?? null,
      shot.transition_ms ?? 0,
    )
  }
  for (const marker of data.markers ?? []) {
    db.prepare('INSERT INTO markers (id, rundown_id, position_ms, label) VALUES (?, ?, ?, ?)').run(
      randomUUID(),
      rundownId,
      marker.position_ms,
      marker.label ?? null,
    )
  }
  for (const lyric of data.lyrics ?? []) {
    db.prepare(
      'INSERT INTO lyrics (id, rundown_id, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)',
    ).run(randomUUID(), rundownId, lyric.start_ms, lyric.end_ms, lyric.text)
  }
  return rundownId
}

export function importDatabase(db: Database.Database, data: any): void {
  db.transaction(() => {
    db.exec('DELETE FROM lyrics')
    db.exec('DELETE FROM markers')
    db.exec('DELETE FROM shots')
    db.exec('DELETE FROM parts')
    db.exec('DELETE FROM rundowns')
    db.exec('DELETE FROM cameras')
    db.exec('DELETE FROM projects')
    db.exec("UPDATE live_state SET rundown_id=NULL, skipped_ids='[]', project_id=NULL WHERE id=1")

    for (const p of data.projects ?? []) {
      db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(
        p.id,
        p.name,
        p.created_at,
      )
    }
    for (const c of data.cameras ?? []) {
      db.prepare(
        'INSERT INTO cameras (id, project_id, number, name, color, resolve_color, obs_scene) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
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
      db.prepare(
        'INSERT INTO rundowns (id, project_id, name, created_at, order_index, folder, kind) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        r.id,
        r.project_id,
        r.name,
        r.created_at,
        r.order_index ?? 0,
        r.folder ?? null,
        r.kind === 'voice' ? 'voice' : 'camera',
      )
    }
    // After the Rundowns a Rundown-scoped Part points at, before the Calls that
    // point at the Part. Ids are preserved wholesale here, so nothing is remapped.
    for (const p of data.parts ?? []) {
      db.prepare(
        'INSERT INTO parts (id, project_id, number, name, color, folder, rundown_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        p.id,
        p.project_id,
        p.number,
        p.name,
        p.color ?? '#888888',
        p.folder ?? null,
        p.rundown_id ?? null,
      )
    }
    for (const s of data.shots ?? []) {
      db.prepare(
        'INSERT INTO shots (id, rundown_id, camera_id, part_id, duration_ms, label, order_index, transition_name, transition_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        s.id,
        s.rundown_id,
        s.camera_id ?? null,
        s.part_id ?? null,
        s.duration_ms,
        s.label ?? null,
        s.order_index,
        s.transition_name ?? null,
        s.transition_ms ?? 0,
      )
    }
    for (const l of data.lyrics ?? []) {
      db.prepare(
        'INSERT INTO lyrics (id, rundown_id, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)',
      ).run(l.id, l.rundown_id, l.start_ms, l.end_ms, l.text)
    }
    for (const m of data.markers ?? []) {
      db.prepare(
        'INSERT INTO markers (id, rundown_id, position_ms, label) VALUES (?, ?, ?, ?)',
      ).run(m.id, m.rundown_id, m.position_ms, m.label ?? null)
    }
  })()
}
