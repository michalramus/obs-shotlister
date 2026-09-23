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
import type { AnnouncementPlan, LiveState } from '../../shared/ipc-contract'
import { listShots } from '../ipc/shots'
import { getRundown, unassignedItemCount } from '../ipc/rundowns'
import { effectiveDurationMs } from '../../shared/timing'
import { createAnnouncementBuilder } from './announcer'

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

export interface LiveSessionOptions {
  /**
   * Called with the Announcement to speak before the next visible Call, and
   * with `null` to cut off whatever is speaking without starting anything.
   *
   * A collaborator rather than a direct push, because the session must stay
   * playable against an in-memory database with no audio and no Electron: the
   * caller decides that "a plan" means "send it to the renderer".
   */
  onAnnouncement?: (plan: AnnouncementPlan | null) => void
  /** Where rendered clips live, normally `<userData>/tts`. */
  clipsDir?: string
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

export function createLiveSession(
  db: Database.Database,
  options: LiveSessionOptions = {},
): LiveSession {
  let queue: LiveQueueEntry[] = []
  let liveShotId: string | null = null
  let startedAt: number | null = null
  let running = false
  /** Which Call the last plan was issued for; an Announcement never repeats. */
  let announcedCallId: string | null = null

  const { onAnnouncement } = options
  if (onAnnouncement && options.clipsDir === undefined) {
    // Fail at construction rather than as silence on show night: a session that
    // announces needs somewhere to find its clips, and there is no useful
    // default to guess at from here.
    throw new Error('createLiveSession: onAnnouncement requires clipsDir')
  }
  const announcer = onAnnouncement
    ? createAnnouncementBuilder(db, options.clipsDir as string)
    : null

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

  // --- Announcements -------------------------------------------------------
  //
  // A Camera Rundown is untouched by all of this: it keeps its fixed countdown
  // Cues and gains no speech. Only a Voice-over Rundown reaches the callback,
  // and only when the *next visible* Call changes — which is what makes an
  // Announcement fire once per Call and never repeat.

  function isVoiceRundown(rundownId: string | null): boolean {
    if (!rundownId) return false
    return getRundown(db, rundownId)?.kind === 'voice'
  }

  /**
   * Hands a plan to the caller. Errors are logged and swallowed: whatever the
   * renderer does with an Announcement, it may not abort the Live advance that
   * produced it — a show keeps running even when speech does not.
   */
  function emitAnnouncement(plan: AnnouncementPlan | null): void {
    try {
      onAnnouncement?.(plan)
    } catch (err) {
      console.error('[live] onAnnouncement threw:', err)
    }
  }

  /** Cuts off whatever is speaking. Silent when nothing was announced. */
  function cancelAnnouncement(): void {
    if (!onAnnouncement || announcedCallId === null) return
    announcedCallId = null
    emitAnnouncement(null)
  }

  /**
   * What the *plan* says is left before the next visible Call, not what a
   * stopwatch says.
   *
   * Timers are advisory (ADR 0002), so this is placed against planned durations
   * rather than measured ones. It spans the Hidden and Skipped Calls between the
   * live one and the next visible one — their time still passes, the operator
   * simply never switches to them — so the countdown tracks what the operator
   * will actually do rather than the index order. That is the same rule the Cue
   * Tray already counts down by, which is why it reuses `effectiveDurationMs`
   * rather than restating it.
   *
   * Past the duration this goes negative and the scheduler drops every cue,
   * which is how overrun stays silent without anyone having to ask whether it
   * is overrun.
   */
  function leadMsToNextCall(elapsedMs: number): number {
    const index = liveIndex()
    if (index === null) return 0
    const span = effectiveDurationMs(session.getShotsWithHiddenFlags(), index)
    return span === null ? 0 : span - elapsedMs
  }

  /** How long the live Call has actually been on air. Only Skip needs to ask. */
  function elapsedOnLiveCall(): number {
    return startedAt === null ? 0 : Date.now() - startedAt
  }

  /**
   * Issues a plan for the next visible Call, if that Call has changed.
   *
   * `elapsedMs` is how much of the live Call is already gone. Start, Next and
   * Restart pass 0 rather than measuring: the Call went live on the line above,
   * so the elapsed time is zero by construction, and re-reading the clock there
   * would only fold the cost of the lookup into the countdown.
   */
  function announce(elapsedMs: number): void {
    if (!onAnnouncement || !announcer) return

    let next: Shot | null
    let leadMs: number
    try {
      const { rundown_id } = selection()
      if (!running || !isVoiceRundown(rundown_id)) return
      next = session.getNextVisibleShot()
      leadMs = leadMsToNextCall(elapsedMs)
    } catch (err) {
      // Resolving what to say is never worth losing the advance that asked.
      console.error('[live] announce lookup failed:', err)
      return
    }

    if (!next) {
      cancelAnnouncement()
      return
    }
    if (next.id === announcedCallId) return

    // Issued even when the plan is null: a new Call became next, so whatever is
    // still speaking about the old one has to stop either way.
    announcedCallId = next.id
    emitAnnouncement(announcer.planFor(next, leadMs))
  }

  /**
   * Refuses to start a Rundown any of whose items has no target for its Kind.
   *
   * A refusal rather than a warning: a silent gap is discovered during the show,
   * which is the one moment it cannot be fixed. Unrendered speech is the other
   * way round — it warns and starts (ADR 0005), and that warning is the UI's.
   */
  function assertEveryItemAssigned(rundownId: string): void {
    const unassigned = unassignedItemCount(db, rundownId)
    if (unassigned === 0) return

    const voice = getRundown(db, rundownId)?.kind === 'voice'
    const items = unassigned === 1 ? '1 item' : `${unassigned} items`
    const kind = voice ? 'Voice-over Rundown' : 'Camera Rundown'
    const target = voice ? 'Part' : 'Camera'
    throw new Error(
      `Cannot start: ${items} in this ${kind} ${unassigned === 1 ? 'has' : 'have'} no ${target} assigned`,
    )
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
      assertEveryItemAssigned(rundownId)

      session.setActiveRundown(rundownId)

      queue = shots.map((s) => ({ ...s, hidden: false }))
      liveShotId = shots[0].id
      startedAt = Date.now()
      running = true
      announcedCallId = null

      const state = stateFrom(selection(), 0)
      announce(0)
      return state
    },

    stop() {
      const row = selection()
      resetProgress()
      cancelAnnouncement()
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
        cancelAnnouncement()
        return { state: stateFrom(row, null), hiddenShotId: null }
      }

      const hiddenShotId = liveShotId
      queue = queue.map((s) => (s.id === liveShotId ? { ...s, hidden: true } : s))
      liveShotId = upcoming.id
      startedAt = Date.now()

      const result = { state: stateFrom(row, liveIndex()), hiddenShotId }
      announce(0)
      return result
    },

    skipNext() {
      const row = selection()
      if (!running || !row.rundown_id) throw new Error('Cannot skip: not running')

      const visible = session.getVisibleQueue()
      const current = visible.findIndex((s) => s.id === liveShotId)
      const toSkip = visible[current + 1]

      if (!toSkip) return { state: stateFrom(row, liveIndex()), hiddenShotId: null }

      queue = queue.map((s) => (s.id === toSkip.id ? { ...s, hidden: true } : s))
      // Immediately, not at the next advance: the band must never be told to
      // play something the operator has just dropped.
      announce(elapsedOnLiveCall())
      return { state: stateFrom(row, liveIndex()), hiddenShotId: toSkip.id }
    },

    restart() {
      const row = selection()
      if (!row.rundown_id) throw new Error('Cannot restart: no active rundown')

      const shots = queueShots(row.rundown_id)
      if (shots.length === 0) throw new Error('Cannot restart: rundown has no shots')
      assertEveryItemAssigned(row.rundown_id)

      queue = shots.map((s) => ({ ...s, hidden: false }))
      liveShotId = shots[0].id
      startedAt = Date.now()
      running = true
      announcedCallId = null

      const state = stateFrom(row, 0)
      announce(0)
      return state
    },

    clear() {
      db.prepare('UPDATE live_state SET rundown_id = NULL WHERE id = 1').run()
      resetProgress()
      cancelAnnouncement()
    },
  }

  return session
}
