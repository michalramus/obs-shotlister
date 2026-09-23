import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db/index'
import { createLiveSession, type LiveSession } from './session'
import type { AnnouncementPlan } from '../../shared/ipc-contract'
import { clipHash } from '../../shared/render-plan'
import { languageOfVoice, numberWords } from '../../shared/number-words'
import { toMediaUrl } from '../../shared/media-url'

function openMemoryDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  return db
}

interface SeedOptions {
  shotCount?: number
  durationMs?: number
  transitionMs?: number
}

function seed(db: Database.Database, opts: SeedOptions = {}): string[] {
  const { shotCount = 3, durationMs = 5000, transitionMs = 0 } = opts
  db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('p1', 'P', 1000)
  db.prepare('INSERT INTO rundowns (id, project_id, name, created_at) VALUES (?, ?, ?, ?)').run(
    'rd-1',
    'p1',
    'Morning',
    1000,
  )
  db.prepare(
    'INSERT INTO cameras (id, project_id, number, name, color) VALUES (?, ?, ?, ?, ?)',
  ).run('cam-1', 'p1', 1, 'Wide', '#e74c3c')
  const ids: string[] = []
  for (let i = 0; i < shotCount; i++) {
    const id = `shot-${i}`
    db.prepare(
      'INSERT INTO shots (id, rundown_id, camera_id, duration_ms, order_index, transition_ms) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, 'rd-1', 'cam-1', durationMs, i, transitionMs)
    ids.push(id)
  }
  return ids
}

describe('LiveSession', () => {
  let db: Database.Database
  let session: LiveSession

  beforeEach(() => {
    db = openMemoryDb()
    session = createLiveSession(db)
  })

  afterEach(() => {
    db.close()
    vi.useRealTimers()
  })

  describe('sessions are independent', () => {
    it('does not share progress between instances over the same database', () => {
      seed(db)
      const other = createLiveSession(db)
      session.start('rd-1')

      expect(session.getState().running).toBe(true)
      // Selection is durable so it is shared; progress is not.
      expect(other.getState().rundownId).toBe('rd-1')
      expect(other.getState().running).toBe(false)
      expect(other.getState().liveIndex).toBeNull()
    })
  })

  describe('idle', () => {
    it('reports an idle state before anything starts', () => {
      expect(session.getState()).toEqual({
        rundownId: null,
        projectId: null,
        liveIndex: null,
        startedAt: null,
        running: false,
      })
    })

    it('has an empty queue', () => {
      expect(session.getQueue()).toEqual([])
      expect(session.getVisibleQueue()).toEqual([])
    })

    it('reports no live shot and no transition', () => {
      expect(session.getLiveShot()).toBeNull()
      expect(session.isInTransition()).toBe(false)
    })
  })

  describe('start', () => {
    it('puts the first shot on air', () => {
      seed(db)
      const state = session.start('rd-1')
      expect(state).toMatchObject({ rundownId: 'rd-1', liveIndex: 0, running: true })
      expect(state.startedAt).toBeTypeOf('number')
      expect(session.getLiveShot()?.id).toBe('shot-0')
    })

    it('populates the queue with every shot visible', () => {
      seed(db)
      session.start('rd-1')
      expect(session.getQueue().map((s) => s.id)).toEqual(['shot-0', 'shot-1', 'shot-2'])
      expect(session.getQueue().every((s) => !s.hidden)).toBe(true)
    })

    it('refuses to start an empty rundown', () => {
      db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('p1', 'P', 0)
      db.prepare('INSERT INTO rundowns (id, project_id, name, created_at) VALUES (?, ?, ?, ?)').run(
        'rd-1',
        'p1',
        'Empty',
        0,
      )
      expect(() => session.start('rd-1')).toThrow(/no shots/)
    })
  })

  describe('next', () => {
    it('advances and hides the shot leaving air', () => {
      seed(db)
      session.start('rd-1')
      const { state, hiddenShotId } = session.next()

      expect(hiddenShotId).toBe('shot-0')
      expect(state.liveIndex).toBe(1)
      expect(session.getLiveShot()?.id).toBe('shot-1')
      expect(session.getQueue().find((s) => s.id === 'shot-0')?.hidden).toBe(true)
    })

    it('resets startedAt for the incoming shot', () => {
      vi.useFakeTimers()
      seed(db)
      const started = session.start('rd-1').startedAt
      vi.advanceTimersByTime(4000)
      expect(session.next().state.startedAt).toBe((started ?? 0) + 4000)
    })

    it('ends the session past the last shot', () => {
      seed(db, { shotCount: 2 })
      session.start('rd-1')
      session.next()
      const { state, hiddenShotId } = session.next()

      expect(state).toMatchObject({ running: false, liveIndex: null, startedAt: null })
      expect(hiddenShotId).toBeNull()
      expect(session.getQueue()).toEqual([])
    })

    it('throws when not running', () => {
      seed(db)
      expect(() => session.next()).toThrow(/not running/)
    })
  })

  describe('skipNext', () => {
    it('hides the upcoming shot without changing what is live', () => {
      seed(db)
      const startedAt = session.start('rd-1').startedAt
      const { state, hiddenShotId } = session.skipNext()

      expect(hiddenShotId).toBe('shot-1')
      expect(state.liveIndex).toBe(0)
      expect(state.startedAt).toBe(startedAt)
      expect(session.getVisibleQueue().map((s) => s.id)).toEqual(['shot-0', 'shot-2'])
    })

    it('advances past a skipped shot on the next Next', () => {
      seed(db)
      session.start('rd-1')
      session.skipNext()
      expect(session.next().state.liveIndex).toBe(2)
      expect(session.getLiveShot()?.id).toBe('shot-2')
    })

    it('does nothing when there is nothing left to skip', () => {
      seed(db, { shotCount: 1 })
      session.start('rd-1')
      const { hiddenShotId } = session.skipNext()
      expect(hiddenShotId).toBeNull()
      expect(session.getState().liveIndex).toBe(0)
    })

    it('throws when not running', () => {
      seed(db)
      expect(() => session.skipNext()).toThrow(/not running/)
    })
  })

  describe('stop and restart', () => {
    it('returns to idle on stop and keeps the rundown selected', () => {
      seed(db)
      session.start('rd-1')
      const state = session.stop()
      expect(state).toMatchObject({ rundownId: 'rd-1', running: false, liveIndex: null })
      expect(session.getQueue()).toEqual([])
    })

    it('restores every shot on restart', () => {
      seed(db)
      session.start('rd-1')
      session.next()
      const state = session.restart()
      expect(state).toMatchObject({ liveIndex: 0, running: true })
      expect(session.getVisibleQueue()).toHaveLength(3)
    })

    it('refuses to restart with no active rundown', () => {
      expect(() => session.restart()).toThrow(/no active rundown/)
    })
  })

  describe('getShotsWithHiddenFlags', () => {
    it('marks consumed shots hidden', () => {
      seed(db)
      session.start('rd-1')
      session.next()
      const shots = session.getShotsWithHiddenFlags()
      expect(shots.map((s) => [s.id, s.hidden])).toEqual([
        ['shot-0', true],
        ['shot-1', false],
        ['shot-2', false],
      ])
    })

    it('marks skipped shots hidden', () => {
      seed(db)
      session.start('rd-1')
      session.skipNext()
      const shots = session.getShotsWithHiddenFlags()
      expect(shots.find((s) => s.id === 'shot-1')?.hidden).toBe(true)
    })

    it('returns the stored shots untouched when idle', () => {
      seed(db)
      session.setActiveRundown('rd-1')
      const shots = session.getShotsWithHiddenFlags()
      expect(shots).toHaveLength(3)
      expect(shots.every((s) => !s.hidden)).toBe(true)
    })

    it('returns nothing with no rundown selected', () => {
      expect(session.getShotsWithHiddenFlags()).toEqual([])
    })
  })

  describe('getNextVisibleShot', () => {
    it('is the first shot before the session starts', () => {
      seed(db)
      session.setActiveRundown('rd-1')
      expect(session.getNextVisibleShot()?.id).toBe('shot-0')
    })

    it('is the shot after the live one', () => {
      seed(db)
      session.start('rd-1')
      expect(session.getNextVisibleShot()?.id).toBe('shot-1')
    })

    it('steps over a skipped shot', () => {
      seed(db)
      session.start('rd-1')
      session.skipNext()
      expect(session.getNextVisibleShot()?.id).toBe('shot-2')
    })

    it('is null on the last shot', () => {
      seed(db, { shotCount: 1 })
      session.start('rd-1')
      expect(session.getNextVisibleShot()).toBeNull()
    })
  })

  describe('isInTransition', () => {
    // This is the guard that silently returned false for every transition while
    // it was reading progress columns that had been moved into memory.
    it('is true inside the live shot transition window', () => {
      vi.useFakeTimers()
      seed(db, { transitionMs: 1000 })
      session.start('rd-1')
      vi.advanceTimersByTime(500)
      expect(session.isInTransition()).toBe(true)
    })

    it('is false once the window has passed', () => {
      vi.useFakeTimers()
      seed(db, { transitionMs: 1000 })
      session.start('rd-1')
      vi.advanceTimersByTime(1000)
      expect(session.isInTransition()).toBe(false)
    })

    it('is false for a cut', () => {
      seed(db, { transitionMs: 0 })
      session.start('rd-1')
      expect(session.isInTransition()).toBe(false)
    })

    it('is false when not running', () => {
      seed(db, { transitionMs: 1000 })
      expect(session.isInTransition()).toBe(false)
    })

    it('re-arms for each incoming shot', () => {
      vi.useFakeTimers()
      seed(db, { transitionMs: 1000 })
      session.start('rd-1')
      vi.advanceTimersByTime(2000)
      expect(session.isInTransition()).toBe(false)
      session.next()
      expect(session.isInTransition()).toBe(true)
    })
  })

  describe('clear', () => {
    it('drops progress and the active rundown', () => {
      seed(db)
      session.start('rd-1')
      session.clear()
      expect(session.getState()).toMatchObject({ rundownId: null, running: false })
      expect(session.getQueue()).toEqual([])
    })
  })

  describe('persistence rule', () => {
    it('writes no progress to the live_state row', () => {
      seed(db)
      session.start('rd-1')
      session.next()

      const row = db.prepare('SELECT * FROM live_state WHERE id = 1').get() as Record<
        string,
        unknown
      >
      // Only selection is durable — see ADR 0001.
      expect(Object.keys(row).sort()).toEqual(
        ['id', 'project_id', 'rundown_id', 'skipped_ids'].sort(),
      )
      expect(row.rundown_id).toBe('rd-1')
    })
  })
})

// ---------------------------------------------------------------------------
// Voice-over Rundowns
//
// Everything below runs against the same in-memory database and a callback
// standing in for the renderer: no audio device, no Piper, no Electron. Plans
// are asserted by their content — which Call they name and which clips they
// schedule — never by how many times a collaborator was called, because the
// number of calls is not the behaviour the band hears.
// ---------------------------------------------------------------------------

const VOICE = 'pl_PL-gosia-medium'
const ENGINE = 'piper'
const CONNECTOR = 'za'
const CLIPS_DIR = '/clips'
const PHRASE_MS = 800

function clipUrl(text: string): string {
  return toMediaUrl(join(CLIPS_DIR, `${clipHash(text, VOICE, ENGINE)}.wav`))
}

/** The `media://` url of the clip for one countdown number. */
function numberUrl(n: number): string {
  return clipUrl(numberWords(languageOfVoice(VOICE)).get(n) as string)
}

function insertClip(db: Database.Database, text: string, durationMs: number): string {
  const hash = clipHash(text, VOICE, ENGINE)
  db.prepare(
    'INSERT OR REPLACE INTO tts_clips (hash, text, voice, engine, duration_ms) VALUES (?, ?, ?, ?, ?)',
  ).run(hash, text, VOICE, ENGINE, durationMs)
  return hash
}

interface VoiceSeedOptions {
  /** Part name per Call, in order. */
  partNames?: string[]
  durationMs?: number
  /** Leave every Call unassigned, as a fresh conversion does. */
  unassigned?: boolean
  /** Skip rendering the phrase clips, as an unrendered Project would. */
  skipPhraseClips?: boolean
}

/** A voice Rundown with one Part per Call, its clips rendered and logged. */
function seedVoice(db: Database.Database, opts: VoiceSeedOptions = {}): string[] {
  const { partNames = ['gitara', 'wokal', 'refren'], durationMs = 12000 } = opts

  db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('p1', 'P', 1000)
  db.prepare(
    "INSERT INTO rundowns (id, project_id, name, created_at, kind) VALUES (?, ?, ?, ?, 'voice')",
  ).run('rd-1', 'p1', 'Song', 1000)

  const ids: string[] = []
  partNames.forEach((name, i) => {
    const partId = `part-${i}`
    db.prepare(
      'INSERT INTO parts (id, project_id, number, name, color) VALUES (?, ?, ?, ?, ?)',
    ).run(partId, 'p1', i + 1, name, '#e74c3c')

    if (!opts.skipPhraseClips) {
      const hash = insertClip(db, `${name} ${CONNECTOR}`, PHRASE_MS)
      db.prepare('INSERT INTO part_renders (part_id, voice, engine, hash) VALUES (?, ?, ?, ?)').run(
        partId,
        VOICE,
        ENGINE,
        hash,
      )
    }

    const id = `call-${i}`
    db.prepare(
      'INSERT INTO shots (id, rundown_id, part_id, duration_ms, order_index, transition_ms) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, 'rd-1', opts.unassigned ? null : partId, durationMs, i, 0)
    ids.push(id)
  })

  // Numbers are rendered 1..60 per Voice regardless of the countdown in use.
  const words = numberWords(languageOfVoice(VOICE))
  for (const word of words.values()) insertClip(db, word, 400)

  return ids
}

describe('LiveSession announcements', () => {
  let db: Database.Database
  let session: LiveSession
  let plans: (AnnouncementPlan | null)[]

  beforeEach(() => {
    db = openMemoryDb()
    plans = []
    session = createLiveSession(db, {
      onAnnouncement: (plan) => plans.push(plan),
      clipsDir: CLIPS_DIR,
    })
  })

  afterEach(() => {
    db.close()
    vi.useRealTimers()
  })

  describe('unassigned items', () => {
    it('refuses to start a voice rundown with unassigned calls', () => {
      seedVoice(db, { unassigned: true })
      expect(() => session.start('rd-1')).toThrow(
        /3 items in this Voice-over Rundown have no Part assigned/,
      )
    })

    it('refuses to start a camera rundown with unassigned shots', () => {
      seed(db, { shotCount: 2 })
      db.prepare('UPDATE shots SET camera_id = NULL WHERE id = ?').run('shot-1')
      expect(() => session.start('rd-1')).toThrow(
        /1 item in this Camera Rundown has no Camera assigned/,
      )
    })

    it('refuses to restart once an item has been unassigned mid-session', () => {
      seedVoice(db)
      session.start('rd-1')
      db.prepare('UPDATE shots SET part_id = NULL WHERE id = ?').run('call-2')
      expect(() => session.restart()).toThrow(/no Part assigned/)
    })
  })

  describe('what is announced', () => {
    it('names the next visible call and counts down to its planned start', () => {
      seedVoice(db)
      session.start('rd-1')

      // leadMs is the live Call's own duration, so number n starts n seconds
      // before the next Call is due, and the phrase runs flush into the first.
      expect(plans).toEqual([
        {
          callId: 'call-1',
          cues: [
            { url: clipUrl('wokal za'), atMs: 2000 - PHRASE_MS },
            { url: numberUrl(10), atMs: 2000 },
            { url: numberUrl(5), atMs: 7000 },
            { url: numberUrl(3), atMs: 9000 },
            { url: numberUrl(2), atMs: 10000 },
            { url: numberUrl(1), atMs: 11000 },
          ],
        },
      ])
    })

    it('announces the call after the one going live on each next', () => {
      seedVoice(db)
      session.start('rd-1')
      session.next()

      expect(plans.map((p) => p?.callId)).toEqual(['call-1', 'call-2'])
    })

    it('counts down without a name when the part was never rendered', () => {
      seedVoice(db, { skipPhraseClips: true })
      session.start('rd-1')

      // Unrendered speech warns rather than blocks (ADR 0005): the show runs,
      // and the band still gets the numbers.
      expect(plans[0]?.cues).toEqual([
        { url: numberUrl(10), atMs: 2000 },
        { url: numberUrl(5), atMs: 7000 },
        { url: numberUrl(3), atMs: 9000 },
        { url: numberUrl(2), atMs: 10000 },
        { url: numberUrl(1), atMs: 11000 },
      ])
    })

    it('fires once per call and never repeats', () => {
      seedVoice(db, { partNames: ['gitara', 'wokal'] })
      session.start('rd-1')
      session.next()
      // Nothing left to skip, so the next visible call has not changed and the
      // band hears nothing new.
      session.skipNext()

      expect(plans.map((p) => p?.callId ?? null)).toEqual(['call-1', null])
    })
  })

  describe('skip', () => {
    it('announces the call a skip promoted, immediately', () => {
      vi.useFakeTimers()
      seedVoice(db)
      session.start('rd-1')
      vi.advanceTimersByTime(1000)
      session.skipNext()

      // A skipped Call extends the countdown: the band plays through its time
      // and only then reaches what follows, so the lead is the remainder of the
      // live Call (11s) plus the skipped Call's planned 12s.
      expect(plans[1]).toEqual({
        callId: 'call-2',
        cues: [
          { url: clipUrl('refren za'), atMs: 13000 - PHRASE_MS },
          { url: numberUrl(10), atMs: 13000 },
          { url: numberUrl(5), atMs: 18000 },
          { url: numberUrl(3), atMs: 20000 },
          { url: numberUrl(2), atMs: 21000 },
          { url: numberUrl(1), atMs: 22000 },
        ],
      })
    })

    it('cuts off an announcement with nothing when the last call is skipped', () => {
      seedVoice(db, { partNames: ['gitara', 'wokal'] })
      session.start('rd-1')
      session.skipNext()

      expect(plans[plans.length - 1]).toBeNull()
    })

    it('says nothing during overrun', () => {
      vi.useFakeTimers()
      seedVoice(db)
      session.start('rd-1')
      // Past the whole span the skip leaves behind — the live Call's 12s plus
      // the skipped Call's 12s. A held moment does not nag the band.
      vi.advanceTimersByTime(30000)
      session.skipNext()

      expect(plans[1]).toBeNull()
    })

    it('still announces inside the span a skip extends, before it is used up', () => {
      vi.useFakeTimers()
      seedVoice(db)
      session.start('rd-1')
      // Past the live Call's own 12s, but not past the 24s the skip makes
      // available — there is real time left, so this is not overrun.
      vi.advanceTimersByTime(20000)
      session.skipNext()

      expect(plans[1]).not.toBeNull()
      expect(plans[1]!.callId).toBe('call-2')
    })
  })

  describe('stop', () => {
    it('cuts off whatever is speaking', () => {
      seedVoice(db)
      session.start('rd-1')
      session.stop()

      expect(plans[plans.length - 1]).toBeNull()
    })

    it('says nothing more once the last call goes live', () => {
      seedVoice(db, { partNames: ['gitara', 'wokal'] })
      session.start('rd-1')
      session.next()

      expect(plans[plans.length - 1]).toBeNull()
    })
  })

  describe('camera rundowns', () => {
    it('never announces anything', () => {
      seed(db)
      session.start('rd-1')
      session.next()
      session.skipNext()
      session.stop()

      expect(plans).toEqual([])
    })
  })

  describe('wiring', () => {
    it('refuses to announce with nowhere to find clips', () => {
      expect(() => createLiveSession(db, { onAnnouncement: () => {} })).toThrow(/clipsDir/)
    })
  })
})
