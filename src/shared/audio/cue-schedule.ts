/**
 * When each Output's copy of a Cue is due.
 *
 * A Cue is played at the moment it is wanted *heard*, and an Output takes its
 * delay to get there, so every Output's copy of the same Cue is a separate
 * moment: the copy for a route that buffers 400ms is played 400ms before the copy
 * on the operator's own speakers. The countdown and the beep at a Shot's expiry
 * are both fully predictable from the live Shot's timing, so the trigger — not
 * only the player — can know that.
 *
 * Extracted from the Live session's ticker and kept pure. It is arithmetic over
 * two remaining-time readings, and the awkward cases (one tick crossing two
 * moments, a delay longer than the countdown, a new Live session) are worth
 * proving in a unit test rather than discovering on show night.
 *
 * Nothing here plays anything, reads a clock or knows about a device.
 */

import type { Cue } from './cue-player'

/**
 * The countdown words, by the second they mark.
 *
 * Only 3, 2 and 1: those are the clips that ship with the app, and a Camera
 * Rundown counts down the last three seconds of a Shot. Ordered largest-first, so
 * a tick that crosses several moments returns them in the order they are spoken.
 */
export const COUNTDOWN_WORDS: ReadonlyMap<number, Cue> = new Map<number, Cue>([
  [3, 'three'],
  [2, 'two'],
  [1, 'one'],
])

/** One Cue, for the Outputs with one delay. */
export interface CueFiring {
  cue: Cue
  /** Play only the copies of the Outputs delayed by this much. */
  delayMs: number
}

export interface CueTickInput {
  /**
   * The remaining time at the previous tick. `null` means there is no previous
   * reading — the first tick of a Live session, or of a new item — and nothing
   * fires: a moment can only be recognised by being crossed, and the alternative
   * is firing every Cue whose moment has already gone.
   */
  previousRemainingMs: number | null
  /** The remaining time now. `null` when nothing is live. */
  remainingMs: number | null
  /** The distinct delays of the Outputs that carry Cues. */
  delaysMs: readonly number[]
}

/**
 * Which Cues this tick has just crossed the moment of, and for which delays.
 *
 * A moment counts as crossed when the remaining time was above it and is now at
 * or below it, so a slow tick that jumps over two moments fires both rather than
 * losing one. Crossing is also self-limiting: the remaining time only falls
 * within one item, so no moment can fire twice, and the caller needs no "already
 * fired" flag per Cue.
 *
 * A delay longer than the time the Cue ever had simply drops that copy. Its
 * moment was before the item went live, and there is nothing to play early
 * against — the same answer the Announcement scheduler gives a countdown number
 * that no longer fits.
 */
export function cuesDueAt(input: CueTickInput): CueFiring[] {
  const { previousRemainingMs, remainingMs, delaysMs } = input
  if (previousRemainingMs === null || remainingMs === null) return []

  const due: CueFiring[] = []
  for (const [second, cue] of COUNTDOWN_WORDS) {
    for (const delayMs of delaysMs) {
      if (crossed(previousRemainingMs, remainingMs, second * 1000 + delayMs)) {
        due.push({ cue, delayMs })
      }
    }
  }

  for (const delayMs of delaysMs) {
    // The remaining time is clamped at zero, so a route that runs ahead — a
    // negative delay, which would want the beep played *after* the Shot ended —
    // gets it at expiry instead of losing it. The beep is the one Cue whose
    // absence reads as a fault rather than as a setting.
    if (crossed(previousRemainingMs, remainingMs, Math.max(delayMs, 0))) {
      due.push({ cue: 'beep', delayMs })
    }
  }

  return due
}

/** Strictly above, then at or below: the moment passed during this tick. */
function crossed(previousMs: number, nowMs: number, momentMs: number): boolean {
  return previousMs > momentMs && nowMs <= momentMs
}
