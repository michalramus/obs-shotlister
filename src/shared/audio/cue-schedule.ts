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
   * reading — the first tick of a Live session, or of a new item — and almost
   * nothing fires: a moment can only be recognised by being crossed, and the
   * alternative is firing every Cue whose moment has already gone. The one
   * exception is an expiry beep the item is too short to ever reach; see
   * {@link cuesDueAt}.
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
 * A delay longer than the time the Cue ever had drops that copy of a countdown
 * word: its moment was before the item went live, there is nothing to play early
 * against, and that is the same answer the Announcement scheduler gives a number
 * that no longer fits. The expiry beep is not dropped with them — it is clamped
 * into the item and played at the first reading instead, because a countdown one
 * word short still counts down while a missing beep reads as a fault.
 */
export function cuesDueAt(input: CueTickInput): CueFiring[] {
  const { previousRemainingMs, remainingMs, delaysMs } = input
  if (remainingMs === null) return []

  const due: CueFiring[] = []
  if (previousRemainingMs !== null) {
    for (const [second, cue] of COUNTDOWN_WORDS) {
      for (const delayMs of delaysMs) {
        if (crossed(previousRemainingMs, remainingMs, second * 1000 + delayMs)) {
          due.push({ cue, delayMs })
        }
      }
    }
  }

  for (const delayMs of delaysMs) {
    // Clamped at both ends, because the beep is the one Cue whose absence reads
    // as a fault rather than as a setting. A negative delay — a route that runs
    // ahead, wanting the beep *after* the Shot ended — is clamped to expiry; and
    // a delay longer than the whole item, whose moment fell before the item went
    // live, is clamped to the first reading of that item and played at once.
    // Neither is ever dropped, which is what the countdown words above do with a
    // moment they cannot reach: a number nobody had room for is one word short,
    // while a missing expiry beep is the band waiting for a cue that never comes.
    const moment = Math.max(delayMs, 0)
    if (previousRemainingMs === null) {
      // The item's first reading: nothing has been crossed yet, so the only beep
      // that can be due is one whose moment is beyond the item's whole life.
      // Firing it here is also what makes it fire exactly once — from the next
      // tick on, that moment is above the previous reading and can never be
      // crossed.
      if (moment > remainingMs) due.push({ cue: 'beep', delayMs })
      continue
    }
    if (crossed(previousRemainingMs, remainingMs, moment)) {
      due.push({ cue: 'beep', delayMs })
    }
  }

  return due
}

/** Strictly above, then at or below: the moment passed during this tick. */
function crossed(previousMs: number, nowMs: number, momentMs: number): boolean {
  return previousMs > momentMs && nowMs <= momentMs
}
