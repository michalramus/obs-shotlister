/**
 * The decisions the Lyrics Track and the Call lane make, away from the DOM.
 *
 * The timeline is one very large component and nothing inside it can be
 * exercised without a renderer, so everything here is a pure function over plain
 * data: where a line lands on the lane, whether a new line clashes with one that
 * already exists, which line the playhead is inside, and which Calls Edit mode
 * should badge. The component keeps the mouse and the keyboard; the rules live
 * here where a test can reach them.
 */

import type { Lyric, Shot } from '../../shared/types'
import type { PhrasePlacement } from '../../shared/ipc-contract'
import { type AnnouncementShape, announcementShape } from '../../shared/announcement'
import { pxAtMs } from './coordinates'

/** An in/out pair on the timeline, before it is a Lyric. */
export interface TimeRange {
  startMs: number
  endMs: number
}

/**
 * The range an In and an Out point describe, or `null` when they describe none.
 *
 * Authoring is set-In, play, set-Out, and an operator who overshoots and sets Out
 * behind In means the two points the other way round rather than a negative line,
 * so the pair is ordered rather than refused. Two points at the same instant are
 * refused: a zero-length line can never be seen, and storing one would only make
 * a lane the operator cannot click.
 */
export function lyricRange(inMs: number, outMs: number): TimeRange | null {
  const startMs = Math.round(Math.min(inMs, outMs))
  const endMs = Math.round(Math.max(inMs, outMs))
  if (endMs <= startMs) return null
  return { startMs, endMs }
}

/**
 * Whether two ranges share any time at all.
 *
 * Touching ends do not overlap: one line ending exactly where the next begins is
 * how a continuously sung verse is authored, and is the common case rather than
 * the mistake.
 */
export function rangesOverlap(a: TimeRange, b: TimeRange): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs
}

/**
 * The existing line a candidate range would collide with, or `null`.
 *
 * The store refuses an overlap already; this is the local guard that lets the
 * operator be told *which* line is in the way before a round trip, and names the
 * line they are editing in `ignoreId` so moving a line's own boundary does not
 * count as clashing with itself.
 */
export function overlappingLyric(
  lyrics: Lyric[],
  range: TimeRange,
  ignoreId: string | null = null,
): Lyric | null {
  for (const lyric of lyrics) {
    if (lyric.id === ignoreId) continue
    if (rangesOverlap(lyric, range)) return lyric
  }
  return null
}

/** The line the given position falls inside, or `null` between lines. */
export function lyricAtMs(lyrics: Lyric[], ms: number): Lyric | null {
  for (const lyric of lyrics) {
    if (ms >= lyric.startMs && ms < lyric.endMs) return lyric
  }
  return null
}

/** One line's geometry on the lane. */
export interface LyricBlock {
  id: string
  text: string
  leftPx: number
  widthPx: number
}

/**
 * Lane geometry for every line, against the same axis as the item lane.
 *
 * `minWidthPx` keeps a one-word line wide enough to hover and delete when the
 * timeline is zoomed out; it can only ever add pixels to the right, so a line
 * never appears to start anywhere but where it does.
 */
export function lyricBlocks(lyrics: Lyric[], zoomPxPerSec: number, minWidthPx = 3): LyricBlock[] {
  return lyrics.map((lyric) => ({
    id: lyric.id,
    text: lyric.text,
    leftPx: pxAtMs(lyric.startMs, zoomPxPerSec),
    widthPx: Math.max(minWidthPx, pxAtMs(lyric.endMs - lyric.startMs, zoomPxPerSec)),
  }))
}

// Re-exported so the timeline keeps one import for its lane helpers, but
// defined once in shared/rundown-item — the Phone view needs the same answer.
export { isUnassigned } from '../../shared/rundown-item'

/** The shortest a line may be dragged to. Below this it stops being clickable. */
export const MIN_LYRIC_MS = 200

/**
 * Where a dragged edge may actually land.
 *
 * Lines are disjoint, and the store refuses an overlap outright — so a drag
 * that would cross a neighbour is stopped at that neighbour rather than
 * attempted and rejected. Dragging is continuous: bouncing off a rejection
 * every few pixels would make the lane feel broken.
 *
 * Returns null when there is no room to move at all, which the caller reads as
 * "leave the line alone".
 */
export function resizeLyric(
  lyrics: Lyric[],
  id: string,
  edge: 'start' | 'end',
  ms: number,
): TimeRange | null {
  const target = lyrics.find((l) => l.id === id)
  if (target === undefined) return null

  const others = lyrics.filter((l) => l.id !== id)

  if (edge === 'start') {
    // The nearest line that ends at or before this one starts is the floor.
    const previousEnd = others
      .filter((l) => l.endMs <= target.startMs)
      .reduce((max, l) => Math.max(max, l.endMs), 0)
    const lowest = previousEnd
    const highest = target.endMs - MIN_LYRIC_MS
    if (highest < lowest) return null
    return { startMs: clampMs(ms, lowest, highest), endMs: target.endMs }
  }

  const nextStart = others
    .filter((l) => l.startMs >= target.endMs)
    .reduce((min, l) => Math.min(min, l.startMs), Number.MAX_SAFE_INTEGER)
  const lowest = target.startMs + MIN_LYRIC_MS
  const highest = nextStart
  if (highest < lowest) return null
  return { startMs: target.startMs, endMs: clampMs(ms, lowest, highest) }
}

function clampMs(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(value, min), max))
}

/**
 * How an Announcement settings affect what fits. Exactly the fields
 * {@link announcementShape} needs beyond the Call's own timings.
 */
/** An Announcement shape worth warning about: everything but `full`. */
export type AnnouncementProblem = Exclude<AnnouncementShape, 'full'>

export interface AnnouncementSettings {
  countdown: number[]
  placement: PhrasePlacement
  transmissionDelayMs: number
}

/**
 * What each Call's Announcement will sound like, by Call id.
 *
 * Two outcomes are worth telling the operator about while they are still
 * editing, and they are not the same problem:
 *
 * - `dropped` — nothing is spoken. The Call before this one is too short for
 *   even the Part's name.
 * - `phrase-only` — the name is spoken and no countdown is. The band is told
 *   what is coming and never told when, which is the more insidious of the two:
 *   it sounds like a working Announcement right up until nobody comes in on
 *   time.
 *
 * Calls that will announce normally are absent from the map rather than marked
 * `full`, so a caller can treat presence as "worth a badge".
 *
 * An Announcement plays during the Call *before* the one it names, so the lead a
 * Call gets is the duration of the previous visible item — Hidden items extend
 * the countdown rather than providing one, exactly as they do for the Cue Tray.
 * The first item is never announced at all, so it is never badged.
 *
 * `phraseDurationMs` returns `null` for a Part with no rendered clip to measure;
 * nothing is badged on a guess.
 */
export function announcementProblemsByCallId(
  items: Shot[],
  phraseDurationMs: (partId: string) => number | null,
  settings: AnnouncementSettings,
): Map<string, AnnouncementProblem> {
  const problems = new Map<string, AnnouncementProblem>()
  let leadMs: number | null = null
  for (const item of items) {
    if (item.hidden === true) continue
    if (leadMs !== null && item.partId !== null) {
      const phrase = phraseDurationMs(item.partId)
      if (phrase !== null) {
        const shape = announcementShape({
          leadMs,
          phraseDurationMs: phrase,
          countdown: settings.countdown,
          placement: settings.placement,
          transmissionDelayMs: settings.transmissionDelayMs,
        })
        if (shape !== 'full') problems.set(item.id, shape)
      }
    }
    leadMs = item.durationMs
  }
  return problems
}
