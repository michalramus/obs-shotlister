import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db/index'
import {
  listParts,
  listPartsInScope,
  getPart,
  upsertPart,
  deletePart,
  promotePart,
  setPartsColor,
  renameFolder,
} from './parts'

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

function insertRundown(
  db: Database.Database,
  id: string,
  projectId: string,
  name: string,
  folder: string | null = null,
): void {
  db.prepare(
    'INSERT INTO rundowns (id, project_id, name, created_at, order_index, folder, kind) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, projectId, name, 1000, 0, folder, 'voice')
}

function insertPart(
  db: Database.Database,
  id: string,
  projectId: string,
  number: number,
  name: string,
  folder: string | null = null,
  rundownId: string | null = null,
  color = '#e74c3c',
): void {
  db.prepare(
    'INSERT INTO parts (id, project_id, number, name, color, folder, rundown_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, projectId, number, name, color, folder, rundownId)
}

function insertCall(
  db: Database.Database,
  id: string,
  rundownId: string,
  partId: string | null,
  orderIndex = 0,
): void {
  db.prepare(
    'INSERT INTO shots (id, rundown_id, camera_id, part_id, duration_ms, label, order_index, transition_ms) VALUES (?, ?, NULL, ?, ?, NULL, ?, 0)',
  ).run(id, rundownId, partId, 5000, orderIndex)
}

function names(parts: { name: string }[]): string[] {
  return parts.map((p) => p.name)
}

// ---------------------------------------------------------------------------
// listParts
// ---------------------------------------------------------------------------

describe('listParts', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1', 'Band A')
    insertProject(db, 'p2', 'Band B')
  })

  afterEach(() => {
    db.close()
  })

  it('returns empty array when project has no parts', () => {
    expect(listParts(db, 'p1')).toEqual([])
  })

  it('returns every part in the project regardless of scope, ordered by number', () => {
    insertRundown(db, 'rd-1', 'p1', 'Song 1', 'Band A')
    insertPart(db, 'pt-3', 'p1', 3, 'solo', null, 'rd-1')
    insertPart(db, 'pt-1', 'p1', 1, 'gitara')
    insertPart(db, 'pt-2', 'p1', 2, 'wokal 1', 'Band A')
    insertPart(db, 'pt-x', 'p2', 1, 'other project')

    expect(names(listParts(db, 'p1'))).toEqual(['gitara', 'wokal 1', 'solo'])
  })

  it('maps scope columns onto the Part shape', () => {
    insertRundown(db, 'rd-1', 'p1', 'Song 1', 'Band A')
    insertPart(db, 'pt-1', 'p1', 1, 'gitara', null, 'rd-1', '#3498db')

    expect(listParts(db, 'p1')[0]).toEqual({
      id: 'pt-1',
      projectId: 'p1',
      number: 1,
      name: 'gitara',
      color: '#3498db',
      folder: null,
      rundownId: 'rd-1',
    })
  })
})

// ---------------------------------------------------------------------------
// listPartsInScope — the additive union of ADR 0006
// ---------------------------------------------------------------------------

describe('listPartsInScope', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1', 'Band A')
    insertRundown(db, 'rd-1', 'p1', 'Song 1', 'Band A')
    insertRundown(db, 'rd-2', 'p1', 'Song 2', 'Band A')
    insertRundown(db, 'rd-3', 'p1', 'Song 3', 'Band B')
    insertRundown(db, 'rd-loose', 'p1', 'Loose song', null)
  })

  afterEach(() => {
    db.close()
  })

  it('returns project, folder and own parts, ordered by number', () => {
    insertPart(db, 'pt-1', 'p1', 1, 'refren')
    insertPart(db, 'pt-2', 'p1', 2, 'wokal 1', 'Band A')
    insertPart(db, 'pt-3', 'p1', 3, 'gitara', null, 'rd-1')

    expect(names(listPartsInScope(db, 'rd-1'))).toEqual(['refren', 'wokal 1', 'gitara'])
  })

  it('does not return another folder’s parts', () => {
    insertPart(db, 'pt-1', 'p1', 1, 'refren')
    insertPart(db, 'pt-2', 'p1', 2, 'other folder', 'Band B')

    expect(names(listPartsInScope(db, 'rd-1'))).toEqual(['refren'])
  })

  it('does not return another rundown’s parts', () => {
    insertPart(db, 'pt-1', 'p1', 1, 'mine', null, 'rd-1')
    insertPart(db, 'pt-2', 'p1', 2, 'theirs', null, 'rd-2')

    expect(names(listPartsInScope(db, 'rd-1'))).toEqual(['mine'])
  })

  it('shares folder parts between rundowns in the same folder', () => {
    insertPart(db, 'pt-1', 'p1', 1, 'wokal 1', 'Band A')

    expect(names(listPartsInScope(db, 'rd-1'))).toEqual(['wokal 1'])
    expect(names(listPartsInScope(db, 'rd-2'))).toEqual(['wokal 1'])
  })

  it('gives a rundown with no folder only project-scoped and its own parts', () => {
    insertPart(db, 'pt-1', 'p1', 1, 'refren')
    insertPart(db, 'pt-2', 'p1', 2, 'foldered', 'Band A')
    insertPart(db, 'pt-3', 'p1', 3, 'own', null, 'rd-loose')

    expect(names(listPartsInScope(db, 'rd-loose'))).toEqual(['refren', 'own'])
  })

  it('does not return parts from another project', () => {
    insertProject(db, 'p2', 'Band B')
    insertPart(db, 'pt-1', 'p1', 1, 'refren')
    insertPart(db, 'pt-2', 'p2', 1, 'other project')

    expect(names(listPartsInScope(db, 'rd-1'))).toEqual(['refren'])
  })

  it('throws for an unknown rundown', () => {
    expect(() => listPartsInScope(db, 'nope')).toThrow(/Rundown not found/)
  })
})

// ---------------------------------------------------------------------------
// upsertPart
// ---------------------------------------------------------------------------

describe('upsertPart', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1', 'Band A')
    insertRundown(db, 'rd-1', 'p1', 'Song 1', 'Band A')
  })

  afterEach(() => {
    db.close()
  })

  it('creates a project-scoped part by default', () => {
    const part = upsertPart(db, { projectId: 'p1', name: 'gitara' })

    expect(part.folder).toBeNull()
    expect(part.rundownId).toBeNull()
    expect(getPart(db, part.id)).toEqual(part)
  })

  it('maps a rundown scope onto rundown_id', () => {
    const part = upsertPart(db, {
      projectId: 'p1',
      name: 'gitara',
      scope: { kind: 'rundown', rundownId: 'rd-1' },
    })

    expect(part.rundownId).toBe('rd-1')
    expect(part.folder).toBeNull()
  })

  it('maps a folder scope onto folder', () => {
    const part = upsertPart(db, {
      projectId: 'p1',
      name: 'wokal 1',
      scope: { kind: 'folder', folder: 'Band A' },
    })

    expect(part.folder).toBe('Band A')
    expect(part.rundownId).toBeNull()
  })

  it('assigns numbers from 1 upwards', () => {
    expect(upsertPart(db, { projectId: 'p1', name: 'a' }).number).toBe(1)
    expect(upsertPart(db, { projectId: 'p1', name: 'b' }).number).toBe(2)
  })

  it('assigns the lowest free number, filling gaps', () => {
    insertPart(db, 'pt-1', 'p1', 1, 'a')
    insertPart(db, 'pt-3', 'p1', 3, 'c')

    expect(upsertPart(db, { projectId: 'p1', name: 'b' }).number).toBe(2)
  })

  it('counts numbers across every scope, so UNIQUE(project_id, number) holds', () => {
    insertPart(db, 'pt-1', 'p1', 1, 'project scoped')
    insertPart(db, 'pt-2', 'p1', 2, 'folder scoped', 'Band A')
    insertPart(db, 'pt-3', 'p1', 3, 'rundown scoped', null, 'rd-1')

    const created = upsertPart(db, {
      projectId: 'p1',
      name: 'new',
      scope: { kind: 'rundown', rundownId: 'rd-1' },
    })

    expect(created.number).toBe(4)
    expect(listParts(db, 'p1').map((p) => p.number)).toEqual([1, 2, 3, 4])
  })

  it('numbers restart per project', () => {
    insertProject(db, 'p2', 'Band B')
    insertPart(db, 'pt-1', 'p1', 1, 'a')

    expect(upsertPart(db, { projectId: 'p2', name: 'a' }).number).toBe(1)
  })

  it('rejects an explicit number already taken in the project', () => {
    insertPart(db, 'pt-1', 'p1', 1, 'a')

    expect(() => upsertPart(db, { projectId: 'p1', number: 1, name: 'b' })).toThrow()
  })

  it('picks a default colour and keeps new parts distinct', () => {
    const first = upsertPart(db, { projectId: 'p1', name: 'a' })
    const second = upsertPart(db, { projectId: 'p1', name: 'b' })

    expect(first.color).toMatch(/^#[0-9a-f]{6}$/i)
    expect(second.color).not.toBe(first.color)
  })

  it('honours an explicit colour', () => {
    expect(upsertPart(db, { projectId: 'p1', name: 'a', color: '#123456' }).color).toBe('#123456')
  })

  it('rejects an empty name', () => {
    expect(() => upsertPart(db, { projectId: 'p1', name: '' })).toThrow(/must not be empty/)
  })

  it('rejects a whitespace-only name', () => {
    expect(() => upsertPart(db, { projectId: 'p1', name: '   ' })).toThrow(/must not be empty/)
  })

  it('updates an existing part in place', () => {
    insertPart(db, 'pt-1', 'p1', 1, 'gitara')

    const updated = upsertPart(db, { id: 'pt-1', projectId: 'p1', name: 'gitara solo' })

    expect(updated.id).toBe('pt-1')
    expect(updated.name).toBe('gitara solo')
    expect(listParts(db, 'p1')).toHaveLength(1)
  })

  it('keeps number, colour and scope when an update omits them', () => {
    insertPart(db, 'pt-1', 'p1', 7, 'gitara', 'Band A', null, '#abcdef')

    const updated = upsertPart(db, { id: 'pt-1', projectId: 'p1', name: 'gitara solo' })

    expect(updated.number).toBe(7)
    expect(updated.color).toBe('#abcdef')
    expect(updated.folder).toBe('Band A')
  })

  it('leaves the part_renders row alone on rename, so the part reads stale and not missing', () => {
    insertPart(db, 'pt-1', 'p1', 1, 'gitara')
    db.prepare('INSERT INTO tts_clips (hash, text, voice, engine, duration_ms) VALUES (?, ?, ?, ?, ?)').run(
      'h1',
      'gitara za',
      'pl',
      'piper',
      800,
    )
    db.prepare('INSERT INTO part_renders (part_id, voice, engine, hash) VALUES (?, ?, ?, ?)').run(
      'pt-1',
      'pl',
      'piper',
      'h1',
    )

    upsertPart(db, { id: 'pt-1', projectId: 'p1', name: 'gitara solo' })

    const render = db.prepare('SELECT hash FROM part_renders WHERE part_id = ?').get('pt-1') as
      | { hash: string }
      | undefined
    expect(render?.hash).toBe('h1')
  })

  it('throws when updating a part that does not exist', () => {
    expect(() => upsertPart(db, { id: 'nope', projectId: 'p1', name: 'gitara' })).toThrow(
      /Part not found/,
    )
  })
})

// ---------------------------------------------------------------------------
// deletePart
// ---------------------------------------------------------------------------

describe('deletePart', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1', 'Band A')
    insertRundown(db, 'rd-1', 'p1', 'Song 1', 'Band A')
  })

  afterEach(() => {
    db.close()
  })

  it('deletes a part no call references', () => {
    insertPart(db, 'pt-1', 'p1', 1, 'gitara')

    deletePart(db, 'pt-1')

    expect(listParts(db, 'p1')).toEqual([])
  })

  it('refuses when calls reference the part and reports the count', () => {
    insertPart(db, 'pt-1', 'p1', 1, 'gitara')
    for (let i = 0; i < 4; i++) {
      insertCall(db, `call-${i}`, 'rd-1', 'pt-1', i)
    }

    expect(() => deletePart(db, 'pt-1')).toThrow('Cannot delete Part "gitara": 4 Calls reference it')
    expect(listParts(db, 'p1')).toHaveLength(1)
  })

  it('reads naturally for a single call', () => {
    insertPart(db, 'pt-1', 'p1', 1, 'gitara')
    insertCall(db, 'call-0', 'rd-1', 'pt-1')

    expect(() => deletePart(db, 'pt-1')).toThrow('Cannot delete Part "gitara": 1 Call references it')
  })

  it('ignores calls pointing at other parts', () => {
    insertPart(db, 'pt-1', 'p1', 1, 'gitara')
    insertPart(db, 'pt-2', 'p1', 2, 'wokal 1')
    insertCall(db, 'call-0', 'rd-1', 'pt-2')

    deletePart(db, 'pt-1')

    expect(names(listParts(db, 'p1'))).toEqual(['wokal 1'])
  })

  it('throws for an unknown part', () => {
    expect(() => deletePart(db, 'nope')).toThrow(/Part not found/)
  })
})

// ---------------------------------------------------------------------------
// promotePart
// ---------------------------------------------------------------------------

describe('promotePart', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1', 'Band A')
    insertRundown(db, 'rd-1', 'p1', 'Song 1', 'Band A')
    insertRundown(db, 'rd-2', 'p1', 'Song 2', 'Band A')
  })

  afterEach(() => {
    db.close()
  })

  it('moves a rundown-scoped part to folder scope keeping its id', () => {
    insertPart(db, 'pt-1', 'p1', 1, 'gitara', null, 'rd-1')

    const promoted = promotePart(db, 'pt-1', { kind: 'folder', folder: 'Band A' })

    expect(promoted.id).toBe('pt-1')
    expect(promoted.folder).toBe('Band A')
    expect(promoted.rundownId).toBeNull()
  })

  it('moves a part to project scope, clearing both columns', () => {
    insertPart(db, 'pt-1', 'p1', 1, 'gitara', 'Band A')

    const promoted = promotePart(db, 'pt-1', { kind: 'project' })

    expect(promoted.folder).toBeNull()
    expect(promoted.rundownId).toBeNull()
  })

  it('keeps existing calls pointing at the part', () => {
    insertPart(db, 'pt-1', 'p1', 1, 'gitara', null, 'rd-1')
    insertCall(db, 'call-0', 'rd-1', 'pt-1')

    promotePart(db, 'pt-1', { kind: 'project' })

    const call = db.prepare('SELECT part_id FROM shots WHERE id = ?').get('call-0') as { part_id: string }
    expect(call.part_id).toBe('pt-1')
  })

  it('widens which rundowns see the part', () => {
    insertPart(db, 'pt-1', 'p1', 1, 'gitara', null, 'rd-1')
    expect(names(listPartsInScope(db, 'rd-2'))).toEqual([])

    promotePart(db, 'pt-1', { kind: 'folder', folder: 'Band A' })

    expect(names(listPartsInScope(db, 'rd-2'))).toEqual(['gitara'])
  })

  it('leaves number, name and colour untouched', () => {
    insertPart(db, 'pt-1', 'p1', 5, 'gitara', null, 'rd-1', '#abcdef')

    const promoted = promotePart(db, 'pt-1', { kind: 'project' })

    expect(promoted.number).toBe(5)
    expect(promoted.name).toBe('gitara')
    expect(promoted.color).toBe('#abcdef')
  })

  it('throws for an unknown part', () => {
    expect(() => promotePart(db, 'nope', { kind: 'project' })).toThrow(/Part not found/)
  })
})

// ---------------------------------------------------------------------------
// setPartsColor
// ---------------------------------------------------------------------------

describe('setPartsColor', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1', 'Band A')
  })

  afterEach(() => {
    db.close()
  })

  it('sets one colour on several parts', () => {
    insertPart(db, 'pt-1', 'p1', 1, 'zwrotka 1', null, null, '#e74c3c')
    insertPart(db, 'pt-2', 'p1', 2, 'zwrotka 2', null, null, '#3498db')
    insertPart(db, 'pt-3', 'p1', 3, 'wokal 1', null, null, '#f39c12')

    const updated = setPartsColor(db, ['pt-1', 'pt-2'], '#2ecc71')

    expect(updated.map((p) => p.color)).toEqual(['#2ecc71', '#2ecc71'])
    expect(listParts(db, 'p1').map((p) => p.color)).toEqual(['#2ecc71', '#2ecc71', '#f39c12'])
  })

  it('returns the updated parts ordered by number', () => {
    insertPart(db, 'pt-1', 'p1', 1, 'a')
    insertPart(db, 'pt-2', 'p1', 2, 'b')

    expect(names(setPartsColor(db, ['pt-2', 'pt-1'], '#2ecc71'))).toEqual(['a', 'b'])
  })

  it('leaves every part untouched when one id is unknown', () => {
    insertPart(db, 'pt-1', 'p1', 1, 'a', null, null, '#e74c3c')

    expect(() => setPartsColor(db, ['pt-1', 'nope'], '#2ecc71')).toThrow(/Part not found/)
    expect(listParts(db, 'p1')[0].color).toBe('#e74c3c')
  })

  it('rejects an empty colour', () => {
    insertPart(db, 'pt-1', 'p1', 1, 'a')

    expect(() => setPartsColor(db, ['pt-1'], '  ')).toThrow(/must not be empty/)
  })
})

// ---------------------------------------------------------------------------
// renameFolder
// ---------------------------------------------------------------------------

describe('renameFolder', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1', 'Band A')
    insertProject(db, 'p2', 'Band B')
  })

  afterEach(() => {
    db.close()
  })

  it('renames both rundowns and parts', () => {
    insertRundown(db, 'rd-1', 'p1', 'Song 1', 'Old')
    insertPart(db, 'pt-1', 'p1', 1, 'wokal 1', 'Old')

    renameFolder(db, 'p1', 'Old', 'New')

    const rundown = db.prepare('SELECT folder FROM rundowns WHERE id = ?').get('rd-1') as { folder: string }
    expect(rundown.folder).toBe('New')
    expect(listParts(db, 'p1')[0].folder).toBe('New')
  })

  it('keeps foldered parts in scope of their rundowns after the rename', () => {
    insertRundown(db, 'rd-1', 'p1', 'Song 1', 'Old')
    insertPart(db, 'pt-1', 'p1', 1, 'wokal 1', 'Old')

    renameFolder(db, 'p1', 'Old', 'New')

    expect(names(listPartsInScope(db, 'rd-1'))).toEqual(['wokal 1'])
  })

  it('leaves other folders and other projects alone', () => {
    insertRundown(db, 'rd-1', 'p1', 'Song 1', 'Other')
    insertPart(db, 'pt-1', 'p1', 1, 'kept', 'Other')
    insertRundown(db, 'rd-2', 'p2', 'Song 2', 'Old')
    insertPart(db, 'pt-2', 'p2', 1, 'other project', 'Old')

    renameFolder(db, 'p1', 'Old', 'New')

    expect(listParts(db, 'p1')[0].folder).toBe('Other')
    expect(listParts(db, 'p2')[0].folder).toBe('Old')
    const rundown = db.prepare('SELECT folder FROM rundowns WHERE id = ?').get('rd-2') as { folder: string }
    expect(rundown.folder).toBe('Old')
  })

  it('leaves project-scoped parts alone', () => {
    insertPart(db, 'pt-1', 'p1', 1, 'refren')

    renameFolder(db, 'p1', 'Old', 'New')

    expect(listParts(db, 'p1')[0].folder).toBeNull()
  })

  it('rejects an empty folder name', () => {
    expect(() => renameFolder(db, 'p1', 'Old', '  ')).toThrow(/must not be empty/)
    expect(() => renameFolder(db, 'p1', '', 'New')).toThrow(/must not be empty/)
  })
})
