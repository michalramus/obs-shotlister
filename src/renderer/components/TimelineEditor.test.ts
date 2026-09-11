import { describe, it, expect } from 'vitest'
import { timelinePosMs, shotIdAtMs } from './TimelineEditor'
import type { Shot } from '../../shared/types'

const MAX = Number.MAX_SAFE_INTEGER

function shot(id: string, durationMs: number): Shot {
  return {
    id,
    rundownId: 'r1',
    cameraId: 'c1',
    durationMs,
    label: null,
    orderIndex: 0,
    transitionName: null,
    transitionMs: 0,
  }
}

describe('timelinePosMs', () => {
  it('maps a click at the track origin to 0', () => {
    expect(timelinePosMs(500, 500, 80, MAX)).toBe(0)
  })

  it('converts pixels to ms at the current zoom', () => {
    // 80px/s → 160px past the origin is 2s.
    expect(timelinePosMs(660, 500, 80, MAX)).toBe(2000)
  })

  it('is unaffected by scroll, because the track rect moves with the content', () => {
    // Scrolled 1000px right: the row's rect.left shifts left by the same amount,
    // and a click at the same content position follows it.
    const unscrolled = timelinePosMs(660, 500, 80, MAX)
    const scrolled = timelinePosMs(660 - 1000, 500 - 1000, 80, MAX)
    expect(scrolled).toBe(unscrolled)
  })

  it('does not offset the result by the playhead padding', () => {
    // Regression: the old formula added scrollLeft and subtracted 120px of
    // padding that rect.left already accounted for, so a click at the origin
    // resolved to -120px worth of time instead of 0.
    expect(timelinePosMs(500, 500, 80, MAX)).toBe(0)
    expect(timelinePosMs(580, 500, 80, MAX)).toBe(1000)
  })

  it('clamps negatives to zero', () => {
    expect(timelinePosMs(400, 500, 80, MAX)).toBe(0)
  })

  it('clamps to the supplied maximum', () => {
    expect(timelinePosMs(5000, 0, 80, 3000)).toBe(3000)
  })

  it('returns 0 rather than dividing by a zero zoom', () => {
    expect(timelinePosMs(660, 500, 0, MAX)).toBe(0)
  })
})

describe('shotIdAtMs', () => {
  const shots = [shot('a', 1000), shot('b', 2000), shot('c', 500)]

  it('finds the shot containing the position', () => {
    expect(shotIdAtMs(shots, 0)).toBe('a')
    expect(shotIdAtMs(shots, 999)).toBe('a')
    expect(shotIdAtMs(shots, 1000)).toBe('b')
    expect(shotIdAtMs(shots, 2999)).toBe('b')
    expect(shotIdAtMs(shots, 3000)).toBe('c')
  })

  it('returns null past the end', () => {
    expect(shotIdAtMs(shots, 3500)).toBeNull()
  })

  it('returns null for an empty timeline', () => {
    expect(shotIdAtMs([], 0)).toBeNull()
  })
})
