/**
 * Deriving what a shotlist should show for a given live position.
 *
 * Both audiences — the operator window and the Phone view — need the same
 * answer, but they receive the live position over different transports. This is
 * the shared derivation; the two stores are adapters over it. Before it existed
 * each store made up its own rules and they disagreed about when the outgoing
 * Shot stops being visible.
 */

import type { Shot } from './types'

/**
 * The Shot that should stay visible while the incoming Shot's Transition runs,
 * or null when the incoming Shot is a cut.
 *
 * During a Transition both Shots are genuinely on screen in OBS, so hiding the
 * outgoing one the instant the Transition starts makes the list disagree with
 * the picture. It is hidden when the main process says so, once the Transition
 * has finished.
 */
export function shotHeldThroughTransition(shots: Shot[], liveIndex: number | null): string | null {
  if (liveIndex === null) return null
  const incoming = shots[liveIndex]
  if (!incoming || incoming.transitionMs <= 0) return null

  for (let i = liveIndex - 1; i >= 0; i--) {
    if (!shots[i].hidden) return shots[i].id
  }
  return null
}

/**
 * Applies a live position to the shotlist: every Shot before the live one is
 * hidden, except the one being held through the incoming Transition.
 *
 * Returns the original array when nothing changes, so stores can skip a render.
 */
export function applyLivePosition(shots: Shot[], liveIndex: number | null): Shot[] {
  if (liveIndex === null) return shots

  const held = shotHeldThroughTransition(shots, liveIndex)
  let changed = false

  const next = shots.map((shot, i) => {
    if (i >= liveIndex || shot.hidden || shot.id === held) return shot
    changed = true
    return { ...shot, hidden: true }
  })

  return changed ? next : shots
}

/**
 * Converts the elapsed time the main process reports into a local timestamp.
 *
 * Phones do not share the operator's clock, so the live position arrives as "how
 * long this Shot has been live" and is anchored against the receiver's own clock.
 */
export function startedAtFromElapsed(elapsedMs: number | null, now: number): number | null {
  return elapsedMs === null ? null : now - elapsedMs
}
