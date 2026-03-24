import { describe, it, expect } from 'vitest'
import { formatMs, computeTiming } from './timing'
import type { Shot, Camera } from './types'

// ---------------------------------------------------------------------------
// formatMs
// ---------------------------------------------------------------------------

describe('formatMs', () => {
  it('formats 0ms as 0:00', () => {
    expect(formatMs(0)).toBe('0:00')
  })

  it('formats 1000ms as 0:01', () => {
    expect(formatMs(1000)).toBe('0:01')
  })

  it('formats 60000ms as 1:00', () => {
    expect(formatMs(60000)).toBe('1:00')
  })

  it('formats 90500ms as 1:30', () => {
    expect(formatMs(90500)).toBe('1:30')
  })

  it('formats 3661000ms as 61:01', () => {
    expect(formatMs(3661000)).toBe('61:01')
  })

  it('clamps negative values to 0:00', () => {
    expect(formatMs(-5000)).toBe('0:00')
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeShot(id: string, cameraId: string, durationMs: number, orderIndex: number, hidden = false): Shot {
  return { id, rundownId: 'rd-1', cameraId, durationMs, label: null, orderIndex, hidden }
}

function makeCamera(id: string, number: number): Camera {
  return { id, projectId: 'p1', number, name: `CAM${number}`, color: '#fff', resolveColor: null }
}

// ---------------------------------------------------------------------------
// computeTiming — not running
// ---------------------------------------------------------------------------

describe('computeTiming — not running', () => {
  it('returns all nulls when liveIndex is null', () => {
    const shots = [makeShot('s1', 'cam-1', 5000, 0)]
    const cameras = [makeCamera('cam-1', 1)]
    const result = computeTiming(shots, cameras, null, null, Date.now())
    expect(result.liveIndex).toBeNull()
    expect(result.remainingMs).toBeNull()
    expect(result.nextVisibleIndex).toBeNull()
    expect(result.timeUntilNextVisibleMs).toBeNull()
    expect(result.effectiveDurationMs).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// computeTiming — remaining time
// ---------------------------------------------------------------------------

describe('computeTiming — remaining time', () => {
  it('calculates remaining time correctly', () => {
    const shots = [makeShot('s1', 'cam-1', 10000, 0)]
    const cameras = [makeCamera('cam-1', 1)]
    const startedAt = 1000
    const now = 3000 // 2 seconds elapsed
    const result = computeTiming(shots, cameras, 0, startedAt, now)
    expect(result.remainingMs).toBe(8000) // 10000 - 2000
    expect(result.effectiveDurationMs).toBe(10000)
  })

  it('clamps remaining to 0 when time has passed', () => {
    const shots = [makeShot('s1', 'cam-1', 5000, 0)]
    const cameras = [makeCamera('cam-1', 1)]
    const result = computeTiming(shots, cameras, 0, 0, 10000) // 10 seconds elapsed on 5s shot
    expect(result.remainingMs).toBe(0)
    expect(result.effectiveDurationMs).toBe(5000)
  })
})

// ---------------------------------------------------------------------------
// computeTiming — next visible shot (no filter)
// ---------------------------------------------------------------------------

describe('computeTiming — no filter', () => {
  it('finds next visible shot and calculates timeUntilLive', () => {
    const shots = [
      makeShot('s1', 'cam-1', 10000, 0), // live
      makeShot('s2', 'cam-2', 5000, 1),  // next visible
    ]
    const cameras = [makeCamera('cam-1', 1), makeCamera('cam-2', 2)]
    const startedAt = 0
    const now = 2000 // 2 seconds elapsed on s1
    const result = computeTiming(shots, cameras, 0, startedAt, now)

    expect(result.nextVisibleIndex).toBe(1)
    expect(result.remainingMs).toBe(8000)     // 10000 - 2000
    expect(result.timeUntilNextVisibleMs).toBe(8000) // no intermediate shots
    expect(result.effectiveDurationMs).toBe(10000)
  })

  it('includes intermediate shot durations in timeUntilLive', () => {
    const shots = [
      makeShot('s1', 'cam-1', 10000, 0), // live
      makeShot('s2', 'cam-2', 3000, 1),  // intermediate (visible without filter)
      makeShot('s3', 'cam-3', 5000, 2),  // next queried visible
    ]
    const cameras = [
      makeCamera('cam-1', 1),
      makeCamera('cam-2', 2),
      makeCamera('cam-3', 3),
    ]
    const result = computeTiming(shots, cameras, 0, 0, 2000)
    // next visible is s2 (index 1) — no filter so first after live
    expect(result.nextVisibleIndex).toBe(1)
    expect(result.timeUntilNextVisibleMs).toBe(8000) // remaining on live, no intermediates
  })
})

// ---------------------------------------------------------------------------
// computeTiming — with camera filter
// ---------------------------------------------------------------------------

describe('computeTiming — with camera filter', () => {
  it('skips hidden shots to find next visible', () => {
    const shots = [
      makeShot('s1', 'cam-1', 10000, 0), // live — cam1 shown
      makeShot('s2', 'cam-2', 3000, 1),  // hidden (cam2 filtered out)
      makeShot('s3', 'cam-1', 5000, 2),  // next visible (cam1 shown)
    ]
    const cameras = [makeCamera('cam-1', 1), makeCamera('cam-2', 2)]
    const result = computeTiming(shots, cameras, 0, 0, 2000, [1]) // only cam1

    expect(result.nextVisibleIndex).toBe(2) // s3
    // timeUntilLive = remaining (8000) + intermediate s2 duration (3000) = 11000
    expect(result.timeUntilNextVisibleMs).toBe(11000)
  })

  it('returns null nextVisibleIndex when no visible shots remain', () => {
    const shots = [
      makeShot('s1', 'cam-1', 10000, 0), // live
      makeShot('s2', 'cam-2', 3000, 1),  // hidden
    ]
    const cameras = [makeCamera('cam-1', 1), makeCamera('cam-2', 2)]
    const result = computeTiming(shots, cameras, 0, 0, 2000, [1])
    expect(result.nextVisibleIndex).toBeNull()
    expect(result.timeUntilNextVisibleMs).toBeNull()
  })

  it('counts multiple hidden shots in timeUntilLive', () => {
    const shots = [
      makeShot('s1', 'cam-1', 10000, 0), // live — cam1
      makeShot('s2', 'cam-2', 3000, 1),  // hidden
      makeShot('s3', 'cam-2', 2000, 2),  // hidden
      makeShot('s4', 'cam-1', 5000, 3),  // next visible
    ]
    const cameras = [makeCamera('cam-1', 1), makeCamera('cam-2', 2)]
    const result = computeTiming(shots, cameras, 0, 0, 2000, [1])
    // remaining = 8000, intermediates = 3000 + 2000 = 5000
    expect(result.timeUntilNextVisibleMs).toBe(13000)
  })
})

// ---------------------------------------------------------------------------
// computeTiming — effectiveDurationMs (hidden shots)
// ---------------------------------------------------------------------------

describe('computeTiming — effectiveDurationMs', () => {
  it('equals live shot duration when no hidden shots follow', () => {
    const shots = [
      makeShot('s1', 'cam-1', 10000, 0),
      makeShot('s2', 'cam-2', 5000, 1),
    ]
    const cameras = [makeCamera('cam-1', 1), makeCamera('cam-2', 2)]
    const result = computeTiming(shots, cameras, 0, 0, 2000)
    expect(result.effectiveDurationMs).toBe(10000)
  })

  it('accumulates one consecutive hidden shot', () => {
    const shots = [
      makeShot('s1', 'cam-1', 10000, 0),
      makeShot('s2', 'cam-2', 3000, 1, true), // hidden
      makeShot('s3', 'cam-1', 5000, 2),
    ]
    const cameras = [makeCamera('cam-1', 1), makeCamera('cam-2', 2)]
    const result = computeTiming(shots, cameras, 0, 0, 2000)
    expect(result.effectiveDurationMs).toBe(13000) // 10000 + 3000
    expect(result.remainingMs).toBe(11000)          // 13000 - 2000
  })

  it('accumulates multiple consecutive hidden shots', () => {
    const shots = [
      makeShot('s1', 'cam-1', 10000, 0),
      makeShot('s2', 'cam-2', 3000, 1, true),
      makeShot('s3', 'cam-2', 2000, 2, true),
      makeShot('s4', 'cam-1', 5000, 3),
    ]
    const cameras = [makeCamera('cam-1', 1), makeCamera('cam-2', 2)]
    const result = computeTiming(shots, cameras, 0, 0, 2000)
    expect(result.effectiveDurationMs).toBe(15000) // 10000 + 3000 + 2000
  })

  it('stops accumulating at first non-hidden shot', () => {
    const shots = [
      makeShot('s1', 'cam-1', 10000, 0),
      makeShot('s2', 'cam-2', 3000, 1, true),
      makeShot('s3', 'cam-1', 4000, 2),          // NOT hidden — stop here
      makeShot('s4', 'cam-2', 2000, 3, true),
    ]
    const cameras = [makeCamera('cam-1', 1), makeCamera('cam-2', 2)]
    const result = computeTiming(shots, cameras, 0, 0, 2000)
    expect(result.effectiveDurationMs).toBe(13000) // 10000 + 3000 only
  })

  it('hidden shots are excluded from nextVisibleIndex', () => {
    const shots = [
      makeShot('s1', 'cam-1', 10000, 0),
      makeShot('s2', 'cam-2', 3000, 1, true), // hidden — skip
      makeShot('s3', 'cam-1', 5000, 2),       // next visible
    ]
    const cameras = [makeCamera('cam-1', 1), makeCamera('cam-2', 2)]
    const result = computeTiming(shots, cameras, 0, 0, 2000)
    expect(result.nextVisibleIndex).toBe(2)
  })
})
