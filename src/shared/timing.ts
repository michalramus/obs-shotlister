/**
 * Pure timing calculation functions for the ShotlistWidget.
 * No React, no Electron — unit-testable in isolation.
 */

import type { Shot, Camera } from './types'

/**
 * Formats milliseconds as m:ss (e.g. 90500 → "1:30")
 */
export function formatMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export interface TimingResult {
  /** Index of the live shot in the shots array */
  liveIndex: number | null
  /** Index of the next visible shot (passes cameraFilter) after liveIndex */
  nextVisibleIndex: number | null
  /** Remaining ms on the live shot (including consecutive hidden shots after it) */
  remainingMs: number | null
  /** Time until the next visible shot goes live, in ms */
  timeUntilNextVisibleMs: number | null
  /** Total wait time from start of live shot to next visible shot (constant, not time-dependent) */
  totalTimeUntilNextVisibleMs: number | null
  /** Effective duration = live shot + consecutive hidden shots after it */
  effectiveDurationMs: number | null
}

/**
 * Computes timing values for the shotlist.
 *
 * @param shots - all shots in order
 * @param cameras - camera lookup
 * @param liveIndex - index of the current live shot (null = not running)
 * @param startedAt - timestamp when current live shot started
 * @param now - current time (Date.now())
 * @param cameraFilter - camera numbers to show; undefined/empty = show all
 */
export function computeTiming(
  shots: Shot[],
  _cameras: Camera[],
  liveIndex: number | null,
  startedAt: number | null,
  now: number,
  cameraFilter?: number[],
): TimingResult {
  if (liveIndex === null || startedAt === null) {
    return {
      liveIndex: null,
      nextVisibleIndex: null,
      remainingMs: null,
      timeUntilNextVisibleMs: null,
      totalTimeUntilNextVisibleMs: null,
      effectiveDurationMs: null,
    }
  }

  const liveShot = shots[liveIndex]
  if (!liveShot) {
    return {
      liveIndex: null,
      nextVisibleIndex: null,
      remainingMs: null,
      timeUntilNextVisibleMs: null,
      totalTimeUntilNextVisibleMs: null,
      effectiveDurationMs: null,
    }
  }

  // Effective duration = live shot + consecutive hidden shots immediately after
  let effectiveDurationMs = liveShot.durationMs
  for (let i = liveIndex + 1; i < shots.length; i++) {
    if (shots[i].hidden) effectiveDurationMs += shots[i].durationMs
    else break
  }

  const elapsed = now - startedAt
  const remainingMs = Math.max(0, effectiveDurationMs - elapsed)

  // Find next visible index (first shot after liveIndex that passes filter)
  const hasFilter = cameraFilter !== undefined && cameraFilter.length > 0

  // Build camera number lookup for filter
  // We need cameras to look up numbers by ID
  // For simplicity, timeUntilLive calculation uses _cameras map
  const cameraNumberById = new Map<string, number>(_cameras.map((c) => [c.id, c.number]))

  function passesFilter(shot: Shot): boolean {
    if (!hasFilter) return true
    const num = cameraNumberById.get(shot.cameraId)
    return num !== undefined && cameraFilter!.includes(num)
  }

  let nextVisibleIndex: number | null = null
  for (let i = liveIndex + 1; i < shots.length; i++) {
    if (!shots[i].hidden && passesFilter(shots[i])) {
      nextVisibleIndex = i
      break
    }
  }

  if (nextVisibleIndex === null) {
    return { liveIndex, nextVisibleIndex: null, remainingMs, timeUntilNextVisibleMs: null, totalTimeUntilNextVisibleMs: null, effectiveDurationMs }
  }

  // timeUntilLive = remainingMs on live shot + sum of durations of all shots
  // between liveIndex and nextVisibleIndex (exclusive of both endpoints)
  let intermediateMs = 0
  for (let i = liveIndex + 1; i < nextVisibleIndex; i++) {
    if (!shots[i].hidden) intermediateMs += shots[i].durationMs
  }

  const timeUntilNextVisibleMs = remainingMs + intermediateMs
  const totalTimeUntilNextVisibleMs = effectiveDurationMs + intermediateMs

  return { liveIndex, nextVisibleIndex, remainingMs, timeUntilNextVisibleMs, totalTimeUntilNextVisibleMs, effectiveDurationMs }
}
