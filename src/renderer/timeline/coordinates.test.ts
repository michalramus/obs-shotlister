import { describe, it, expect } from 'vitest'
import {
  msAtPx,
  pxAtMs,
  timelinePosMs,
  clamp,
  totalDurationMs,
  shotStartOffsetsMs,
  shotIdAtMs,
  shotStartMs,
} from './coordinates'
import type { Shot } from '../../shared/types'

const MAX = Number.MAX_SAFE_INTEGER

function shot(id: string, durationMs: number): Shot {
  return {
    id,
    rundownId: 'r1',
    cameraId: 'c1',
    partId: null,
    durationMs,
    label: null,
    orderIndex: 0,
    transitionName: null,
    transitionMs: 0,
  }
}

describe('msAtPx / pxAtMs', () => {
  it('round-trip at a given zoom', () => {
    expect(msAtPx(pxAtMs(4321, 80), 80)).toBeCloseTo(4321)
  })

  it('converts at 80px per second', () => {
    expect(msAtPx(160, 80)).toBe(2000)
    expect(pxAtMs(2000, 80)).toBe(160)
  })

  it('returns 0 rather than dividing by a zero zoom', () => {
    expect(msAtPx(160, 0)).toBe(0)
  })
})

describe('timelinePosMs', () => {
  it('maps a click at the track origin to 0', () => {
    expect(timelinePosMs(500, 500, 80, MAX)).toBe(0)
  })

  it('converts pixels past the origin to ms', () => {
    expect(timelinePosMs(660, 500, 80, MAX)).toBe(2000)
  })

  it('is unaffected by scroll, because the track rect moves with the content', () => {
    const unscrolled = timelinePosMs(660, 500, 80, MAX)
    const scrolled = timelinePosMs(660 - 1000, 500 - 1000, 80, MAX)
    expect(scrolled).toBe(unscrolled)
  })

  it('does not offset the result by the playhead padding', () => {
    // Regression: the old formula re-applied scrollLeft and the 120px padding
    // that rect.left already accounted for.
    expect(timelinePosMs(500, 500, 80, MAX)).toBe(0)
    expect(timelinePosMs(580, 500, 80, MAX)).toBe(1000)
  })

  it('clamps to the track', () => {
    expect(timelinePosMs(400, 500, 80, MAX)).toBe(0)
    expect(timelinePosMs(5000, 0, 80, 3000)).toBe(3000)
  })
})

describe('clamp', () => {
  it.each([
    [5, 0, 10, 5],
    [-5, 0, 10, 0],
    [15, 0, 10, 10],
  ])('clamp(%i, %i, %i) → %i', (v, lo, hi, expected) => {
    expect(clamp(v, lo, hi)).toBe(expected)
  })
})

describe('totalDurationMs', () => {
  it('sums shot durations', () => {
    expect(totalDurationMs([shot('a', 1000), shot('b', 2500)])).toBe(3500)
  })

  it('is zero for an empty rundown', () => {
    expect(totalDurationMs([])).toBe(0)
  })
})

describe('shotStartOffsetsMs', () => {
  it('accumulates start times', () => {
    expect(shotStartOffsetsMs([shot('a', 1000), shot('b', 2000), shot('c', 500)])).toEqual([
      0, 1000, 3000,
    ])
  })

  it('honours a drag override for a resized shot', () => {
    const shots = [shot('a', 1000), shot('b', 2000), shot('c', 500)]
    expect(shotStartOffsetsMs(shots, { a: 4000 })).toEqual([0, 4000, 6000])
  })

  it('is empty for an empty rundown', () => {
    expect(shotStartOffsetsMs([])).toEqual([])
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

  it('returns null for an empty rundown', () => {
    expect(shotIdAtMs([], 0)).toBeNull()
  })
})

describe('shotStartMs', () => {
  const shots = [shot('a', 1000), shot('b', 2000), shot('c', 500)]

  it('sums everything before the index', () => {
    expect(shotStartMs(shots, 0)).toBe(0)
    expect(shotStartMs(shots, 2)).toBe(3000)
  })

  it('handles an index past the end', () => {
    expect(shotStartMs(shots, 99)).toBe(3500)
  })
})
