import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from './index'
import { insertItem, listItems, targetColumnOf, updateItem } from './rundown-items'
import { createShot, splitShot } from '../ipc/shots'
import {
  exportDatabase,
  exportProject,
  exportRundown,
  importDatabase,
  importProject,
  importRundown,
} from '../ipc/exportimport'
import { targetIdOf } from '../../shared/rundown-item'

function openMemoryDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  return db
}

/** A Project with one Camera and one Part, so an item can fill both targets. */
function seed(db: Database.Database, projectId = 'p1', rundownId = 'rd1'): void {
  db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(
    projectId,
    'Gig',
    1,
  )
  db.prepare(
    'INSERT INTO cameras (id, project_id, number, name, color, obs_scene) VALUES (?,?,?,?,?,?)',
  ).run(`cam-${projectId}`, projectId, 1, 'Wide', '#f00', 'Scene 1')
  db.prepare('INSERT INTO parts (id, project_id, number, name, color) VALUES (?,?,?,?,?)').run(
    `pt-${projectId}`,
    projectId,
    1,
    'gitara',
    '#0f0',
  )
  db.prepare(
    'INSERT INTO rundowns (id, project_id, name, created_at, order_index, kind) VALUES (?,?,?,?,?,?)',
  ).run(rundownId, projectId, 'Set', 1, 0, 'camera')
}

/** Reads a stored row with `SELECT *`, so a column nobody wrote still shows up. */
function rawRow(db: Database.Database, id: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM shots WHERE id = ?').get(id) as Record<string, unknown>
}

function columnsOfShots(db: Database.Database): string[] {
  const rows = db.prepare('PRAGMA table_info(shots)').all() as { name: string }[]
  return rows.map((r) => r.name)
}

// ---------------------------------------------------------------------------
// Every writer carries every column
// ---------------------------------------------------------------------------

/**
 * One way an item gets written, set up to carry a value in all nine columns.
 *
 * `part_id` was once dropped by update and split (16a9674) and the export pair
 * dropped Kind, Parts and Calls (34fc215) — the same bug, once per writer,
 * because each writer spelled the column list out for itself. Comparing a whole
 * `SELECT *` row against a full expectation here means the next added column
 * fails in this one table instead of in whichever writer forgot it.
 */
interface WriterCase {
  name: string
  write: (db: Database.Database) => { actual: Record<string, unknown>; expected: unknown }
}

/** The item every case writes, before any id remapping an import performs. */
const FULL_ITEM = {
  duration_ms: 5000,
  label: 'intro riff',
  transition_name: 'dissolve',
  transition_ms: 400,
}

const writers: WriterCase[] = [
  {
    name: 'insertItem',
    write: (db) => {
      seed(db)
      const item = insertItem(db, {
        id: 's1',
        rundownId: 'rd1',
        cameraId: 'cam-p1',
        partId: 'pt-p1',
        durationMs: FULL_ITEM.duration_ms,
        label: FULL_ITEM.label,
        orderIndex: 3,
        transitionName: FULL_ITEM.transition_name,
        transitionMs: FULL_ITEM.transition_ms,
      })
      return {
        actual: rawRow(db, item.id),
        expected: {
          id: 's1',
          rundown_id: 'rd1',
          camera_id: 'cam-p1',
          part_id: 'pt-p1',
          order_index: 3,
          ...FULL_ITEM,
        },
      }
    },
  },
  {
    name: 'createShot',
    write: (db) => {
      seed(db)
      // Appends, so the position is the writer's own and not the caller's.
      insertItem(db, { rundownId: 'rd1', durationMs: 1000 })
      const item = createShot(db, {
        rundownId: 'rd1',
        cameraId: 'cam-p1',
        partId: 'pt-p1',
        durationMs: FULL_ITEM.duration_ms,
        label: FULL_ITEM.label,
        transitionName: FULL_ITEM.transition_name,
        transitionMs: FULL_ITEM.transition_ms,
      })
      return {
        actual: rawRow(db, item.id),
        expected: {
          id: item.id,
          rundown_id: 'rd1',
          camera_id: 'cam-p1',
          part_id: 'pt-p1',
          order_index: 1,
          ...FULL_ITEM,
        },
      }
    },
  },
  {
    name: 'splitShot (the half split off)',
    write: (db) => {
      seed(db)
      const item = insertItem(db, {
        id: 's1',
        rundownId: 'rd1',
        cameraId: 'cam-p1',
        partId: 'pt-p1',
        durationMs: FULL_ITEM.duration_ms,
        label: FULL_ITEM.label,
        orderIndex: 0,
        transitionName: FULL_ITEM.transition_name,
        transitionMs: FULL_ITEM.transition_ms,
      })
      const { second } = splitShot(db, { shotId: item.id, atMs: 2000 })
      return {
        actual: rawRow(db, second.id),
        expected: {
          id: second.id,
          rundown_id: 'rd1',
          // Both targets are inherited; the label and the in-Transition are not,
          // because the Transition belongs to the item transitioned *into* and
          // the first half keeps both.
          camera_id: 'cam-p1',
          part_id: 'pt-p1',
          duration_ms: 3000,
          label: null,
          order_index: 1,
          transition_name: null,
          transition_ms: 0,
        },
      }
    },
  },
  {
    name: 'importRundown',
    write: (db) => {
      seed(db)
      insertItem(db, {
        id: 's1',
        rundownId: 'rd1',
        cameraId: 'cam-p1',
        partId: 'pt-p1',
        durationMs: FULL_ITEM.duration_ms,
        label: FULL_ITEM.label,
        orderIndex: 0,
        transitionName: FULL_ITEM.transition_name,
        transitionMs: FULL_ITEM.transition_ms,
      })
      const payload = exportRundown(db, 'rd1')

      seed(db, 'p2', 'rd2')
      const rundownId = importRundown(db, 'p2', payload)
      const [imported] = listItems(db, rundownId)
      // A Part matches the receiving Project's own by name, and a Camera
      // matches on number — the portable identity. Both resolve to p2's own
      // rows, never to the exporting Project's.
      return {
        actual: rawRow(db, imported.id),
        expected: {
          id: imported.id,
          rundown_id: rundownId,
          camera_id: 'cam-p2',
          part_id: 'pt-p2',
          order_index: 0,
          ...FULL_ITEM,
        },
      }
    },
  },
  {
    name: 'importProject',
    write: (db) => {
      seed(db)
      insertItem(db, {
        id: 's1',
        rundownId: 'rd1',
        cameraId: 'cam-p1',
        partId: 'pt-p1',
        durationMs: FULL_ITEM.duration_ms,
        label: FULL_ITEM.label,
        orderIndex: 0,
        transitionName: FULL_ITEM.transition_name,
        transitionMs: FULL_ITEM.transition_ms,
      })
      const payload = exportProject(db, 'p1')

      const projectId = importProject(db, payload)
      const { id: rundownId } = db
        .prepare('SELECT id FROM rundowns WHERE project_id = ?')
        .get(projectId) as { id: string }
      const [imported] = listItems(db, rundownId)
      const { id: cameraId } = db
        .prepare('SELECT id FROM cameras WHERE project_id = ?')
        .get(projectId) as { id: string }
      const { id: partId } = db
        .prepare('SELECT id FROM parts WHERE project_id = ?')
        .get(projectId) as { id: string }
      return {
        actual: rawRow(db, imported.id),
        expected: {
          id: imported.id,
          rundown_id: rundownId,
          camera_id: cameraId,
          part_id: partId,
          order_index: 0,
          ...FULL_ITEM,
        },
      }
    },
  },
  {
    name: 'importDatabase',
    write: (db) => {
      seed(db)
      insertItem(db, {
        id: 's1',
        rundownId: 'rd1',
        cameraId: 'cam-p1',
        partId: 'pt-p1',
        durationMs: FULL_ITEM.duration_ms,
        label: FULL_ITEM.label,
        orderIndex: 0,
        transitionName: FULL_ITEM.transition_name,
        transitionMs: FULL_ITEM.transition_ms,
      })
      const payload = exportDatabase(db)

      // A whole-database restore keeps every id, so nothing is remapped.
      importDatabase(db, payload)
      return {
        actual: rawRow(db, 's1'),
        expected: {
          id: 's1',
          rundown_id: 'rd1',
          camera_id: 'cam-p1',
          part_id: 'pt-p1',
          order_index: 0,
          ...FULL_ITEM,
        },
      }
    },
  },
]

describe('every writer carries every column', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
  })

  afterEach(() => {
    db.close()
  })

  it.each(writers)('$name writes a row with every column', ({ write }) => {
    const { actual, expected } = write(db)
    expect(actual).toEqual(expected)
  })

  it('expects every column the shots table actually has', () => {
    // Guards the assertions above: a column added to the schema but left out of
    // the expectations would otherwise pass unnoticed in cases that happen to
    // default it.
    const columns = columnsOfShots(db).sort()
    for (const { write } of writers) {
      const fresh = openMemoryDb()
      try {
        expect(Object.keys(write(fresh).expected as object).sort()).toEqual(columns)
      } finally {
        fresh.close()
      }
    }
  })
})

// ---------------------------------------------------------------------------
// updateItem: absent vs null
// ---------------------------------------------------------------------------

describe('updateItem', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    seed(db)
  })

  afterEach(() => {
    db.close()
  })

  function full(): string {
    return insertItem(db, {
      id: 's1',
      rundownId: 'rd1',
      cameraId: 'cam-p1',
      partId: 'pt-p1',
      durationMs: 5000,
      label: 'intro riff',
      orderIndex: 0,
      transitionName: 'dissolve',
      transitionMs: 400,
    }).id
  }

  // Every nullable field obeys the one rule: absent leaves it alone, an explicit
  // null clears it (888272f — `??` collapsed the two, so nothing could ever be
  // unassigned again).
  const nullableFields = [
    { field: 'cameraId', column: 'camera_id', set: 'cam-p1' },
    { field: 'partId', column: 'part_id', set: 'pt-p1' },
    { field: 'label', column: 'label', set: 'chorus' },
    { field: 'transitionName', column: 'transition_name', set: 'cut' },
  ] as const

  it.each(nullableFields)('leaves $field alone when the patch omits it', ({ column }) => {
    const id = full()
    const before = rawRow(db, id)[column]
    updateItem(db, id, { durationMs: 7000 })
    expect(rawRow(db, id)[column]).toBe(before)
  })

  it.each(nullableFields)('clears $field when the patch sets it to null', ({ field, column }) => {
    const id = full()
    updateItem(db, id, { [field]: null })
    expect(rawRow(db, id)[column]).toBeNull()
  })

  it.each(nullableFields)('sets $field when the patch names a value', ({ field, column, set }) => {
    const id = full()
    updateItem(db, id, { [field]: set })
    expect(rawRow(db, id)[column]).toBe(set)
  })

  it('never moves an item, because position belongs to reorderItems', () => {
    const id = full()
    const updated = updateItem(db, id, { durationMs: 1 })
    expect(updated.orderIndex).toBe(0)
  })

  it('refuses an item that is not there', () => {
    expect(() => updateItem(db, 'nope', { durationMs: 1 })).toThrow('Shot not found: nope')
  })
})

// ---------------------------------------------------------------------------
// The Kind-to-column rule
// ---------------------------------------------------------------------------

describe('targetColumnOf', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    seed(db)
  })

  afterEach(() => {
    db.close()
  })

  it('assigns a Camera Rundown through camera_id', () => {
    expect(targetColumnOf('camera')).toBe('camera_id')
  })

  it('assigns a Voice-over Rundown through part_id', () => {
    expect(targetColumnOf('voice')).toBe('part_id')
  })

  it.each(['camera', 'voice'] as const)(
    'names the column holding the target a view reads for %s',
    (kind) => {
      const item = insertItem(db, {
        rundownId: 'rd1',
        cameraId: 'cam-p1',
        partId: 'pt-p1',
        durationMs: 1000,
      })
      // Both columns are filled, so a wrong answer here is invisible to a null
      // check and only shows up as the wrong Camera on air.
      expect(rawRow(db, item.id)[targetColumnOf(kind)]).toBe(targetIdOf(item, kind))
    },
  )
})
