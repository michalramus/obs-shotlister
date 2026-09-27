// Import reads whatever JSON the operator hands over: every table's rows arrive
// untyped here, so the payloads and the per-table row objects stay `any`. Items
// are the exception — they go through src/main/db/rundown-items.ts, which knows
// the columns.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { allItemRows, insertItem, listItemRows } from '../db/rundown-items'
import type { ImportedItemRow, NewRundownItem } from '../db/rundown-items'

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
    shots: listItemRows(db, r.id),
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
  const shots = listItemRows(db, rundownId)
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
  // Without these the importer has nothing to match on and binds every Shot to
  // the source database's camera ids — which name another Project's Cameras on
  // the same machine, and nothing at all on a different one.
  const cameras = db
    .prepare(
      `SELECT DISTINCT c.* FROM cameras c
         JOIN shots s ON s.camera_id = c.id
        WHERE s.rundown_id = ?
        ORDER BY c.number ASC`,
    )
    .all(rundownId)
  return { version: 1, rundown, cameras, shots, markers, lyrics, parts }
}

export function exportDatabase(db: Database.Database): object {
  const projects = db.prepare('SELECT * FROM projects ORDER BY created_at ASC').all()
  const cameras = db.prepare('SELECT * FROM cameras ORDER BY number ASC').all()
  const rundowns = db
    .prepare('SELECT * FROM rundowns ORDER BY order_index ASC, created_at ASC')
    .all()
  const shots = allItemRows(db)
  const markers = db.prepare('SELECT * FROM markers ORDER BY position_ms ASC').all()
  const parts = db.prepare('SELECT * FROM parts ORDER BY number ASC').all()
  const lyrics = db.prepare('SELECT * FROM lyrics ORDER BY start_ms ASC').all()
  return { version: 1, projects, cameras, parts, rundowns, shots, markers, lyrics }
}

// --- Import ---

// The file picker filters on *.json, which is a far wider net than "a file this
// app wrote": an OBS scene collection, a package.json and a rundown export all
// pass it. Every import therefore proves the payload is ours before touching a
// row — importDatabase in particular used to delete seven tables first and read
// the payload afterwards, so the wrong pick emptied the database outright.
function assertImportShape(data: unknown, required: readonly string[], what: string): void {
  if (typeof data !== 'object' || data === null) {
    throw new Error(`This file is not a Shotlister ${what} export.`)
  }
  const obj = data as Record<string, unknown>
  if (obj['version'] !== 1) {
    const found = obj['version'] === undefined ? 'none' : String(obj['version'])
    throw new Error(
      `This file is not a Shotlister ${what} export (export format version: ${found}).`,
    )
  }
  for (const key of required) {
    if (!(key in obj) || obj[key] === null || obj[key] === undefined) {
      throw new Error(`This ${what} export is missing its "${key}" section and cannot be imported.`)
    }
  }
}

// Camera collision: match by number within project, reuse existing ID
export function importProject(db: Database.Database, data: any): string {
  assertImportShape(data, ['project'], 'project')
  // One transaction, as importDatabase already had: a lyric missing its text
  // used to throw only after the project, its cameras, its rundowns and its
  // shots were committed, leaving a half-imported project to be found and
  // deleted by hand.
  return db.transaction(() => importProjectRows(db, data))()
}

function importProjectRows(db: Database.Database, data: any): string {
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
      insertItem(db, {
        ...itemFieldsFrom(shot),
        rundownId,
        cameraId: shot.camera_id ? (cameraIdMap.get(shot.camera_id) ?? shot.camera_id) : null,
        partId: shot.part_id ? (partIdMap.get(shot.part_id) ?? null) : null,
      })
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
 * An exported item row read back as fields for {@link insertItem}.
 *
 * Whatever the row does not carry gets the same default the live writers use,
 * and the caller overrides only what an import has to remap — the Rundown and
 * the targets. Adding a column reaches every import path through here.
 */
function itemFieldsFrom(shot: ImportedItemRow): NewRundownItem {
  return {
    rundownId: shot.rundown_id as string,
    cameraId: shot.camera_id ?? null,
    partId: shot.part_id ?? null,
    durationMs: shot.duration_ms as number,
    label: shot.label ?? null,
    orderIndex: shot.order_index as number,
    transitionName: shot.transition_name ?? null,
    transitionMs: shot.transition_ms ?? 0,
  }
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
  assertImportShape(data, ['rundown'], 'rundown')
  return db.transaction(() => importRundownRows(db, projectId, data))()
}

function importRundownRows(db: Database.Database, projectId: string, data: any): string {
  const rundownId = randomUUID()
  const now = Date.now()
  const existingCameras: any[] = db
    .prepare('SELECT * FROM cameras WHERE project_id = ?')
    .all(projectId) as any[]
  const camByNumber = new Map<number, string>(existingCameras.map((c: any) => [c.number, c.id]))
  const camIdsHere = new Set<string>(existingCameras.map((c: any) => String(c.id)))

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
    // Camera number is the portable identity; the id is not. An unmatched
    // Camera leaves the Shot unassigned rather than pointing at a row in
    // another Project — a Shot the operator can see and fix beats a Shot whose
    // Camera silently resolves to nothing in the shotlist, the phone view and
    // the OBS switcher.
    const targetCameraId = importedCam
      ? (camByNumber.get(importedCam.number) ?? null)
      : // Exports written before Rundown export carried `cameras` have no
        // number to match on; keep the id only if it names a Camera here.
        camIdsHere.has(String(shot.camera_id))
        ? shot.camera_id
        : null
    insertItem(db, {
      ...itemFieldsFrom(shot),
      rundownId,
      cameraId: shot.camera_id ? targetCameraId : null,
      partId: shot.part_id ? (partIdMap.get(shot.part_id) ?? null) : null,
    })
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
  // Before the transaction, not inside it: the check exists so a wrong pick is
  // refused outright, and refusing is clearer than rolling back.
  assertImportShape(data, ['projects', 'cameras', 'rundowns', 'shots'], 'database')
  for (const key of ['projects', 'cameras', 'rundowns', 'shots', 'markers', 'parts', 'lyrics']) {
    const value = data[key]
    if (value !== undefined && !Array.isArray(value)) {
      throw new Error(`This database export is malformed: "${key}" is not a list.`)
    }
  }
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
      // Ids are preserved wholesale in a whole-database restore, so the item
      // keeps its own id and Rundown rather than being remapped.
      insertItem(db, { ...itemFieldsFrom(s), id: s.id, rundownId: s.rundown_id })
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
