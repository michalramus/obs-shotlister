import { describe, it, expect } from 'vitest'
import {
  editPlayheadMs,
  livePlayheadMs,
  isOverrunning,
  mediaTimeSecFor,
  shouldCommit,
} from './playhead-clock'

describe('editPlayheadMs', () => {
  const origin = { headMs: 0, wallMs: 1000 }

  it('follows the wall clock with no media', () => {
    expect(editPlayheadMs({ origin, nowMs: 3500, media: null, totalMs: 60_000 })).toBe(2500)
  })

  it('resumes from where playback started', () => {
    expect(
      editPlayheadMs({
        origin: { headMs: 5000, wallMs: 1000 },
        nowMs: 2000,
        media: null,
        totalMs: 60_000,
      }),
    ).toBe(6000)
  })

  it('follows the media clock once it has started', () => {
    // Media is 2s in and sits at +10s on the timeline.
    expect(
      editPlayheadMs({
        origin,
        nowMs: 99_999,
        media: { currentTimeSec: 2, offsetMs: 10_000 },
        totalMs: 60_000,
      }),
    ).toBe(12_000)
  })

  it('falls back to the wall clock before the media starts', () => {
    // Media offset is +10s, so at media time 0 the timeline position is -10s.
    expect(
      editPlayheadMs({
        origin,
        nowMs: 3000,
        media: { currentTimeSec: 0, offsetMs: -10_000 },
        totalMs: 60_000,
      }),
    ).toBe(2000)
  })

  it('uses the wall clock when the media element has no time yet', () => {
    expect(
      editPlayheadMs({
        origin,
        nowMs: 4000,
        media: { currentTimeSec: null, offsetMs: 0 },
        totalMs: 60_000,
      }),
    ).toBe(3000)
  })

  it('never runs past the end of the rundown', () => {
    expect(editPlayheadMs({ origin, nowMs: 999_999, media: null, totalMs: 5000 })).toBe(5000)
    expect(
      editPlayheadMs({
        origin,
        nowMs: 0,
        media: { currentTimeSec: 900, offsetMs: 0 },
        totalMs: 5000,
      }),
    ).toBe(5000)
  })
})

describe('livePlayheadMs', () => {
  const shot = { shotStartMs: 10_000, shotDurationMs: 5000 }

  it('advances from the start of the live shot', () => {
    expect(livePlayheadMs({ ...shot, elapsedMs: 2000 })).toBe(12_000)
  })

  it('stops at the end of the live shot when it overruns', () => {
    // Timers are advisory: an overrunning shot must not drag the playhead into
    // the next shot's territory. See ADR 0002.
    expect(livePlayheadMs({ ...shot, elapsedMs: 60_000 })).toBe(15_000)
  })

  it('does not go backwards if elapsed is negative', () => {
    expect(livePlayheadMs({ ...shot, elapsedMs: -500 })).toBe(10_000)
  })
})

describe('isOverrunning', () => {
  it('is false inside the planned duration', () => {
    expect(isOverrunning({ shotStartMs: 0, shotDurationMs: 5000, elapsedMs: 4999 })).toBe(false)
  })

  it('is true at and past the planned duration', () => {
    expect(isOverrunning({ shotStartMs: 0, shotDurationMs: 5000, elapsedMs: 5000 })).toBe(true)
    expect(isOverrunning({ shotStartMs: 0, shotDurationMs: 5000, elapsedMs: 9000 })).toBe(true)
  })
})

describe('mediaTimeSecFor', () => {
  it('subtracts the media offset', () => {
    expect(mediaTimeSecFor(12_000, 10_000)).toBe(2)
  })

  it('never seeks before the start of the media', () => {
    expect(mediaTimeSecFor(1000, 10_000)).toBe(0)
  })
})

describe('shouldCommit', () => {
  it('commits once the interval has passed', () => {
    expect(shouldCommit(1100, 1000, 100)).toBe(true)
  })

  it('holds off inside the interval', () => {
    expect(shouldCommit(1050, 1000, 100)).toBe(false)
  })

  it('commits on the first frame after a reset', () => {
    expect(shouldCommit(1000, 0, 100)).toBe(true)
  })
})
