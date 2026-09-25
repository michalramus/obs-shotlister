/**
 * Running a render, and sweeping what is left over.
 *
 * Everything this does was decided elsewhere: `ipc/speech` says what is wanted and
 * what is orphaned, `speech/engine` knows how to spawn Piper. This is the thin
 * caller that performs the process spawn and the file IO, holds the one piece
 * of state a render has — whether one is already running — and refuses to run
 * at the two moments it must not.
 *
 * Untested by design (see the issue's testing decisions): it does nothing but
 * sequence modules that are tested, and every path through it touches the
 * filesystem or the Piper binary.
 */

import { readFile } from 'node:fs/promises'
import type Database from 'better-sqlite3'
import type { ProjectRenderSummary } from '../../shared/ipc-contract'
import {
  clipsNeedingDurations,
  clipsOnlyUsedBy,
  forgetClips,
  vanishedClips,
  forgetPartRenders,
  missingClips,
  orphanedClips,
  projectRenderSummary,
  recordPartRenders,
  recordClip,
} from '../ipc/speech'
import { getGlobalVoiceSettings } from '../ipc/settings'
import { clipPath, ensureClipsDir, listCachedHashes, sweep } from './cache'
import { audibleDurationMs, downloadedVoicesDir, renderAll } from './engine'
import { ensureVoice } from './voices'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface RenderService {
  /** What the warning strip and the Parts panel read. Never synthesises. */
  status: (projectId: string) => Promise<ProjectRenderSummary>
  /**
   * Renders everything missing across every Rundown in the Project.
   *
   * Refused outright while a Live session is running (ADR 0005): synthesis
   * competes for CPU with the machine driving OBS, which is the one machine
   * that cannot afford a spike.
   */
  renderMissing: (projectId: string) => Promise<ProjectRenderSummary>
  /**
   * Measures cached clips that have no recorded duration, and records it.
   *
   * Repair, not routine: see {@link clipsNeedingDurations}. Cheap when there is
   * nothing to do — one directory listing and one query — so it runs at every
   * start rather than behind a flag nobody would know to set.
   */
  backfillDurations: () => Promise<number>
  /**
   * Deletes clips no Project wants any more.
   *
   * Called at app start and app close only, never while a session might be
   * running — nothing may touch the cache directory during a show.
   */
  sweepOrphans: () => Promise<number>
  /**
   * The same sweep, asked for by the operator.
   *
   * Separate from {@link sweepOrphans} only in how it refuses: the automatic
   * sweep returns zero at a bad moment because nobody is watching, while
   * someone who pressed a button is owed the reason nothing happened.
   */
  cleanOrphans: (projectId: string) => Promise<number>
  /**
   * Deletes the audio belonging to one Project — what an archived Project's
   * cache costs, reclaimed.
   *
   * Only clips no other Project wants: see {@link clipsOnlyUsedBy}. The Parts
   * survive; they simply read as `missing` afterwards, and a later render
   * brings the audio back.
   */
  deleteProjectClips: (projectId: string) => Promise<number>
  /**
   * Renders whatever a Project is missing, when the operator has asked for that
   * to happen by itself.
   *
   * The condition is "something is unrendered", not "something just changed" —
   * so this is called on an edit, on a Voice change, when a Project becomes
   * active and at app start. Anything that leaves audio missing should end up
   * here, because that is what the setting promises.
   *
   * Debounced, because one of those triggers is editing: renaming a Part fires
   * on every keystroke the caller reports, and synthesising each intermediate
   * name would fill the cache with clips that are orphaned before they finish.
   * Projects queued during the debounce are all rendered, one after another —
   * a global Voice change makes every Project stale at once, and only doing the
   * last of them would leave the rest silently unrendered.
   *
   * A no-op when the setting is off, which is the default — a slow machine must
   * not synthesise while the operator is still working.
   */
  scheduleAutoRender: (projectId: string) => void
}

/** Long enough to cover typing a Part name, short enough to feel automatic. */
const AUTO_RENDER_DEBOUNCE_MS = 3000

export function createRenderService(
  db: Database.Database,
  userDataDir: string,
  isLive: () => boolean,
  onStatus?: (status: ProjectRenderSummary) => void,
): RenderService {
  let rendering = false
  let autoRenderTimer: ReturnType<typeof setTimeout> | null = null
  /** Projects queued during the current debounce. Every one of them renders. */
  const autoRenderQueue = new Set<string>()
  /**
   * How far the render in flight has got, or null when none is.
   *
   * Reported because a batch is slow enough to look wedged: the Apple Silicon
   * engine spends about five seconds per clip, so sixty numbers is five minutes
   * during which a bare "Rendering..." says nothing at all.
   */
  let progress: { completed: number; total: number; stage?: string } | null = null
  /**
   * Set once the engine has proved it cannot run at all. Only an explicit
   * render clears it: the operator has to have done something about the
   * binary, and asking is the signal that they think they have.
   */
  let engineBroken = false

  async function statusFor(projectId: string): Promise<ProjectRenderSummary> {
    // Read the cache from the filesystem rather than from `speech_clips`, so a
    // clip deleted behind our back reads as missing rather than as rendered.
    const cached = await listCachedHashes(userDataDir)
    const summary = projectRenderSummary(db, projectId, cached, rendering)
    return progress === null ? summary : { ...summary, progress }
  }

  function pushStatus(projectId: string): void {
    if (!onStatus) return
    statusFor(projectId)
      .then(onStatus)
      .catch((err: unknown) => console.error('[speech] status push failed:', messageOf(err)))
  }

  async function renderMissing(projectId: string): Promise<ProjectRenderSummary> {
    if (isLive()) {
      throw new Error('Cannot render while a Live session is running')
    }
    if (rendering) return statusFor(projectId)

    // An explicit ask is the operator saying they have dealt with it.
    engineBroken = false
    rendering = true
    try {
      await ensureClipsDir(userDataDir)
      const cached = await listCachedHashes(userDataDir)
      const items = missingClips(db, projectId, cached)
      progress = { completed: 0, total: items.length }
      onStatus?.(await statusFor(projectId))

      // Once per batch, not once per clip: every item here names a Voice, and
      // a Voice the operator picked may simply never have been installed. It is
      // a download of a hundred-odd megabytes, so it happens here, before a
      // single clip is attempted, rather than inside the loop.
      for (const voice of new Set(items.map((item) => item.voice))) {
        await ensureVoice(voice, {
          voicesDir: downloadedVoicesDir(userDataDir),
          onDownload: (id, bytes) => {
            const mb = Math.round(bytes / 1_000_000)
            console.log(`[speech] installing voice ${id} (${mb} MB)`)
            progress = { completed: 0, total: items.length, stage: `Installing voice ${id}` }
            pushStatus(projectId)
          },
        })
      }

      const byHash = new Map(items.map((item) => [item.hash, item]))
      const result = await renderAll(items, { userDataDir }, (step) => {
        progress = { completed: step.completed, total: step.total }
        // Recorded here rather than after the batch, so a render interrupted
        // halfway leaves every clip it finished with a usable duration. Written
        // after the file is in place, which `synthesise` guarantees before it
        // reports the clip.
        if (step.clip) {
          const item = byHash.get(step.clip.hash)
          if (item) recordClip(db, item, step.clip.durationMs)
        }
        if (step.error === undefined) {
          console.log(`[speech] ${step.completed}/${step.total} rendered "${step.item.text}"`)
        }
        pushStatus(projectId)
      })

      // Written after the clips exist, so a crash mid-render leaves Parts
      // reading as missing rather than as rendered against nothing.
      recordPartRenders(db, projectId)

      if (result.engineFailure) {
        // One line, not sixty-one: the batch stopped because the engine cannot
        // run, so every remaining clip would have reported the same thing.
        // Latched so auto-render stops retrying a binary that cannot work —
        // the operator saw this repeat on every debounce.
        engineBroken = true
        console.error('[speech] rendering stopped —', result.engineFailure)
        throw new Error(result.engineFailure)
      }
      for (const failure of result.failed) {
        console.error('[speech] failed to render', failure.item.text, failure.message)
      }
    } catch (error) {
      // Latched for the same reason an unusable engine is: nothing in this batch
      // or the next can succeed without the voice, and auto-render would
      // otherwise restart a hundred-megabyte download every few seconds.
      engineBroken = true
      throw error
    } finally {
      rendering = false
      progress = null
    }

    const status = await statusFor(projectId)
    onStatus?.(status)
    return status
  }

  async function sweepNow(): Promise<number> {
    const cached = await listCachedHashes(userDataDir)

    // Rows first, and unconditionally: a clip whose file went without the sweep
    // taking it is invisible to `orphanedClips`, so its row would otherwise
    // survive every sweep there will ever be. Not counted in the return value —
    // the caller reports clips deleted, and no clip was.
    forgetClips(db, vanishedClips(db, cached))

    const orphans = orphanedClips(db, cached)
    if (orphans.length === 0) return 0

    // Only what actually went: a clip that could not be deleted still exists
    // and still answers a cache lookup, so forgetting its row would make the
    // index disagree with the disk.
    const swept = await sweep(userDataDir, orphans, (hash, error) =>
      console.error('[speech] could not sweep', hash, messageOf(error)),
    )
    forgetClips(db, swept)
    return swept.length
  }

  return {
    status: statusFor,
    renderMissing,

    async backfillDurations() {
      if (isLive() || rendering) return 0

      const cached = await listCachedHashes(userDataDir)
      const items = clipsNeedingDurations(db, cached)
      if (items.length === 0) return 0

      let measured = 0
      const unreadable: string[] = []
      for (const item of items) {
        try {
          recordClip(db, item, audibleDurationMs(await readFile(clipPath(userDataDir, item.hash))))
          measured++
        } catch (error) {
          // A clip that cannot be measured is a clip that was never finished
          // writing. Deleting it is what puts it back in reach of a render;
          // left alone it would read as rendered forever and never be spoken.
          console.error('[speech] unreadable clip, discarding', item.hash, messageOf(error))
          unreadable.push(item.hash)
        }
      }
      if (unreadable.length > 0) {
        forgetClips(db, await sweep(userDataDir, unreadable))
      }
      console.log(`[speech] recovered the length of ${measured} clip(s) already on disk`)
      return measured
    },

    async sweepOrphans() {
      if (isLive() || rendering) return 0
      return sweepNow()
    },

    async cleanOrphans(projectId) {
      if (isLive()) throw new Error('Cannot clean recordings while a Live session is running')
      if (rendering) throw new Error('Cannot clean recordings while a render is running')

      const swept = await sweepNow()
      onStatus?.(await statusFor(projectId))
      return swept
    },

    async deleteProjectClips(projectId) {
      if (isLive()) throw new Error('Cannot delete recordings while a Live session is running')
      if (rendering) throw new Error('Cannot delete recordings while a render is running')

      const cached = await listCachedHashes(userDataDir)
      const hashes = clipsOnlyUsedBy(db, projectId, cached)
      const gone = await sweep(userDataDir, hashes, (hash, error) =>
        console.error('[speech] could not delete', hash, messageOf(error)),
      )
      forgetClips(db, gone)
      // Dropped whether or not every file went: these rows describe what this
      // Project rendered, and it no longer claims to have rendered anything.
      forgetPartRenders(db, projectId)
      console.log(`[speech] deleted ${gone.length} clip(s) for project ${projectId}`)

      onStatus?.(await statusFor(projectId))
      return gone.length
    },

    scheduleAutoRender(projectId) {
      if (!getGlobalVoiceSettings(db).autoRender) return
      // Retrying an engine that cannot be executed only refills the log.
      if (engineBroken) return

      autoRenderQueue.add(projectId)
      if (autoRenderTimer) clearTimeout(autoRenderTimer)
      autoRenderTimer = setTimeout(() => {
        autoRenderTimer = null
        const queued = [...autoRenderQueue]
        autoRenderQueue.clear()

        void (async () => {
          for (const id of queued) {
            // Re-checked every time rather than trusted from when it was
            // scheduled: a session may start part-way through, and nothing
            // synthesises then. A queue dropped this way is not retried — the
            // operator can render by hand after the show, and starting a batch
            // the moment a session ends is the last thing that machine needs.
            if (isLive() || engineBroken) return
            try {
              await renderMissing(id)
            } catch (err: unknown) {
              console.error('[speech] auto-render failed:', messageOf(err))
            }
          }
        })()
      }, AUTO_RENDER_DEBOUNCE_MS)
      // Never hold the app open waiting to synthesise.
      autoRenderTimer.unref?.()
    },
  }
}
