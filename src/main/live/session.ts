/**
 * One run of a Rundown.
 *
 * A Live session is split across two stores: the *selection* (which Rundown and
 * Project are active) is durable, and the *progress* (the Live queue, which Shot
 * is live, when it went live, whether it is running) is held in memory and never
 * written to the database — see docs/adr/0001-live-progress-is-never-persisted.md.
 *
 * That split is the whole reason this module exists. Callers ask questions and
 * get answers; they never need to know which half an answer came from. Reaching
 * past this interface to query progress columns is what silently disabled the
 * OSC transition guard, because those columns do not exist.
 *
 * Progress lives on the instance rather than in module-level variables, so tests
 * get a fresh session per database instead of sharing one.
 */

import type Database from 'better-sqlite3'
import type { Shot } from '../../shared/types'
import type { LiveState } from '../../shared/ipc-contract'
import { listShots } from '../ipc/shots'

interface LiveStateRow {
  rundown_id: string | null
  project_id: string | null
}

interface QueueShotRow {
  id: string
  order_index: number
  duration_ms: number
}

/** A Shot as the Live queue sees it: the stored Shot plus whether it is hidden. */
export interface LiveQueueEntry extends QueueShotRow {
  hidden: boolean
}

export interface NextShotResult {
  state: LiveState
  hiddenShotId: string | null
}

export interface LiveSession {
  // --- Reads -------------------------------------------------------------
  getState: () => LiveState
  getQueue: () => LiveQueueEntry[]
  getVisibleQueue: () => LiveQueueEntry[]
  /** The Rundown's Shots carrying the Live queue's hidden flags. */
  getShotsWithHiddenFlags: () => Shot[]
  /** The Shot currently on air, or null when idle. */
  getLiveShot: () => Shot | null
  /** The first Shot after the live one that has not been consumed or skipped. */
  getNextVisibleShot: () => Shot | null
  /** True while the live Shot is still inside its in-Transition window. */
  isInTransition: () => boolean

  // --- Selection (durable) -----------------------------------------------
  setActiveRundown: (rundownId: string | null) => void
  setActiveProject: (projectId: string | null) => void

  // --- Progress (in memory) ----------------------------------------------
  start: (rundownId: string) => LiveState
  stop: () => LiveState
  next: () => NextShotResult
  skipNext: () => NextShotResult
  restart: () => LiveState
  /** Clears progress and the active Rundown. Used on app start. */
  clear: () => void
}

export function createLiveSession(db: Database.Database): LiveSession {
  let queue: LiveQueueEntry[] = []
  let liveShotId: string | null = null
  let startedAt: number | null = null
  let running = false

  function selection(): LiveStateRow {
    return db
      .prepare('SELECT rundown_id, project_id FROM live_state WHERE id = 1')
      .get() as LiveStateRow
  }

  function queueShots(rundownId: string): QueueShotRow[] {
    return db
      .prepare(
        'SELECT id, order_index, duration_ms FROM shots WHERE rundown_id = ? ORDER BY order_index ASC',
      )
      .all(rundownId) as QueueShotRow[]
  }

  function liveIndex(): number | null {
    if (!running || queue.length === 0) return null
    const index = queue.findIndex((s) => s.id === liveShotId)
    return index === -1 ? null : index
  }

  function stateFrom(row: LiveStateRow, index: number | null): LiveState {
    return {
      rundownId: row.rundown_id,
      projectId: row.project_id,
      liveIndex: index,
      startedAt,
      running,
    }
  }

  function resetProgress(): void {
    queue = []
    liveShotId = null
    startedAt = null
    running = false
  }

  function hiddenIds(): Set<string> {
    return new Set(queue.filter((s) => s.hidden).map((s) => s.id))
  }

  const session: LiveSession = {
    getState() {
      return stateFrom(selection(), liveIndex())
    },

    getQueue() {
      return queue
    },

    getVisibleQueue() {
      return queue.filter((s) => !s.hidden)
    },

    getShotsWithHiddenFlags() {
      const { rundown_id } = selection()
      if (!rundown_id) return []
      const shots = listShots(db, rundown_id)
      if (queue.length === 0) return shots
      const hidden = hiddenIds()
      return shots.map((s) => ({ ...s, hidden: hidden.has(s.id) }))
    },

    getLiveShot() {
      const { rundown_id } = selection()
      if (!rundown_id || liveShotId === null) return null
      return listShots(db, rundown_id).find((s) => s.id === liveShotId) ?? null
    },

    getNextVisibleShot() {
      const { rundown_id } = selection()
      if (!rundown_id) return null
      const shots = listShots(db, rundown_id)
      const hidden = hiddenIds()
      // Before the first Next, nothing is live yet and the next visible Shot is
      // simply the first one that has not been skipped.
      const from = liveShotId === null ? 0 : shots.findIndex((s) => s.id === liveShotId) + 1
      if (from === 0 && liveShotId !== null) return null
      return shots.slice(from).find((s) => !hidden.has(s.id)) ?? null
    },

    isInTransition() {
      if (!running || liveShotId === null || startedAt === null) return false
      const shot = session.getLiveShot()
      if (!shot || shot.transitionMs <= 0) return false
      return Date.now() - startedAt < shot.transitionMs
    },

    setActiveRundown(rundownId) {
      db.prepare('UPDATE live_state SET rundown_id = ? WHERE id = 1').run(rundownId)
    },

    setActiveProject(projectId) {
      db.prepare('UPDATE live_state SET project_id = ? WHERE id = 1').run(projectId)
    },

    start(rundownId) {
      const shots = queueShots(rundownId)
      if (shots.length === 0) throw new Error('Cannot start: rundown has no shots')

      session.setActiveRundown(rundownId)

      queue = shots.map((s) => ({ ...s, hidden: false }))
      liveShotId = shots[0].id
      startedAt = Date.now()
      running = true

      return stateFrom(selection(), 0)
    },

    stop() {
      const row = selection()
      resetProgress()
      return stateFrom(row, null)
    },

    next() {
      const row = selection()
      if (!running || !row.rundown_id) throw new Error('Cannot advance: not running')

      const visible = session.getVisibleQueue()
      const current = visible.findIndex((s) => s.id === liveShotId)
      const upcoming = visible[current + 1]

      if (!upcoming) {
        // Past the last Shot — the Live session ends.
        resetProgress()
        return { state: stateFrom(row, null), hiddenShotId: null }
      }

      const hiddenShotId = liveShotId
      queue = queue.map((s) => (s.id === liveShotId ? { ...s, hidden: true } : s))
      liveShotId = upcoming.id
      startedAt = Date.now()

      return { state: stateFrom(row, liveIndex()), hiddenShotId }
    },

    skipNext() {
      const row = selection()
      if (!running || !row.rundown_id) throw new Error('Cannot skip: not running')

      const visible = session.getVisibleQueue()
      const current = visible.findIndex((s) => s.id === liveShotId)
      const toSkip = visible[current + 1]

      if (!toSkip) return { state: stateFrom(row, liveIndex()), hiddenShotId: null }

      queue = queue.map((s) => (s.id === toSkip.id ? { ...s, hidden: true } : s))
      return { state: stateFrom(row, liveIndex()), hiddenShotId: toSkip.id }
    },

    restart() {
      const row = selection()
      if (!row.rundown_id) throw new Error('Cannot restart: no active rundown')

      const shots = queueShots(row.rundown_id)
      if (shots.length === 0) throw new Error('Cannot restart: rundown has no shots')

      queue = shots.map((s) => ({ ...s, hidden: false }))
      liveShotId = shots[0].id
      startedAt = Date.now()
      running = true

      return stateFrom(row, 0)
    },

    clear() {
      db.prepare('UPDATE live_state SET rundown_id = NULL WHERE id = 1').run()
      resetProgress()
    },
  }

  return session
}
