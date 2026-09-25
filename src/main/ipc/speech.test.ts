import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db/index'
import {
  projectRenderSummary,
  missingClips,
  orphanedClips,
  recordClip,
  recordPartRenders,
  forgetClips,
  forgetPartRenders,
  clipsNeedingDurations,
  clipsOnlyUsedBy,
  phraseDurations,
} from './speech'
import { saveProjectVoiceSettings, saveGlobalVoiceSettings } from './settings'
import { upsertPart } from './parts'
import { ENGINE_ID, clipHash, partPhrase } from '../../shared/render-plan'
import { languageOfVoice, numberWords } from '../../shared/number-words'

function openMemoryDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  return db
}

function insertProject(db: Database.Database, id: string): void {
  db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(id, id, 1000)
}

const VOICE = 'pl_PL-gosia-medium'

/** Every number clip a Voice needs, so tests can distinguish them from phrases. */
function numberHashes(voice: string): string[] {
  return [...numberWords(languageOfVoice(voice)).values()].map((word) =>
    clipHash(word, voice, ENGINE_ID),
  )
}

function phraseHash(name: string, connector: string, voice = VOICE): string {
  return clipHash(partPhrase(name, connector), voice, ENGINE_ID)
}

describe('projectRenderSummary', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1')
  })

  afterEach(() => {
    db.close()
  })

  it('reports a Part with no clip as missing', () => {
    upsertPart(db, { projectId: 'p1', name: 'gitara' })
    const summary = projectRenderSummary(db, 'p1', [])
    expect(summary.parts).toEqual([expect.objectContaining({ name: 'gitara', state: 'missing' })])
    expect(summary.unrenderedCount).toBe(1)
  })

  it('reports a Part as rendered once its clip exists and is recorded', () => {
    const part = upsertPart(db, { projectId: 'p1', name: 'gitara' })
    recordPartRenders(db, 'p1')
    const summary = projectRenderSummary(db, 'p1', [phraseHash('gitara', 'za')])
    expect(summary.parts).toEqual([{ partId: part.id, name: 'gitara', state: 'rendered' }])
    expect(summary.unrenderedCount).toBe(0)
  })

  it('reports a renamed Part as stale rather than silently keeping the old audio', () => {
    const part = upsertPart(db, { projectId: 'p1', name: 'gitara' })
    recordPartRenders(db, 'p1')
    const cached = [phraseHash('gitara', 'za')]

    upsertPart(db, { id: part.id, projectId: 'p1', name: 'gitara solo' })
    expect(projectRenderSummary(db, 'p1', cached).parts[0].state).toBe('stale')
  })

  it('reports a Part as stale after the Voice changes', () => {
    upsertPart(db, { projectId: 'p1', name: 'gitara' })
    recordPartRenders(db, 'p1')
    const cached = [phraseHash('gitara', 'za')]

    saveProjectVoiceSettings(db, 'p1', {
      voice: 'en_US-amy-medium',
      countdown: null,
      placement: null,
      connector: 'za',
    })
    expect(projectRenderSummary(db, 'p1', cached).parts[0].state).toBe('stale')
  })

  it('reports a Part whose clip vanished from disk as missing, not rendered', () => {
    upsertPart(db, { projectId: 'p1', name: 'gitara' })
    recordPartRenders(db, 'p1')
    expect(projectRenderSummary(db, 'p1', []).parts[0].state).toBe('missing')
  })
})

describe('missingClips', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1')
  })

  afterEach(() => {
    db.close()
  })

  it('queues all sixty number clips regardless of the configured countdown', () => {
    saveGlobalVoiceSettings(db, {
      voice: VOICE,
      countdown: [3, 1],
      placement: 'flush',
      autoRender: false,
      transmissionDelayMs: 0,
    })
    const hashes = missingClips(db, 'p1', []).map((item) => item.hash)
    expect(new Set(hashes)).toEqual(new Set(numberHashes(VOICE)))
    expect(hashes).toHaveLength(60)
  })

  it('queues a Part phrase alongside the numbers, and not once already cached', () => {
    upsertPart(db, { projectId: 'p1', name: 'gitara' })
    const hash = phraseHash('gitara', 'za')

    expect(missingClips(db, 'p1', []).map((i) => i.hash)).toContain(hash)
    expect(missingClips(db, 'p1', [hash, ...numberHashes(VOICE)])).toEqual([])
  })

  it('speaks the Part name followed by the Project connector', () => {
    upsertPart(db, { projectId: 'p1', name: 'gitara' })
    saveProjectVoiceSettings(db, 'p1', {
      voice: null,
      countdown: null,
      placement: null,
      connector: 'in',
    })
    const phrase = missingClips(db, 'p1', []).find((i) => i.text.startsWith('gitara'))
    expect(phrase?.text).toBe('gitara in')
  })
})

describe('orphanedClips', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1')
  })

  afterEach(() => {
    db.close()
  })

  it('sweeps a renamed Part’s old clip', () => {
    const part = upsertPart(db, { projectId: 'p1', name: 'gitara' })
    const old = phraseHash('gitara', 'za')
    upsertPart(db, { id: part.id, projectId: 'p1', name: 'wokal' })

    expect(orphanedClips(db, [old, ...numberHashes(VOICE)])).toEqual([old])
  })

  it('keeps a clip that is still a current Part phrase', () => {
    upsertPart(db, { projectId: 'p1', name: 'gitara' })
    expect(orphanedClips(db, [phraseHash('gitara', 'za')])).toEqual([])
  })

  it('never sweeps a clip another Project still wants', () => {
    insertProject(db, 'p2')
    // p2 keeps the default Voice; p1 moves to another one.
    upsertPart(db, { projectId: 'p2', name: 'gitara' })
    saveProjectVoiceSettings(db, 'p1', {
      voice: 'en_US-amy-medium',
      countdown: null,
      placement: null,
      connector: 'in',
    })

    const wantedByP2 = phraseHash('gitara', 'za')
    expect(orphanedClips(db, [wantedByP2])).toEqual([])
  })

  it('sweeps everything when there are no Projects left', () => {
    db.prepare('DELETE FROM projects').run()
    expect(orphanedClips(db, ['abc', 'def'])).toEqual(['abc', 'def'])
  })
})

describe('recordClip and forgetClips', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1')
  })

  afterEach(() => {
    db.close()
  })

  it('stores the duration flush placement schedules against', () => {
    recordClip(db, { hash: 'h1', text: 'gitara za', voice: VOICE, engine: ENGINE_ID }, 820)
    const row = db.prepare('SELECT * FROM speech_clips WHERE hash = ?').get('h1') as {
      duration_ms: number
      text: string
    }
    expect(row).toMatchObject({ text: 'gitara za', duration_ms: 820 })
  })

  it('replaces a clip re-rendered under the same hash', () => {
    const item = { hash: 'h1', text: 'gitara za', voice: VOICE, engine: ENGINE_ID }
    recordClip(db, item, 820)
    recordClip(db, item, 910)
    const rows = db.prepare('SELECT duration_ms FROM speech_clips').all() as {
      duration_ms: number
    }[]
    expect(rows).toEqual([{ duration_ms: 910 }])
  })

  it('forgets swept clips and tolerates an empty sweep', () => {
    recordClip(db, { hash: 'h1', text: 'a', voice: VOICE, engine: ENGINE_ID }, 100)
    recordClip(db, { hash: 'h2', text: 'b', voice: VOICE, engine: ENGINE_ID }, 100)
    forgetClips(db, [])
    expect(db.prepare('SELECT COUNT(*) AS n FROM speech_clips').get()).toEqual({ n: 2 })

    forgetClips(db, ['h1'])
    const remaining = db.prepare('SELECT hash FROM speech_clips').all()
    expect(remaining).toEqual([{ hash: 'h2' }])
  })
})

describe('recordPartRenders', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1')
  })

  afterEach(() => {
    db.close()
  })

  it('points each Part at the clip its current name renders to', () => {
    const part = upsertPart(db, { projectId: 'p1', name: 'gitara' })
    recordPartRenders(db, 'p1')
    const row = db.prepare('SELECT * FROM part_renders WHERE part_id = ?').get(part.id)
    expect(row).toEqual({
      part_id: part.id,
      voice: VOICE,
      engine: ENGINE_ID,
      hash: phraseHash('gitara', 'za'),
    })
  })

  it('keeps one row per Part, Voice and engine across repeated renders', () => {
    upsertPart(db, { projectId: 'p1', name: 'gitara' })
    recordPartRenders(db, 'p1')
    recordPartRenders(db, 'p1')
    expect(db.prepare('SELECT COUNT(*) AS n FROM part_renders').get()).toEqual({ n: 1 })
  })

  it('drops a Part’s render record when the Part is deleted', () => {
    const part = upsertPart(db, { projectId: 'p1', name: 'gitara' })
    recordPartRenders(db, 'p1')
    db.prepare('DELETE FROM parts WHERE id = ?').run(part.id)
    expect(db.prepare('SELECT COUNT(*) AS n FROM part_renders').get()).toEqual({ n: 0 })
  })
})

describe('phraseDurations', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1')
  })

  afterEach(() => {
    db.close()
  })

  it('reports the duration of each Part’s current phrase', () => {
    const part = upsertPart(db, { projectId: 'p1', name: 'gitara' })
    recordClip(
      db,
      { hash: phraseHash('gitara', 'za'), text: 'gitara za', voice: VOICE, engine: ENGINE_ID },
      820,
    )
    expect(phraseDurations(db, 'p1')).toEqual({ [part.id]: 820 })
  })

  it('omits a Part with no rendered clip rather than reporting it as zero-length', () => {
    upsertPart(db, { projectId: 'p1', name: 'gitara' })
    expect(phraseDurations(db, 'p1')).toEqual({})
  })

  it('omits a renamed Part, whose old clip no longer describes it', () => {
    const part = upsertPart(db, { projectId: 'p1', name: 'gitara' })
    recordClip(
      db,
      { hash: phraseHash('gitara', 'za'), text: 'gitara za', voice: VOICE, engine: ENGINE_ID },
      820,
    )
    upsertPart(db, { id: part.id, projectId: 'p1', name: 'wokal' })
    expect(phraseDurations(db, 'p1')).toEqual({})
  })
})

describe('clipsNeedingDurations', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1')
  })

  afterEach(() => {
    db.close()
  })

  it('recovers the text and Voice behind a clip on disk with no row', () => {
    upsertPart(db, { projectId: 'p1', name: 'gitara' })
    const hash = phraseHash('gitara', 'za')

    expect(clipsNeedingDurations(db, [hash])).toEqual([
      { hash, text: 'gitara za', voice: VOICE, engine: ENGINE_ID },
    ])
  })

  it('ignores a clip whose duration is already recorded', () => {
    upsertPart(db, { projectId: 'p1', name: 'gitara' })
    const hash = phraseHash('gitara', 'za')
    recordClip(db, { hash, text: 'gitara za', voice: VOICE, engine: ENGINE_ID }, 900)

    expect(clipsNeedingDurations(db, [hash])).toEqual([])
  })

  it('ignores a wanted clip that is not on disk — nothing to measure', () => {
    upsertPart(db, { projectId: 'p1', name: 'gitara' })
    expect(clipsNeedingDurations(db, [])).toEqual([])
  })

  it('ignores a cached clip nothing wants, which is the sweep’s job', () => {
    upsertPart(db, { projectId: 'p1', name: 'gitara' })
    expect(clipsNeedingDurations(db, [phraseHash('perkusja', 'za')])).toEqual([])
  })

  it('reports each hash once when two Projects want the same clip', () => {
    insertProject(db, 'p2')
    upsertPart(db, { projectId: 'p1', name: 'gitara' })
    upsertPart(db, { projectId: 'p2', name: 'gitara' })

    expect(clipsNeedingDurations(db, [phraseHash('gitara', 'za')])).toHaveLength(1)
  })

  it('covers the countdown numbers, not just the Part phrases', () => {
    upsertPart(db, { projectId: 'p1', name: 'gitara' })
    const numbers = numberHashes(VOICE)

    const found = clipsNeedingDurations(db, numbers).map((item) => item.hash)
    expect(found.sort()).toEqual([...numbers].sort())
  })
})

describe('clipsOnlyUsedBy', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1')
  })

  afterEach(() => {
    db.close()
  })

  it('returns a phrase clip no other Project wants', () => {
    upsertPart(db, { projectId: 'p1', name: 'gitara' })
    const hash = phraseHash('gitara', 'za')

    expect(clipsOnlyUsedBy(db, 'p1', [hash])).toEqual([hash])
  })

  it('spares a phrase clip another Project shares', () => {
    insertProject(db, 'p2')
    upsertPart(db, { projectId: 'p1', name: 'gitara' })
    upsertPart(db, { projectId: 'p2', name: 'gitara' })

    expect(clipsOnlyUsedBy(db, 'p1', [phraseHash('gitara', 'za')])).toEqual([])
  })

  it('spares the number clips a Project on the same Voice shares', () => {
    insertProject(db, 'p2')
    upsertPart(db, { projectId: 'p1', name: 'gitara' })
    upsertPart(db, { projectId: 'p2', name: 'perkusja' })

    const cached = [...numberHashes(VOICE), phraseHash('gitara', 'za')]
    expect(clipsOnlyUsedBy(db, 'p1', cached)).toEqual([phraseHash('gitara', 'za')])
  })

  it('deletes the number clips when every other Project uses another Voice', () => {
    insertProject(db, 'p2')
    upsertPart(db, { projectId: 'p1', name: 'gitara' })
    upsertPart(db, { projectId: 'p2', name: 'perkusja' })
    saveProjectVoiceSettings(db, 'p2', {
      voice: 'en_US-amy-medium',
      countdown: null,
      placement: null,
      connector: 'za',
    })

    const numbers = numberHashes(VOICE)
    expect(clipsOnlyUsedBy(db, 'p1', numbers).sort()).toEqual([...numbers].sort())
  })

  it('returns nothing for a clip that is not on disk', () => {
    upsertPart(db, { projectId: 'p1', name: 'gitara' })
    expect(clipsOnlyUsedBy(db, 'p1', [])).toEqual([])
  })

  it('leaves an orphan alone — that is the clean action, not this one', () => {
    upsertPart(db, { projectId: 'p1', name: 'gitara' })
    const orphan = phraseHash('stara nazwa', 'za')

    expect(clipsOnlyUsedBy(db, 'p1', [phraseHash('gitara', 'za'), orphan])).not.toContain(orphan)
  })
})

describe('forgetPartRenders', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    insertProject(db, 'p1')
    insertProject(db, 'p2')
  })

  afterEach(() => {
    db.close()
  })

  it('drops this Project’s rows and leaves the other Project’s alone', () => {
    upsertPart(db, { projectId: 'p1', name: 'gitara' })
    upsertPart(db, { projectId: 'p2', name: 'gitara' })
    recordPartRenders(db, 'p1')
    recordPartRenders(db, 'p2')

    forgetPartRenders(db, 'p1')

    const cached = [phraseHash('gitara', 'za')]
    expect(projectRenderSummary(db, 'p1', cached).parts[0].state).toBe('missing')
    expect(projectRenderSummary(db, 'p2', cached).parts[0].state).toBe('rendered')
  })

  it('is a no-op for a Project that never rendered', () => {
    upsertPart(db, { projectId: 'p1', name: 'gitara' })
    expect(() => forgetPartRenders(db, 'p1')).not.toThrow()
  })
})
