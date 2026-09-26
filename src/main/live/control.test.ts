import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db/index'
import { createLiveSession, type LiveSession } from './session'
import { createLiveControl, type LiveControl } from './control'
import type { OBSSwitcher } from '../obs/switcher'
import type { ChangePublisher } from '../publisher'
import type { LiveState } from '../../shared/ipc-contract'

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

/** Records which switcher calls happened, in order, without an OBS anywhere. */
interface FakeSwitcher extends OBSSwitcher {
  calls: string[]
}

function fakeObs(): FakeSwitcher {
  const calls: string[] = []
  const record = (name: string) => (): Promise<void> => {
    calls.push(name)
    return Promise.resolve()
  }
  return {
    calls,
    takeLiveShot: record('takeLiveShot'),
    cueNextShot: record('cueNextShot'),
    cueRundownStart: record('cueRundownStart'),
    startFromPreview: record('startFromPreview'),
  }
}

interface FakePublisher extends ChangePublisher {
  rundownChangedCount: number
  liveStates: LiveState[]
  hiddenShotIds: string[]
}

function fakePublish(): FakePublisher {
  const p: FakePublisher = {
    rundownChangedCount: 0,
    liveStates: [],
    hiddenShotIds: [],
    rundownChanged() {
      p.rundownChangedCount++
    },
    liveStateChanged(state) {
      p.liveStates.push(state)
    },
    shotHidden(shotId) {
      p.hiddenShotIds.push(shotId)
    },
  }
  return p
}

describe('LiveControl', () => {
  let db: Database.Database
  let session: LiveSession
  let obs: FakeSwitcher
  let publish: FakePublisher
  let previewFirst: boolean
  let control: LiveControl

  beforeEach(() => {
    db = openMemoryDb()
    session = createLiveSession(db)
    obs = fakeObs()
    publish = fakePublish()
    previewFirst = false
    control = createLiveControl({
      session,
      obs,
      publish,
      previewFirst: () => previewFirst,
    })
  })

  afterEach(() => {
    db.close()
    vi.useRealTimers()
  })

  describe('the Transition guard', () => {
    it('ignores Next while the live Shot is in its Transition', () => {
      seed(db, { transitionMs: 2000 })
      session.setActiveRundown('rd-1')
      control.start()
      const publishedBefore = publish.liveStates.length
      const rundownChangesBefore = publish.rundownChangedCount
      const obsCallsBefore = obs.calls.length

      const state = control.next()

      expect(state.liveIndex).toBe(0)
      expect(publish.liveStates.length).toBe(publishedBefore)
      expect(publish.rundownChangedCount).toBe(rundownChangesBefore)
      expect(obs.calls.length).toBe(obsCallsBefore)
    })

    it('ignores Skip while the live Shot is in its Transition', () => {
      seed(db, { transitionMs: 2000 })
      session.setActiveRundown('rd-1')
      control.start()
      const obsCallsBefore = obs.calls.length

      control.skipNext()

      expect(publish.hiddenShotIds).toEqual([])
      expect(obs.calls.length).toBe(obsCallsBefore)
      expect(session.getVisibleQueue()).toHaveLength(3)
    })

    it('advances once the Transition has finished', () => {
      vi.useFakeTimers()
      seed(db, { transitionMs: 2000 })
      session.setActiveRundown('rd-1')
      control.start()

      vi.advanceTimersByTime(2001)
      const state = control.next()

      expect(state.liveIndex).toBe(1)
      expect(publish.hiddenShotIds).toEqual(['shot-0'])
    })
  })

  describe('Next', () => {
    it('publishes the position and the hidden Shot, then takes the Shot in OBS', () => {
      seed(db)
      session.setActiveRundown('rd-1')
      control.start()
      obs.calls.length = 0

      const state = control.next()

      expect(state.liveIndex).toBe(1)
      expect(publish.liveStates.at(-1)).toEqual(state)
      expect(publish.hiddenShotIds).toEqual(['shot-0'])
      expect(obs.calls).toEqual(['takeLiveShot'])
    })

    it('publishes rundownChanged when it runs past the last Shot', () => {
      seed(db, { shotCount: 2 })
      session.setActiveRundown('rd-1')
      control.start()
      control.next()
      const rundownChangesBefore = publish.rundownChangedCount

      const state = control.next()

      expect(state.running).toBe(false)
      // The queue emptied, so the Hidden flags phones hold are stale (ADR 0003).
      expect(publish.rundownChangedCount).toBe(rundownChangesBefore + 1)
    })

    it('throws when nothing is running and no start was asked for', () => {
      seed(db)
      session.setActiveRundown('rd-1')

      expect(() => control.next()).toThrow(/not running/)
    })
  })

  describe('Next with startIfStopped', () => {
    it('starts the Rundown, honouring Preview-first from the setting', () => {
      seed(db)
      session.setActiveRundown('rd-1')
      previewFirst = true

      const state = control.next({ startIfStopped: true })

      expect(state.running).toBe(true)
      expect(state.liveIndex).toBe(0)
      expect(obs.calls).toEqual(['startFromPreview'])
      expect(publish.rundownChangedCount).toBe(1)
    })

    it('cuts to program when Preview-first is off', () => {
      seed(db)
      session.setActiveRundown('rd-1')

      control.next({ startIfStopped: true })

      expect(obs.calls).toEqual(['takeLiveShot'])
    })

    it('does nothing when no Rundown is active', () => {
      const state = control.next({ startIfStopped: true })

      expect(state.running).toBe(false)
      expect(publish.liveStates).toEqual([])
      expect(obs.calls).toEqual([])
    })

    it('advances normally once the Live session is running', () => {
      seed(db)
      session.setActiveRundown('rd-1')
      control.next({ startIfStopped: true })

      const state = control.next({ startIfStopped: true })

      expect(state.liveIndex).toBe(1)
      expect(publish.hiddenShotIds).toEqual(['shot-0'])
    })
  })

  describe('Start', () => {
    it('takes the opening Shot to program when told not to use Preview-first', () => {
      seed(db)
      previewFirst = true

      const state = control.start({ rundownId: 'rd-1', previewFirst: false })

      expect(state.running).toBe(true)
      expect(obs.calls).toEqual(['takeLiveShot'])
      expect(publish.liveStates).toEqual([state])
      expect(publish.rundownChangedCount).toBe(1)
    })

    it('refuses when there is no active Rundown to start', () => {
      expect(() => control.start()).toThrow(/no active rundown/)
    })
  })

  describe('Stop', () => {
    it('publishes the position and the Rundown', () => {
      seed(db)
      session.setActiveRundown('rd-1')
      control.start()
      const rundownChangesBefore = publish.rundownChangedCount

      const state = control.stop()

      expect(state.running).toBe(false)
      expect(publish.liveStates.at(-1)).toEqual(state)
      expect(publish.rundownChangedCount).toBe(rundownChangesBefore + 1)
    })
  })

  describe('Restart', () => {
    it('publishes rundownChanged because the queue refills with every Shot visible', () => {
      seed(db)
      session.setActiveRundown('rd-1')
      control.start()
      control.next()
      const rundownChangesBefore = publish.rundownChangedCount
      obs.calls.length = 0

      const state = control.restart()

      expect(state.liveIndex).toBe(0)
      expect(session.getVisibleQueue()).toHaveLength(3)
      expect(publish.rundownChangedCount).toBe(rundownChangesBefore + 1)
      expect(obs.calls).toEqual(['takeLiveShot'])
    })
  })

  describe('Skip', () => {
    it('publishes the skipped Shot as hidden and re-cues preview', () => {
      seed(db)
      session.setActiveRundown('rd-1')
      control.start()
      obs.calls.length = 0
      const publishedBefore = publish.liveStates.length

      const state = control.skipNext()

      expect(publish.hiddenShotIds).toEqual(['shot-1'])
      expect(publish.liveStates.length).toBe(publishedBefore + 1)
      expect(publish.liveStates.at(-1)).toEqual(state)
      expect(obs.calls).toEqual(['cueNextShot'])
      // Program is untouched: a Skip never puts anything new on air.
      expect(state.liveIndex).toBe(0)
    })

    it('leaves program alone when there is nothing left to skip', () => {
      seed(db, { shotCount: 1 })
      session.setActiveRundown('rd-1')
      control.start()
      obs.calls.length = 0

      control.skipNext()

      expect(publish.hiddenShotIds).toEqual([])
      expect(obs.calls).toEqual(['cueNextShot'])
    })
  })
})
