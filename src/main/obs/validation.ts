/**
 * Checks that OBS is configured the way the active Project and Rundown expect:
 * studio mode on, every mapped Camera scene present, every Transition resolvable.
 *
 * Takes the OBS client rather than reaching for a module-level one, so it can be
 * exercised against a fake client.
 */

import type Database from 'better-sqlite3'
import type { OBSClient } from './client'
import type { OBSValidateResult } from '../../shared/ipc-contract'
import { listCameras } from '../ipc/projects'
import { listShots } from '../ipc/shots'
import { getLiveState } from '../ipc/live'
import { resolveTransition } from '../ipc/transitions'

/** Returns null when OBS is not connected — there is nothing to validate against. */
export async function runOBSValidation(
  db: Database.Database,
  client: OBSClient,
): Promise<OBSValidateResult | null> {
  if (client.status !== 'connected') return null

  const liveState = getLiveState(db)
  const [studioModeEnabled, scenes, transitions] = await Promise.all([
    client.getStudioModeEnabled(),
    client.getSceneList(),
    client.getTransitionList(),
  ])

  const missingScenes: string[] = []
  if (liveState.projectId) {
    for (const cam of listCameras(db, liveState.projectId)) {
      if (cam.obsScene && !scenes.includes(cam.obsScene)) {
        missingScenes.push(cam.obsScene)
      }
    }
  }

  const missingTransitions: string[] = []
  if (liveState.rundownId) {
    const shots = listShots(db, liveState.rundownId)
    const used = new Set(
      shots
        .filter((s) => s.transitionName != null)
        .map((s) => resolveTransition(db, s.transitionName!)),
    )
    for (const name of used) {
      if (!transitions.includes(name)) missingTransitions.push(name)
    }
  }

  return { studioModeEnabled, missingScenes, missingTransitions }
}
