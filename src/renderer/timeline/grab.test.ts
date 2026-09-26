import { describe, it, expect } from 'vitest'
import {
  MIN_ITEM_MS,
  MIN_LYRIC_MS,
  alignReferenceMedia,
  extendLastItem,
  moveMarker,
  resizeLyric,
  resizeShotPair,
  scrubPlayhead,
} from './grab'
import type { Lyric } from '../../shared/types'

describe('resizeShotPair', () => {
  const pair = { origDurationAMs: 5000, origDurationBMs: 5000 }

  it('gives one Shot exactly what it takes from the other', () => {
    expect(resizeShotPair(pair, 1500)).toEqual({ durationAMs: 6500, durationBMs: 3500 })
    expect(resizeShotPair(pair, -1500)).toEqual({ durationAMs: 3500, durationBMs: 6500 })
  })

  it('honours the minimum on both sides', () => {
    expect(resizeShotPair(pair, 4500)).toEqual({
      durationAMs: 10000 - MIN_ITEM_MS,
      durationBMs: MIN_ITEM_MS,
    })
    expect(resizeShotPair(pair, -4500)).toEqual({
      durationAMs: MIN_ITEM_MS,
      durationBMs: 10000 - MIN_ITEM_MS,
    })
  })

  it('stops rather than inverting when dragged far past the neighbour', () => {
    const over = resizeShotPair(pair, 60_000)
    expect(over).toEqual({ durationAMs: 10000 - MIN_ITEM_MS, durationBMs: MIN_ITEM_MS })
    const under = resizeShotPair(pair, -60_000)
    expect(under.durationAMs).toBeGreaterThan(0)
    expect(under.durationBMs).toBeGreaterThan(0)
  })

  it('keeps the pair total fixed, so the rest of the Rundown does not shift', () => {
    for (const delta of [0, 250, -250, 4999, -4999, 9000, -9000]) {
      const next = resizeShotPair(pair, delta)
      expect(next.durationAMs + next.durationBMs).toBe(10000)
    }
  })

  // The defect this module closes. The preview clamped `max` then `min` and the
  // commit clamped `min` then `max`; for a pair with no room in it those two
  // orders disagree, so the drag showed 500/1000 and then stored 1000/1000 —
  // lengthening the Rundown by half a second on mouse-up.
  it('gives the preview and the commit of one drag the same answer', () => {
    const tight = { origDurationAMs: 500, origDurationBMs: 1000 }
    for (const delta of [-400, 0, 300, 9000]) {
      const next = resizeShotPair(tight, delta)
      expect(next).toEqual({ durationAMs: 500, durationBMs: 1000 })
      expect(next.durationAMs + next.durationBMs).toBe(1500)
    }
  })
})

describe('extendLastItem', () => {
  it('follows the pointer past the end of the Reference media', () => {
    expect(extendLastItem({ origDurationMs: 4000 }, 90_000)).toEqual({ durationMs: 94_000 })
  })

  it('floors at the minimum', () => {
    expect(extendLastItem({ origDurationMs: 4000 }, -3500)).toEqual({ durationMs: MIN_ITEM_MS })
    expect(extendLastItem({ origDurationMs: 4000 }, -400_000)).toEqual({
      durationMs: MIN_ITEM_MS,
    })
  })
})

describe('moveMarker', () => {
  it('never goes negative', () => {
    expect(moveMarker({ origPositionMs: 2000 }, -2500)).toEqual({ positionMs: 0 })
    expect(moveMarker({ origPositionMs: 0 }, -1)).toEqual({ positionMs: 0 })
  })

  it('is deliberately unbounded above, unlike the Playhead scrub', () => {
    expect(moveMarker({ origPositionMs: 2000 }, 600_000)).toEqual({ positionMs: 602_000 })
  })

  it('rounds to whole milliseconds', () => {
    expect(moveMarker({ origPositionMs: 2000 }, 10.6)).toEqual({ positionMs: 2011 })
  })
})

describe('alignReferenceMedia', () => {
  it('rounds once, so the preview and the stored offset are the same value', () => {
    const grab = { origOffsetMs: 1200 }
    const preview = alignReferenceMedia(grab, 33.4)
    expect(preview).toEqual({ offsetMs: 1233 })
    expect(Math.round(preview.offsetMs)).toBe(preview.offsetMs)
    expect(alignReferenceMedia({ origOffsetMs: preview.offsetMs }, 0)).toEqual(preview)
  })

  it('allows a negative offset, for media starting before the Rundown', () => {
    expect(alignReferenceMedia({ origOffsetMs: 500 }, -2000)).toEqual({ offsetMs: -1500 })
  })
})

describe('scrubPlayhead', () => {
  const grab = { origMs: 5000, totalMs: 20_000 }

  it('follows the pointer inside the Rundown', () => {
    expect(scrubPlayhead(grab, 2500)).toEqual({ positionMs: 7500 })
  })

  it('stops at both ends of the Rundown', () => {
    expect(scrubPlayhead(grab, -9000)).toEqual({ positionMs: 0 })
    expect(scrubPlayhead(grab, 90_000)).toEqual({ positionMs: 20_000 })
  })
})

describe('resizeLyric', () => {
  const lyrics: Lyric[] = [
    { id: 'a', rundownId: 'r1', startMs: 0, endMs: 2000, text: 'first' },
    { id: 'b', rundownId: 'r1', startMs: 3000, endMs: 5000, text: 'second' },
    { id: 'c', rundownId: 'r1', startMs: 6000, endMs: 8000, text: 'third' },
  ]

  it('moves the start edge freely inside the gap before it', () => {
    expect(resizeLyric(lyrics, 'b', 'start', 2500)).toEqual({ startMs: 2500, endMs: 5000 })
  })

  it('moves the end edge freely inside the gap after it', () => {
    expect(resizeLyric(lyrics, 'b', 'end', 5500)).toEqual({ startMs: 3000, endMs: 5500 })
  })

  it('stops the start edge at the previous line rather than overlapping it', () => {
    expect(resizeLyric(lyrics, 'b', 'start', 500)).toEqual({ startMs: 2000, endMs: 5000 })
  })

  it('stops the end edge at the next line rather than overlapping it', () => {
    expect(resizeLyric(lyrics, 'b', 'end', 9999)).toEqual({ startMs: 3000, endMs: 6000 })
  })

  it('keeps the line at least MIN_LYRIC_MS long from either edge', () => {
    expect(resizeLyric(lyrics, 'b', 'start', 4999)).toEqual({
      startMs: 5000 - MIN_LYRIC_MS,
      endMs: 5000,
    })
    expect(resizeLyric(lyrics, 'b', 'end', 0)).toEqual({
      startMs: 3000,
      endMs: 3000 + MIN_LYRIC_MS,
    })
  })

  it('never lets the start edge go below zero', () => {
    expect(resizeLyric(lyrics, 'a', 'start', -5000)).toEqual({ startMs: 0, endMs: 2000 })
  })

  it('lets the last line extend without limit', () => {
    expect(resizeLyric(lyrics, 'c', 'end', 20000)).toEqual({ startMs: 6000, endMs: 20000 })
  })

  it('returns null for a line that is not there', () => {
    expect(resizeLyric(lyrics, 'nope', 'start', 100)).toBeNull()
  })

  it('refuses when neighbours leave no room at all', () => {
    const packed: Lyric[] = [
      { id: 'x', rundownId: 'r1', startMs: 0, endMs: 1000, text: 'x' },
      { id: 'y', rundownId: 'r1', startMs: 1000, endMs: 1100, text: 'y' },
      { id: 'z', rundownId: 'r1', startMs: 1100, endMs: 2000, text: 'z' },
    ]
    // y is already shorter than the minimum and walled in on both sides.
    expect(resizeLyric(packed, 'y', 'start', 900)).toBeNull()
    expect(resizeLyric(packed, 'y', 'end', 1500)).toBeNull()
  })

  it('rounds to whole milliseconds, since a drag is sub-pixel', () => {
    expect(resizeLyric(lyrics, 'b', 'start', 2500.7)).toEqual({ startMs: 2501, endMs: 5000 })
  })
})
