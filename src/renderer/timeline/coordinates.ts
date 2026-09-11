/**
 * Conversion between timeline pixels and milliseconds.
 *
 * Every interaction on the timeline — clicking, dragging a boundary, moving a
 * Marker, placing the playhead — needs the same conversion, and each one used to
 * do it inline. That is where both timeline positioning bugs lived: the maths was
 * right, but it was applied to a coordinate that had already been corrected.
 */

import type { Shot } from '../../shared/types'

/** Milliseconds at a given horizontal offset within a track row. */
export function msAtPx(px: number, zoomPxPerSec: number): number {
  if (zoomPxPerSec <= 0) return 0
  return (px / zoomPxPerSec) * 1000
}

/** Horizontal offset within a track row for a given time. */
export function pxAtMs(ms: number, zoomPxPerSec: number): number {
  return (ms / 1000) * zoomPxPerSec
}

/**
 * Timeline position for a pointer event over a track row.
 *
 * `trackLeft` is the row's own getBoundingClientRect().left. The row lives inside
 * the scrolled, playhead-padded content wrapper, so that rect already accounts
 * for both scrollLeft and the playhead padding. Adding them again offsets every
 * click by `scrollLeft - padding`, which is why Markers landed further from the
 * pointer the further the timeline was scrolled.
 */
export function timelinePosMs(
  clientX: number,
  trackLeft: number,
  zoomPxPerSec: number,
  maxMs: number,
): number {
  return clamp(msAtPx(clientX - trackLeft, zoomPxPerSec), 0, maxMs)
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

/** Total duration of a Rundown. */
export function totalDurationMs(shots: Shot[]): number {
  return shots.reduce((sum, s) => sum + s.durationMs, 0)
}

/**
 * Start offset of each Shot, in milliseconds. Index-aligned with `shots`.
 * `durationOverrides` lets a drag in progress preview its own geometry without
 * having written anything to the database yet.
 */
export function shotStartOffsetsMs(
  shots: Shot[],
  durationOverrides: Record<string, number> = {},
): number[] {
  const offsets: number[] = []
  let acc = 0
  for (const shot of shots) {
    offsets.push(acc)
    acc += durationOverrides[shot.id] ?? shot.durationMs
  }
  return offsets
}

/** Id of the Shot the given position falls inside, or null past the end. */
export function shotIdAtMs(shots: Shot[], ms: number): string | null {
  let acc = 0
  for (const shot of shots) {
    if (ms < acc + shot.durationMs) return shot.id
    acc += shot.durationMs
  }
  return null
}

/** Start time of the Shot at `index`, ignoring any drag overrides. */
export function shotStartMs(shots: Shot[], index: number): number {
  let total = 0
  for (let i = 0; i < index && i < shots.length; i++) total += shots[i].durationMs
  return total
}
