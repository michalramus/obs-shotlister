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

import type { ScheduledClip, AnnouncementPlan, PhrasePlacement } from './ipc-contract'

/**
 * The countdown a Project gets before it overrides anything. Exported so the
 * settings layer and the tests agree on one list instead of both spelling it out.
 */
export const DEFAULT_COUNTDOWN: number[] = [10, 5, 3, 2, 1]

/**
 * Bounds on the Announcement path delay.
 *
 * Five seconds is far beyond any Mumble buffer and already longer than the gap
 * between most countdown numbers, so anything larger would only mute the
 * Announcement it was meant to fix. Negative covers a path that runs ahead.
 *
 * Defined here, where the delay is applied, so the settings layer and the field
 * that validates operator input cannot drift from what the scheduler honours.
 */
export const TRANSMISSION_DELAY_MIN_MS = -5000
export const TRANSMISSION_DELAY_MAX_MS = 5000

/**
 * The breath between the name and the first number, in milliseconds.
 *
 * Flush placement used to mean *exactly* flush: the phrase was scheduled to end
 * on the sample the first number started on. Two clips butted together with
 * nothing between them do not sound like one sentence, they sound like one
 * word — "Wokal za trzy" arrives as "Wokal zatrzy". The clips make it worse than
 * it looks on paper, because their duration is measured to the last audible
 * sample (see `audibleDurationMs`), so even the synthesiser's own trailing pad
 * is not between them.
 *
 * 300ms is about the length of a comma in speech: clearly a boundary, still
 * clearly one utterance. It costs the same 300ms of lead, which only matters on
 * a Call already too short for the full countdown — and there the scheduler
 * already drops the highest number rather than crowding two together.
 */
export const PHRASE_GAP_MS = 300

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
  /**
   * How long the audio path takes to reach the band, in milliseconds.
   *
   * Announcements are piped into Mumble, which buffers: the band hears a clip
   * some way after it is played. Every time here is a *play* time, so the whole
   * utterance is shifted this much earlier to make the band hear it on the beat
   * it was scheduled for. Positive is the normal case; negative plays later,
   * for a path that somehow runs ahead.
   *
   * Defaults to 0, which is the behaviour of a local speaker.
   */
  transmissionDelayMs?: number
  /**
   * Silence between the end of the phrase and the first number, under `flush`
   * placement. Defaults to {@link PHRASE_GAP_MS}.
   */
  phraseGapMs?: number
}

/**
 * What an operator will actually hear before a Call.
 *
 * - `full`: the name and at least one countdown number.
 * - `phrase-only`: the name, and no countdown at all. The Call is long enough to
 *   say what is next but not long enough to say when, so the band is told to
 *   change and given no beat to change on.
 * - `dropped`: nothing. Not even the name fits.
 */
export type AnnouncementShape = 'full' | 'phrase-only' | 'dropped'

export interface AnnouncementShapeInput {
  leadMs: number
  /** The rendered phrase clip's length. */
  phraseDurationMs: number
  countdown: number[]
  placement: PhrasePlacement
  transmissionDelayMs?: number
  phraseGapMs?: number
}

/**
 * Which of the three an Announcement will be, without building it.
 *
 * Edit mode needs this per Call, for every Call, on every keystroke that resizes
 * one — so it answers from durations alone rather than by scheduling a plan it
 * would throw away. It applies the same arithmetic {@link scheduleAnnouncement}
 * does and has to keep applying it: the two disagreeing would mean badging a
 * Call that speaks fine, or worse, staying quiet about one that will not.
 */
export function announcementShape(input: AnnouncementShapeInput): AnnouncementShape {
  const { leadMs, phraseDurationMs, countdown, placement } = input
  const delayMs = input.transmissionDelayMs ?? 0
  const gapMs = input.phraseGapMs ?? PHRASE_GAP_MS

  // A number lands where the scheduler puts it, and only counts if that is
  // inside the lead at all.
  const spokenNumbers = countdown
    .map((n) => leadMs - n * 1000 - delayMs)
    .filter((atMs) => atMs >= 0 && atMs < leadMs)

  if (placement === 'immediate') {
    if (phraseDurationMs + delayMs > leadMs) return 'dropped'
    return spokenNumbers.length > 0 ? 'full' : 'phrase-only'
  }

  // Flush: the phrase has to fit in front of a number, breath included, for that
  // number to survive alongside it.
  if (spokenNumbers.some((atMs) => atMs - phraseDurationMs - gapMs >= 0)) return 'full'

  // No number to anchor against, so the phrase flushes against the Call's own
  // start — which it may still not reach.
  return leadMs - phraseDurationMs - delayMs >= 0 ? 'phrase-only' : 'dropped'
}

/**
 * Builds the plan for one Call, or `null` when nothing should be spoken.
 *
 * `atMs` is measured from the moment the previous Call goes live, which is the
 * moment the plan is issued, so the renderer needs no clock of its own.
 *
 * `null` covers both "there is no room for the phrase" — which Edit mode badges
 * so the operator finds out while editing — and "there is nothing left to play
 * at all", because a plan with no clips would only cut off the Announcement in
 * flight for no gain.
 */
export function scheduleAnnouncement(input: ScheduleInput): AnnouncementPlan | null {
  const { callId, leadMs, phrase, numbers, countdown, placement } = input
  const delayMs = input.transmissionDelayMs ?? 0
  const gapMs = input.phraseGapMs ?? PHRASE_GAP_MS

  // Number n lands n seconds before the Call starts: the musician hears the word
  // as that mark passes, so the clip *starts* there rather than ending there.
  // Subtracting the path's delay is what makes "hears" rather than "plays" the
  // thing being placed — over Mumble the two are several hundred milliseconds
  // apart, which is most of the gap between the last two numbers.
  //
  // Numbers that would have to start before the previous Call went live are
  // dropped rather than clamped to 0 — two numbers stacked on the same instant
  // is worse information than one number fewer, so a short Call simply begins at
  // the largest number that still fits.
  const numberClips: ScheduledClip[] = []
  for (const n of countdown) {
    const clip = numbers.get(n)
    // A number with no rendered clip is silence, not a crash: the countdown
    // continues without it and the flush anchor moves to whatever is spoken.
    if (!clip) continue
    const atMs = leadMs - n * 1000 - delayMs
    if (atMs < 0 || atMs >= leadMs) continue
    numberClips.push({ url: clip.url, atMs })
  }

  if (!phrase) {
    // Nothing to name, but the numbers still tell the band when.
    return numberClips.length > 0 ? { callId, clips: sortByTime(numberClips) } : null
  }

  const placed = placePhrase(placement, phrase, numberClips, leadMs, delayMs, gapMs)
  // Too short for even the phrase: the whole Announcement goes, numbers
  // included. A countdown with no name in front of it tells the band when but
  // never what, which is worse than staying quiet. Edit mode badges this.
  if (!placed) return null

  const clips = [...placed.numbers, { url: phrase.url, atMs: placed.phraseAtMs }]

  return { callId, clips: sortByTime(clips) }
}

function sortByTime(clips: ScheduledClip[]): ScheduledClip[] {
  return [...clips].sort((a, b) => a.atMs - b.atMs)
}

/**
 * Where the phrase goes, and which numbers survive alongside it.
 *
 * Under `immediate` the phrase starts the instant the previous Call goes live
 * regardless of where the numbers land, so it may overlap the first number on a
 * very short Call; the renderer, not the schedule, decides what that sounds
 * like. "Fits" there means the phrase finishes at or before the Call starts.
 *
 * Under `flush` the phrase ends one {@link PHRASE_GAP_MS} breath before the
 * first spoken number begins, so name and countdown are one utterance with a
 * boundary in it rather than one run-together word. When the phrase will not
 * fit before the highest number, that number is dropped and the utterance
 * begins at the next one down — the Call is simply "too short for the full
 * countdown", and the spec's answer to that is to start from the largest number
 * that still fits, not to fall silent. Only a phrase too long for the lead
 * itself drops the Announcement, which is the case Edit mode badges.
 */
function placePhrase(
  placement: PhrasePlacement,
  phrase: AnnouncementClip,
  numberClips: ScheduledClip[],
  leadMs: number,
  delayMs: number,
  gapMs: number,
): { phraseAtMs: number; numbers: ScheduledClip[] } | null {
  if (placement === 'immediate') {
    // Nothing can be played before now, so the delay cannot be compensated
    // here — it eats into the time the band has to hear the name instead.
    return phrase.durationMs + delayMs <= leadMs ? { phraseAtMs: 0, numbers: numberClips } : null
  }

  const ascending = sortByTime(numberClips)
  for (let i = 0; i < ascending.length; i++) {
    const phraseAtMs = ascending[i].atMs - phrase.durationMs - gapMs
    if (phraseAtMs >= 0) return { phraseAtMs, numbers: ascending.slice(i) }
  }

  // No number left to anchor against — an empty countdown, or every one of them
  // dropped. Flush against the Call's own start, which is the next thing that
  // happens and keeps the name as late, and so as actionable, as possible.
  //
  // No breath here: the thing being flushed against is the downbeat, not another
  // clip, so there is nothing for the name to run into. Keeping this branch at
  // the phrase's own length is also what holds "too short to announce" at the
  // threshold Edit mode badges.
  const phraseAtMs = leadMs - phrase.durationMs - delayMs
  return phraseAtMs >= 0 ? { phraseAtMs, numbers: [] } : null
}
