/**
 * Grabbing a thing on a Track and moving it.
 *
 * Six interactions on the timeline are the same interaction: press on something,
 * drag it sideways, show where it would land, and on release write it. They were
 * six copies of a `mousedown` → window `mousemove` → window `mouseup` sequence
 * inside TimelineEditor, each re-deriving the same pixels-to-milliseconds
 * conversion, each clamping inline, and the minimum item duration spelt as a bare
 * `1000` in six places.
 *
 * Resizing the boundary between two Shots clamped *twice* — once in `mousemove`
 * for the preview and once again in `mouseup`, in a different spelling, for the
 * commit. The two already disagreed for a pair with no room in it, where the
 * preview shrank the left Shot to its ceiling and the commit raised it to its
 * floor and grew the pair's total by the difference. That divergence is why this
 * module exists: one resolver answers both, so they cannot drift apart again.
 *
 * So the maths is here, one resolver per grabbable thing, each taking the world as
 * it stood when the grab began plus how far the pointer has travelled since, and
 * returning what the preview should show — which is also exactly what gets
 * committed. Nothing here knows about a `MouseEvent`, a window listener, the DOM
 * or the store: that is the adapter's job, and TimelineEditor has one of those.
 */

import type { Lyric } from '../../shared/types'
import { clamp } from './coordinates'
import type { TimeRange } from './lyrics'

/**
 * The shortest a Shot or a Call may be dragged to.
 *
 * One exported name because it used to be six bare literals, and a drag that
 * previewed against one bound and committed against another is the defect this
 * module closes.
 */
export const MIN_ITEM_MS = 1000

/* ------------------------------------------------------------------ *
 * The resolvers.
 *
 * `(world, deltaMs) => preview`. No events, no refs, no DOM, no store, nothing
 * async — so every clamp below can be asserted directly.
 * ------------------------------------------------------------------ */

/** The two Shots either side of a boundary, as they stood when it was grabbed. */
export interface ShotPairGrab {
  /** Duration of the Shot to the left of the boundary. */
  origDurationAMs: number
  /** Duration of the Shot to the right of it. */
  origDurationBMs: number
}

export interface ShotPairPreview {
  durationAMs: number
  durationBMs: number
}

/**
 * Resizing the boundary between two Shots.
 *
 * The pair's total is fixed: moving the boundary gives one Shot exactly what it
 * takes from the other, so the rest of the Rundown does not shift. Both ends are
 * bounded by {@link MIN_ITEM_MS}, which is what makes over-dragging stop at the
 * neighbour rather than invert the pair into negative durations.
 *
 * A pair too short to hold two minimum-length items has nowhere for the boundary
 * to go, and is held where it is rather than pushed to one side: that is the case
 * the old preview and the old commit answered differently, and the commit's answer
 * lengthened the Rundown.
 */
export function resizeShotPair(grab: ShotPairGrab, deltaMs: number): ShotPairPreview {
  const totalMs = grab.origDurationAMs + grab.origDurationBMs
  const highestAMs = totalMs - MIN_ITEM_MS
  if (highestAMs < MIN_ITEM_MS) {
    return { durationAMs: grab.origDurationAMs, durationBMs: grab.origDurationBMs }
  }
  const durationAMs = clamp(grab.origDurationAMs + deltaMs, MIN_ITEM_MS, highestAMs)
  return { durationAMs, durationBMs: totalMs - durationAMs }
}

/** The last item of a Rundown, as it stood when its trailing edge was grabbed. */
export interface ExtendGrab {
  origDurationMs: number
}

export interface DurationPreview {
  durationMs: number
}

/**
 * Lengthening or shortening the last item past its current end.
 *
 * Floored at {@link MIN_ITEM_MS} and deliberately not ceilinged: the last item is
 * how an operator covers material the Reference media has not reached yet, so
 * there is nothing on its right to stop at.
 */
export function extendLastItem(grab: ExtendGrab, deltaMs: number): DurationPreview {
  return { durationMs: Math.max(MIN_ITEM_MS, grab.origDurationMs + deltaMs) }
}

export interface MarkerGrab {
  origPositionMs: number
}

export interface MarkerPreview {
  positionMs: number
}

/**
 * Moving a Marker along its Track.
 *
 * Floored at zero and deliberately left unbounded above — unlike the Playhead
 * scrub, which stops at the end of the Rundown. A Marker is positioned
 * independently of Shot boundaries and is allowed to sit past the last Shot, which
 * is how the operator marks something in the Reference media that has not been cut
 * yet; the Marker Track's double-click hands `timelinePosMs` an unbounded ceiling
 * for the same reason.
 */
export function moveMarker(grab: MarkerGrab, deltaMs: number): MarkerPreview {
  return { positionMs: Math.max(0, Math.round(grab.origPositionMs + deltaMs)) }
}

export interface ReferenceMediaGrab {
  origOffsetMs: number
}

export interface ReferenceMediaPreview {
  offsetMs: number
}

/**
 * Sliding Reference media against the Rundown.
 *
 * Rounded here and nowhere else. The preview used to keep the fractional value and
 * only the commit rounded it, so the pixels the operator lined the waveform up
 * against were not quite the offset that got stored — the same two-spellings shape
 * as the boundary clamp, a millisecond wide instead of a second.
 *
 * Unbounded in both directions: a negative offset is media that starts before the
 * Rundown does, which is ordinary.
 */
export function alignReferenceMedia(
  grab: ReferenceMediaGrab,
  deltaMs: number,
): ReferenceMediaPreview {
  return { offsetMs: Math.round(grab.origOffsetMs + deltaMs) }
}

export interface PlayheadGrab {
  origMs: number
  /** Duration of the whole Rundown; the scrub stops here. */
  totalMs: number
}

export interface PlayheadPreview {
  positionMs: number
}

/**
 * Scrubbing the Playhead.
 *
 * The only grab with a ceiling, because the Playhead means a position *in* the
 * Rundown and there is nothing past the end to be at. The resolver says where; the
 * Playhead module is told, and it is the one that seeks the Reference media and
 * pulls the view along.
 */
export function scrubPlayhead(grab: PlayheadGrab, deltaMs: number): PlayheadPreview {
  return { positionMs: clamp(grab.origMs + deltaMs, 0, grab.totalMs) }
}

/** The shortest a Lyric may be dragged to. Below this it stops being clickable. */
export const MIN_LYRIC_MS = 200

/**
 * Where a dragged Lyric edge may actually land.
 *
 * The outlier of the six: Lyrics are disjoint and their neighbours are the bounds,
 * so this resolves an absolute position on the Lyrics Track rather than a travel
 * distance. It was extracted long before the other five and is the proof the shape
 * works, which is why it moved here unchanged rather than being rewritten.
 *
 * A drag that would cross a neighbour is stopped at that neighbour rather than
 * attempted and refused: the store rejects an overlap outright, and bouncing off a
 * rejection every few pixels would make the lane feel broken.
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
    return { startMs: roundedClamp(ms, lowest, highest), endMs: target.endMs }
  }

  const nextStart = others
    .filter((l) => l.startMs >= target.endMs)
    .reduce((min, l) => Math.min(min, l.startMs), Number.MAX_SAFE_INTEGER)
  const lowest = target.startMs + MIN_LYRIC_MS
  const highest = nextStart
  if (highest < lowest) return null
  return { startMs: target.startMs, endMs: roundedClamp(ms, lowest, highest) }
}

function roundedClamp(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(value, min), max))
}

/* ------------------------------------------------------------------ *
 * The adapter's contract.
 *
 * Types only: the one implementation lives in TimelineEditor, because it is the
 * only thing that may touch a `MouseEvent` or a window listener.
 * ------------------------------------------------------------------ */

/** One reading of the pointer, in the units the resolvers take. */
export interface GrabSample {
  /** How far the pointer has travelled since the grab began. */
  deltaMs: number
  /**
   * Where the pointer is, unconverted.
   *
   * For {@link resizeLyric}, which needs a position on the Track rather than a
   * distance. Everything else uses `deltaMs` and ignores this.
   */
  clientX: number
}

/** What release writes. */
export type GrabCommitOn =
  /**
   * Resolve the release position and commit that — the default, and the whole
   * point: the clamp that drew the preview is the one that produces the stored
   * value.
   */
  | 'release'
  /**
   * Commit the last preview instead, and commit nothing when the pointer never
   * moved. For the Lyric drag, whose commit is a store write that must not fire on
   * a bare click of an edge handle.
   */
  | 'move'

/** One grabbable thing, wired to a resolver. */
export interface GrabSpec<P> {
  /** The resolver, with the world it was grabbed in already closed over. */
  resolve: (sample: GrabSample) => P | null
  /** Shows the preview. Called for every pointer reading. */
  preview: (value: P) => void
  /** Writes it. Omitted by the Playhead scrub, which has nothing to store. */
  commit?: (value: P) => void
  commitOn?: GrabCommitOn
  /** Runs once the grab is over, committed or not: clears the preview. */
  end?: () => void
  /**
   * Whether this grab owns the Playhead while it runs, which stops the operator's
   * own scrolling from dragging the Playhead along. True for the boundary, Marker
   * and Reference media drags, as it was before this module.
   */
  ownsPlayhead?: boolean
}
