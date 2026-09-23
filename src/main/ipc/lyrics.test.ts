import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db/index'
import { listLyrics, upsertLyric, deleteLyric } from './lyrics'
import { deleteRundown } from './rundowns'

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
  db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(
    id,
    name,
    Date.now(),
  )
}

function insertRundown(
  db: Database.Database,
  id: string,
  projectId: string,
  name: string,
  createdAt = 1000,
): void {
  db.prepare('INSERT INTO rundowns (id, project_id, name, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    projectId,
    name,
    createdAt,
  )
}

function insertLyric(
  db: Database.Database,
  id: string,
  rundownId: string,
  startMs: number,
  endMs: number,
  text: string,
): void {
  db.prepare(
    'INSERT INTO lyrics (id, rundown_id, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)',
  ).run(id, rundownId, startMs, endMs, text)
}

// ---------------------------------------------------------------------------
// listLyrics
// ---------------------------------------------------------------------------

describe('listLyrics', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1', 'Project A')
    insertRundown(db, 'rd-1', 'p1', 'Song A')
    insertRundown(db, 'rd-2', 'p1', 'Song B')
  })

  afterEach(() => {
    db.close()
  })

  it('returns empty array when rundown has no lyrics', () => {
    expect(listLyrics(db, 'rd-1')).toEqual([])
  })

  it('returns lyrics ordered by start', () => {
    insertLyric(db, 'ly-3', 'rd-1', 6000, 8000, 'third')
    insertLyric(db, 'ly-1', 'rd-1', 0, 2000, 'first')
    insertLyric(db, 'ly-2', 'rd-1', 3000, 5000, 'second')
    expect(listLyrics(db, 'rd-1').map((l) => l.id)).toEqual(['ly-1', 'ly-2', 'ly-3'])
  })

  it('returns lyrics with correct shape', () => {
    insertLyric(db, 'ly-1', 'rd-1', 1500, 2500, 'na wzgorzu')
    expect(listLyrics(db, 'rd-1')[0]).toEqual({
      id: 'ly-1',
      rundownId: 'rd-1',
      startMs: 1500,
      endMs: 2500,
      text: 'na wzgorzu',
    })
  })

  it('never leaks lyrics from another rundown', () => {
    insertLyric(db, 'ly-1', 'rd-1', 0, 1000, 'mine')
    insertLyric(db, 'ly-2', 'rd-2', 0, 1000, 'theirs')
    const result = listLyrics(db, 'rd-1')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('ly-1')
  })
})

// ---------------------------------------------------------------------------
// upsertLyric
// ---------------------------------------------------------------------------

describe('upsertLyric', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1', 'Project A')
    insertRundown(db, 'rd-1', 'p1', 'Song A')
    insertRundown(db, 'rd-2', 'p1', 'Song B')
  })

  afterEach(() => {
    db.close()
  })

  it('creates a lyric with a generated id when none is given', () => {
    const lyric = upsertLyric(db, { rundownId: 'rd-1', startMs: 0, endMs: 1000, text: 'line' })
    expect(lyric.id).toBeTypeOf('string')
    expect(lyric.id.length).toBeGreaterThan(0)
    expect(listLyrics(db, 'rd-1')).toHaveLength(1)
  })

  it('updates in place when an id is given', () => {
    insertLyric(db, 'ly-1', 'rd-1', 0, 1000, 'old')
    const updated = upsertLyric(db, {
      id: 'ly-1',
      rundownId: 'rd-1',
      startMs: 500,
      endMs: 1500,
      text: 'new',
    })
    expect(updated).toEqual({
      id: 'ly-1',
      rundownId: 'rd-1',
      startMs: 500,
      endMs: 1500,
      text: 'new',
    })
    expect(listLyrics(db, 'rd-1')).toHaveLength(1)
  })

  it('does not treat the row being updated as an overlap with itself', () => {
    insertLyric(db, 'ly-1', 'rd-1', 1000, 2000, 'line')
    expect(() =>
      upsertLyric(db, {
        id: 'ly-1',
        rundownId: 'rd-1',
        startMs: 1000,
        endMs: 2000,
        text: 'retitled',
      }),
    ).not.toThrow()
  })

  it('rejects an exact overlap', () => {
    insertLyric(db, 'ly-1', 'rd-1', 1000, 2000, 'line')
    expect(() =>
      upsertLyric(db, { rundownId: 'rd-1', startMs: 1000, endMs: 2000, text: 'x' }),
    ).toThrow()
  })

  it('rejects a partial overlap at the start of an existing lyric', () => {
    insertLyric(db, 'ly-1', 'rd-1', 1000, 2000, 'line')
    expect(() =>
      upsertLyric(db, { rundownId: 'rd-1', startMs: 500, endMs: 1500, text: 'x' }),
    ).toThrow()
  })

  it('rejects a partial overlap at the end of an existing lyric', () => {
    insertLyric(db, 'ly-1', 'rd-1', 1000, 2000, 'line')
    expect(() =>
      upsertLyric(db, { rundownId: 'rd-1', startMs: 1500, endMs: 2500, text: 'x' }),
    ).toThrow()
  })

  it('rejects a range fully contained in an existing lyric', () => {
    insertLyric(db, 'ly-1', 'rd-1', 1000, 2000, 'line')
    expect(() =>
      upsertLyric(db, { rundownId: 'rd-1', startMs: 1200, endMs: 1800, text: 'x' }),
    ).toThrow()
  })

  it('rejects a range fully containing an existing lyric', () => {
    insertLyric(db, 'ly-1', 'rd-1', 1000, 2000, 'line')
    expect(() =>
      upsertLyric(db, { rundownId: 'rd-1', startMs: 0, endMs: 5000, text: 'x' }),
    ).toThrow()
  })

  it('accepts a lyric starting exactly where the previous one ends', () => {
    insertLyric(db, 'ly-1', 'rd-1', 1000, 2000, 'first')
    const next = upsertLyric(db, { rundownId: 'rd-1', startMs: 2000, endMs: 3000, text: 'second' })
    expect(next.startMs).toBe(2000)
    expect(listLyrics(db, 'rd-1')).toHaveLength(2)
  })

  it('accepts a lyric ending exactly where the next one starts', () => {
    insertLyric(db, 'ly-2', 'rd-1', 2000, 3000, 'second')
    const prev = upsertLyric(db, { rundownId: 'rd-1', startMs: 1000, endMs: 2000, text: 'first' })
    expect(prev.endMs).toBe(2000)
    expect(listLyrics(db, 'rd-1')).toHaveLength(2)
  })

  it('allows an overlapping range on a different rundown', () => {
    insertLyric(db, 'ly-1', 'rd-1', 1000, 2000, 'line')
    expect(() =>
      upsertLyric(db, { rundownId: 'rd-2', startMs: 1000, endMs: 2000, text: 'other song' }),
    ).not.toThrow()
  })

  it('leaves the existing lyric untouched when an overlap is rejected', () => {
    insertLyric(db, 'ly-1', 'rd-1', 1000, 2000, 'line')
    expect(() =>
      upsertLyric(db, { rundownId: 'rd-1', startMs: 1200, endMs: 1800, text: 'x' }),
    ).toThrow()
    expect(listLyrics(db, 'rd-1')).toHaveLength(1)
    expect(listLyrics(db, 'rd-1')[0].text).toBe('line')
  })

  it('rejects an end equal to the start', () => {
    expect(() =>
      upsertLyric(db, { rundownId: 'rd-1', startMs: 1000, endMs: 1000, text: 'x' }),
    ).toThrow()
  })

  it('rejects an end before the start', () => {
    expect(() =>
      upsertLyric(db, { rundownId: 'rd-1', startMs: 2000, endMs: 1000, text: 'x' }),
    ).toThrow()
  })

  it('rejects empty text', () => {
    expect(() =>
      upsertLyric(db, { rundownId: 'rd-1', startMs: 0, endMs: 1000, text: '' }),
    ).toThrow()
  })

  it('rejects whitespace-only text', () => {
    expect(() =>
      upsertLyric(db, { rundownId: 'rd-1', startMs: 0, endMs: 1000, text: '   ' }),
    ).toThrow()
  })

  it('throws if rundownId does not exist', () => {
    expect(() =>
      upsertLyric(db, { rundownId: 'nonexistent', startMs: 0, endMs: 1000, text: 'x' }),
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// deleteLyric
// ---------------------------------------------------------------------------

describe('deleteLyric', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1', 'Project A')
    insertRundown(db, 'rd-1', 'p1', 'Song A')
    insertLyric(db, 'ly-1', 'rd-1', 0, 1000, 'first')
    insertLyric(db, 'ly-2', 'rd-1', 1000, 2000, 'second')
  })

  afterEach(() => {
    db.close()
  })

  it('removes the lyric from the database', () => {
    deleteLyric(db, 'ly-1')
    const all = listLyrics(db, 'rd-1')
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe('ly-2')
  })

  it('frees the range so an overlapping lyric can be written', () => {
    deleteLyric(db, 'ly-1')
    expect(() =>
      upsertLyric(db, { rundownId: 'rd-1', startMs: 0, endMs: 500, text: 'x' }),
    ).not.toThrow()
  })

  it('throws if lyric does not exist', () => {
    expect(() => deleteLyric(db, 'nonexistent')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Cascade from rundowns
// ---------------------------------------------------------------------------

describe('deleting a rundown', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1', 'Project A')
    insertRundown(db, 'rd-1', 'p1', 'Song A')
    insertRundown(db, 'rd-2', 'p1', 'Song B')
  })

  afterEach(() => {
    db.close()
  })

  it('cascades deletion to its lyrics', () => {
    insertLyric(db, 'ly-1', 'rd-1', 0, 1000, 'first')
    insertLyric(db, 'ly-2', 'rd-1', 1000, 2000, 'second')
    deleteRundown(db, 'rd-1')
    expect(db.prepare('SELECT id FROM lyrics WHERE rundown_id = ?').all('rd-1')).toEqual([])
  })

  it('leaves another rundown lyrics alone', () => {
    insertLyric(db, 'ly-1', 'rd-1', 0, 1000, 'mine')
    insertLyric(db, 'ly-2', 'rd-2', 0, 1000, 'theirs')
    deleteRundown(db, 'rd-1')
    expect(listLyrics(db, 'rd-2')).toHaveLength(1)
  })
})
