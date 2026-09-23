/**
 * Scheduling one Announcement: which clips a Voice-over Rundown speaks before a
 * Call, and how long after the previous Call went live each one starts.
 *
 * Every clip already exists on disk with its duration stored beside it (ADR
 * 0005), so the only thing left to decide is placement — and placement is pure
 * arithmetic over durations. Keeping it here, away from the Live session, means
 * the awkward cases (a Call too short for the whole countdown, a Part whose
 * phrase was never rendered, a countdown number with no clip) are decided once
 * and provable in a unit test rather than discovered on show night.
 *
 * The module never decides *which* Call is announced, never fires anything and
 * never touches audio: the Live session resolves the next visible Call, asks for
 * a plan, and the renderer plays it (ADR 0002 — nothing here advances anything).
 */

import type { AnnouncementCue, AnnouncementPlan, PhrasePlacement } from './ipc-contract'

/**
 * The countdown a Project gets before it overrides anything. Exported so the
 * settings layer and the tests agree on one list instead of both spelling it out.
 */
export const DEFAULT_COUNTDOWN: number[] = [10, 5, 3, 2, 1]

/** A rendered clip: where the renderer loads it from and how long it runs. */
export interface AnnouncementClip {
  url: string
  durationMs: number
}

export interface ScheduleInput {
  /** The Call being announced — the next *visible* item, resolved by the caller. */
  callId: string
  /** How long the operator has until that Call is due, measured from now. */
  leadMs: number
  /** The phrase clip: "<part name> <connector>", e.g. "gitara za". */
  phrase: AnnouncementClip | null
  /** Clip per countdown number, e.g. 10 -> { url, durationMs }. */
  numbers: Map<number, AnnouncementClip>
  countdown: number[]
  placement: PhrasePlacement
}

/**
 * Builds the plan for one Call, or `null` when nothing should be spoken.
 *
 * `atMs` is measured from the moment the previous Call goes live, which is the
 * moment the plan is issued, so the renderer needs no clock of its own.
 *
 * `null` covers both "there is no room for the phrase" — which Edit mode badges
 * so the operator finds out while editing — and "there is nothing left to play
 * at all", because a plan with no cues would only cut off the Announcement in
 * flight for no gain.
 */
export function scheduleAnnouncement(input: ScheduleInput): AnnouncementPlan | null {
  const { callId, leadMs, phrase, numbers, countdown, placement } = input

  // Number n lands n seconds before the Call starts: the musician hears the word
  // as that mark passes, so the clip *starts* there rather than ending there.
  // Numbers that would have to start before the previous Call went live are
  // dropped rather than clamped to 0 — two numbers stacked on the same instant
  // is worse information than one number fewer, so a short Call simply begins at
  // the largest number that still fits.
  const numberCues: AnnouncementCue[] = []
  for (const n of countdown) {
    const clip = numbers.get(n)
    // A number with no rendered clip is silence, not a crash: the countdown
    // continues without it and the flush anchor moves to whatever is spoken.
    if (!clip) continue
    const atMs = leadMs - n * 1000
    if (atMs < 0 || atMs >= leadMs) continue
    numberCues.push({ url: clip.url, atMs })
  }

  const cues: AnnouncementCue[] = [...numberCues]

  if (phrase) {
    const phraseAt = phraseStartMs(placement, phrase, numberCues, leadMs)
    // Too short for even the phrase: the whole Announcement goes, numbers
    // included. A countdown with no name in front of it tells the band when but
    // never what, which is worse than staying quiet.
    if (phraseAt === null) return null
    cues.push({ url: phrase.url, atMs: phraseAt })
  }

  if (cues.length === 0) return null

  cues.sort((a, b) => a.atMs - b.atMs)
  return { callId, cues }
}

/**
 * Where the phrase starts, or `null` when it does not fit.
 *
 * Under `flush` the phrase ends exactly where the first spoken number begins, so
 * name and countdown are one continuous utterance. With no numbers left to
 * anchor against — an empty countdown, or every number dropped — flush falls
 * back to the Call's own start, which is the next thing that happens and keeps
 * the name as late and therefore as actionable as possible.
 *
 * Under `immediate` the phrase starts the instant the previous Call goes live
 * regardless of where the numbers land, so it may overlap the first number on a
 * very short Call; the renderer, not the schedule, decides what that sounds
 * like. "Fits" there means the phrase finishes at or before the Call starts.
 */
function phraseStartMs(
  placement: PhrasePlacement,
  phrase: AnnouncementClip,
  numberCues: AnnouncementCue[],
  leadMs: number,
): number | null {
  if (placement === 'immediate') {
    return phrase.durationMs <= leadMs ? 0 : null
  }

  const firstNumberAt = numberCues.reduce<number | null>(
    (earliest, cue) => (earliest === null || cue.atMs < earliest ? cue.atMs : earliest),
    null,
  )
  const anchorMs = firstNumberAt ?? leadMs
  const atMs = anchorMs - phrase.durationMs
  return atMs >= 0 ? atMs : null
}
