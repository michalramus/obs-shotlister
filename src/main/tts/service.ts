/**
 * Running a render, and sweeping what is left over.
 *
 * Everything this does was decided elsewhere: `ipc/tts` says what is wanted and
 * what is orphaned, `tts/engine` knows how to spawn Piper. This is the thin
 * caller that performs the process spawn and the file IO, holds the one piece
 * of state a render has — whether one is already running — and refuses to run
 * at the two moments it must not.
 *
 * Untested by design (see the issue's testing decisions): it does nothing but
 * sequence modules that are tested, and every path through it touches the
 * filesystem or the Piper binary.
 */

import type Database from 'better-sqlite3'
import type { ProjectRenderStatus } from '../../shared/ipc-contract'
import {
  forgetClips,
  missingClips,
  orphanedClips,
  projectRenderStatus,
  recordPartRenders,
  recordClip,
} from '../ipc/tts'
import { getGlobalVoiceSettings } from '../ipc/settings'
import { ensureClipsDir, listCachedHashes, sweep } from './cache'
import { renderAll } from './engine'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface RenderService {
  /** What the warning strip and the Parts panel read. Never synthesises. */
  status: (projectId: string) => Promise<ProjectRenderStatus>
  /**
   * Renders everything missing across every Rundown in the Project.
   *
   * Refused outright while a Live session is running (ADR 0005): synthesis
   * competes for CPU with the machine driving OBS, which is the one machine
   * that cannot afford a spike.
   */
  renderMissing: (projectId: string) => Promise<ProjectRenderStatus>
  /**
   * Deletes clips no Project wants any more.
   *
   * Called at app start and app close only, never while a session might be
   * running — nothing may touch the cache directory during a show.
   */
  sweepOrphans: () => Promise<number>
  /**
   * Renders shortly after a change, when the operator has asked for that.
   *
   * Debounced, because the trigger is editing: renaming a Part fires on every
   * keystroke the caller reports, and synthesising each intermediate name would
   * fill the cache with clips that are orphaned before they finish. A no-op
   * when the setting is off, which is the default — a slow machine must not
   * synthesise while the operator is still working.
   */
  scheduleAutoRender: (projectId: string) => void
}

/** Long enough to cover typing a Part name, short enough to feel automatic. */
const AUTO_RENDER_DEBOUNCE_MS = 3000

export function createRenderService(
  db: Database.Database,
  userDataDir: string,
  isLive: () => boolean,
  onStatus?: (status: ProjectRenderStatus) => void,
): RenderService {
  let rendering = false
  let autoRenderTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Set once the engine has proved it cannot run at all. Only an explicit
   * render clears it: the operator has to have done something about the
   * binary, and asking is the signal that they think they have.
   */
  let engineBroken = false

  async function statusFor(projectId: string): Promise<ProjectRenderStatus> {
    // Read the cache from the filesystem rather than from `tts_clips`, so a
    // clip deleted behind our back reads as missing rather than as rendered.
    const cached = await listCachedHashes(userDataDir)
    return projectRenderStatus(db, projectId, cached, rendering)
  }

  async function renderMissing(projectId: string): Promise<ProjectRenderStatus> {
    if (isLive()) {
      throw new Error('Cannot render while a Live session is running')
    }
    if (rendering) return statusFor(projectId)

    // An explicit ask is the operator saying they have dealt with it.
    engineBroken = false
    rendering = true
    try {
      onStatus?.(await statusFor(projectId))

      await ensureClipsDir(userDataDir)
      const cached = await listCachedHashes(userDataDir)
      const items = missingClips(db, projectId, cached)

      const byHash = new Map(items.map((item) => [item.hash, item]))
      const result = await renderAll(items, { userDataDir })

      for (const clip of result.rendered) {
        const item = byHash.get(clip.hash)
        if (item) recordClip(db, item, clip.durationMs)
      }
      // Written after the clips exist, so a crash mid-render leaves Parts
      // reading as missing rather than as rendered against nothing.
      recordPartRenders(db, projectId)

      if (result.engineFailure) {
        // One line, not sixty-one: the batch stopped because the engine cannot
        // run, so every remaining clip would have reported the same thing.
        // Latched so auto-render stops retrying a binary that cannot work —
        // the operator saw this repeat on every debounce.
        engineBroken = true
        console.error('[tts] rendering stopped —', result.engineFailure)
        throw new Error(result.engineFailure)
      }
      for (const failure of result.failed) {
        console.error('[tts] failed to render', failure.item.text, failure.message)
      }
    } finally {
      rendering = false
    }

    const status = await statusFor(projectId)
    onStatus?.(status)
    return status
  }

  return {
    status: statusFor,
    renderMissing,

    scheduleAutoRender(projectId) {
      if (!getGlobalVoiceSettings(db).autoRender) return
      // Retrying an engine that cannot be executed only refills the log.
      if (engineBroken) return

      if (autoRenderTimer) clearTimeout(autoRenderTimer)
      autoRenderTimer = setTimeout(() => {
        autoRenderTimer = null
        // Re-checked rather than trusted from when it was scheduled: a session
        // may have started during the debounce, and nothing synthesises then.
        if (isLive()) return
        renderMissing(projectId).catch((err: unknown) =>
          console.error('[tts] auto-render failed:', messageOf(err)),
        )
      }, AUTO_RENDER_DEBOUNCE_MS)
      // Never hold the app open waiting to synthesise.
      autoRenderTimer.unref?.()
    },

    async sweepOrphans() {
      if (isLive() || rendering) return 0

      const cached = await listCachedHashes(userDataDir)
      const orphans = orphanedClips(db, cached)
      if (orphans.length === 0) return 0

      // Only what actually went: a clip that could not be deleted still exists
      // and still answers a cache lookup, so forgetting its row would make the
      // index disagree with the disk.
      const swept = await sweep(userDataDir, orphans, (hash, error) =>
        console.error('[tts] could not sweep', hash, messageOf(error)),
      )
      forgetClips(db, swept)
      return swept.length
    },
  }
}
