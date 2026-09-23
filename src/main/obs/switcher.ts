/**
 * Drives what OBS shows for a Live session.
 *
 * Owns the whole question "given the session, what should be on program and what
 * should be cued in preview?" — scene lookup, Transition resolution, the settle
 * delay, and cueing the next visible Shot. Callers say what happened; they do not
 * sequence OBS calls themselves.
 *
 * `client` and `session` are passed in rather than reached for, so this can be
 * driven against a fake OBS client in tests.
 */

import type Database from 'better-sqlite3'
import type { Shot } from '../../shared/types'
import type { OBSClient } from './client'
import type { LiveSession } from '../live/session'
import { getCameraById } from '../ipc/projects'
import { listShots } from '../ipc/shots'
import { getRundown } from '../ipc/rundowns'
import { resolveTransitionFull } from '../ipc/transitions'

/**
 * Extra delay after a Transition before touching preview. Re-cueing preview
 * while OBS is still mid-Transition makes it visibly flick to the incoming
 * scene, so preview is left alone until the Transition has finished.
 */
const PREVIEW_SETTLE_MS = 50

export interface OBSSwitcher {
  /** Cut or transition to the live Shot, then cue the next one in preview. */
  takeLiveShot: () => Promise<void>
  /** Re-cue preview only, leaving program alone. Used after a Skip. */
  cueNextShot: () => Promise<void>
  /** Cue the first Shot of a Rundown when it is opened, before any Live session. */
  cueRundownStart: (rundownId: string) => Promise<void>
  /** Start a Live session by transitioning from preview rather than cutting. */
  startFromPreview: () => Promise<void>
}

export function createOBSSwitcher(
  db: Database.Database,
  client: OBSClient,
  session: LiveSession,
): OBSSwitcher {
  /**
   * Whether this Rundown drives OBS at all.
   *
   * Deliberately separate from `sceneFor`, which already returns null for an
   * unassigned item: "this item has no Camera" and "this Rundown never switches"
   * are different facts, and only the second is a guarantee. A Voice-over
   * Rundown must not be able to disturb a live video feed even by accident — an
   * item carrying a leftover `camera_id` from a conversion would otherwise cut
   * program mid-song.
   */
  function switchesScenes(rundownId: string | null): boolean {
    if (!rundownId) return false
    try {
      return getRundown(db, rundownId)?.kind !== 'voice'
    } catch (err) {
      // Unknown Kind means unknown consequences: stay off OBS.
      console.error('[OBS] rundown kind lookup failed:', err)
      return false
    }
  }

  function sceneFor(shot: Shot | null): string | null {
    // A Call has no Camera, so a Voice-over Rundown resolves no scene and the
    // switcher has nothing to do.
    if (!shot || !shot.cameraId) return null
    return getCameraById(db, shot.cameraId)?.obsScene ?? null
  }

  /** A Shot with no Transition name is a cut; a named one uses its own duration. */
  function transitionFor(shot: Shot): { obsName: string; durationMs: number } {
    const logical = shot.transitionName ?? 'cut'
    const { obsName, constLengthMs } = resolveTransitionFull(db, logical)
    const durationMs = logical === 'cut' || constLengthMs !== null ? 0 : (shot.transitionMs ?? 0)
    return { obsName, durationMs }
  }

  async function settle(transitionMs: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, transitionMs + PREVIEW_SETTLE_MS))
  }

  async function applyTransition(shot: Shot): Promise<void> {
    const { obsName, durationMs } = transitionFor(shot)
    try {
      await client.setCurrentSceneTransition(obsName, durationMs)
    } catch (err) {
      console.error('[OBS] setTransition:', obsName, err)
    }
    try {
      await client.triggerStudioModeTransition()
    } catch (err) {
      console.error('[OBS] triggerTransition:', err)
    }
  }

  async function cuePreview(shot: Shot | null): Promise<void> {
    const scene = sceneFor(shot)
    if (!scene) return
    try {
      await client.setCurrentPreviewScene(scene)
    } catch (err) {
      console.error('[OBS] setPreview:', scene, err)
    }
  }

  const switcher: OBSSwitcher = {
    async takeLiveShot() {
      if (client.status !== 'connected') return
      const state = session.getState()
      if (!state.running) return
      if (!switchesScenes(state.rundownId)) return

      const liveShot = session.getLiveShot()
      if (!liveShot) return

      if (sceneFor(liveShot)) await applyTransition(liveShot)
      await settle(liveShot.transitionMs ?? 0)
      await cuePreview(session.getNextVisibleShot())
    },

    async cueNextShot() {
      if (client.status !== 'connected') return
      const state = session.getState()
      if (!state.running) return
      if (!switchesScenes(state.rundownId)) return
      await cuePreview(session.getNextVisibleShot())
    },

    async cueRundownStart(rundownId) {
      if (client.status !== 'connected') return
      if (!switchesScenes(rundownId)) return
      // No Live session yet, so the Rundown's own first Shot is what to cue.
      await cuePreview(listShots(db, rundownId)[0] ?? null)
    },

    async startFromPreview() {
      if (client.status !== 'connected') {
        console.warn('[OBS] startFromPreview: not connected, cutting instead')
        return switcher.takeLiveShot()
      }
      const state = session.getState()
      if (!state.running) return
      if (!switchesScenes(state.rundownId)) return

      const liveShot = session.getLiveShot()
      if (!liveShot) return

      if (!sceneFor(liveShot)) {
        console.warn('[OBS] startFromPreview: live shot camera has no scene, cutting instead')
        return switcher.takeLiveShot()
      }

      // Cue the opening Shot, let OBS settle, then transition it to program.
      await cuePreview(liveShot)
      await new Promise<void>((resolve) => setTimeout(resolve, PREVIEW_SETTLE_MS))
      await applyTransition(liveShot)
      await settle(liveShot.transitionMs ?? 0)
      await cuePreview(session.getNextVisibleShot())
    },
  }

  return switcher
}
