import { describe, it, expect } from 'vitest'
import {
  lyricRange,
  rangesOverlap,
  overlappingLyric,
  lyricAtMs,
  lyricBlocks,
  isUnassigned,
  announcementProblemsByCallId,
  resizeLyric,
  MIN_LYRIC_MS,
} from './lyrics'
import type { Lyric, Shot } from '../../shared/types'

function lyric(id: string, startMs: number, endMs: number, text = id): Lyric {
  return { id, rundownId: 'r1', startMs, endMs, text }
}

function item(id: string, durationMs: number, over: Partial<Shot> = {}): Shot {
  return {
    id,
    rundownId: 'r1',
    cameraId: null,
    partId: null,
    durationMs,
    label: null,
    orderIndex: 0,
    transitionName: null,
    transitionMs: 0,
    ...over,
  }
}

describe('lyricRange', () => {
  it('builds a range from an In then an Out', () => {
    expect(lyricRange(1000, 4000)).toEqual({ startMs: 1000, endMs: 4000 })
  })

  it('orders an Out set behind the In rather than refusing it', () => {
    expect(lyricRange(4000, 1000)).toEqual({ startMs: 1000, endMs: 4000 })
  })

  it('rounds to whole milliseconds', () => {
    expect(lyricRange(1000.4, 3999.6)).toEqual({ startMs: 1000, endMs: 4000 })
  })

  it('refuses a zero-length line', () => {
    expect(lyricRange(2000, 2000)).toBeNull()
  })
})

describe('rangesOverlap', () => {
  it('sees a partial overlap from either side', () => {
    const a = { startMs: 1000, endMs: 3000 }
    expect(rangesOverlap(a, { startMs: 2000, endMs: 4000 })).toBe(true)
    expect(rangesOverlap({ startMs: 2000, endMs: 4000 }, a)).toBe(true)
  })

  it('sees containment', () => {
    expect(rangesOverlap({ startMs: 0, endMs: 9000 }, { startMs: 1000, endMs: 2000 })).toBe(true)
  })

  it('does not count lines that merely touch', () => {
    expect(rangesOverlap({ startMs: 0, endMs: 1000 }, { startMs: 1000, endMs: 2000 })).toBe(false)
  })

  it('does not count lines that are clear of each other', () => {
    expect(rangesOverlap({ startMs: 0, endMs: 1000 }, { startMs: 5000, endMs: 6000 })).toBe(false)
  })
})

describe('overlappingLyric', () => {
  const lyrics = [lyric('a', 0, 2000), lyric('b', 4000, 6000)]

  it('names the line in the way', () => {
    expect(overlappingLyric(lyrics, { startMs: 1000, endMs: 3000 })?.id).toBe('a')
  })

  it('passes a line that fits in the gap', () => {
    expect(overlappingLyric(lyrics, { startMs: 2000, endMs: 4000 })).toBeNull()
  })

  it('does not report a line clashing with itself while its boundary moves', () => {
    expect(overlappingLyric(lyrics, { startMs: 0, endMs: 3000 }, 'a')).toBeNull()
  })

  it('still reports a neighbour when the edited line runs into it', () => {
    expect(overlappingLyric(lyrics, { startMs: 0, endMs: 5000 }, 'a')?.id).toBe('b')
  })
})

describe('lyricAtMs', () => {
  const lyrics = [lyric('a', 0, 2000), lyric('b', 4000, 6000)]

  it('finds the line the playhead is inside', () => {
    expect(lyricAtMs(lyrics, 1500)?.id).toBe('a')
    expect(lyricAtMs(lyrics, 4000)?.id).toBe('b')
  })

  it('returns null in the gap between lines', () => {
    expect(lyricAtMs(lyrics, 3000)).toBeNull()
  })

  it('treats the end of a line as outside it, so touching lines never both match', () => {
    expect(lyricAtMs(lyrics, 2000)).toBeNull()
  })

  it('returns null past the last line', () => {
    expect(lyricAtMs(lyrics, 60000)).toBeNull()
  })
})

describe('lyricBlocks', () => {
  it('lays lines out against the same axis as the item lane', () => {
    expect(lyricBlocks([lyric('a', 1000, 3000)], 80)).toEqual([
      { id: 'a', text: 'a', leftPx: 80, widthPx: 160 },
    ])
  })

  it('keeps a very short line wide enough to hit', () => {
    const [block] = lyricBlocks([lyric('a', 1000, 1010)], 5)
    expect(block.leftPx).toBeCloseTo(5)
    expect(block.widthPx).toBe(3)
  })
})

describe('isUnassigned', () => {
  it('reads the Camera in a Camera Rundown and the Part in a Voice-over one', () => {
    const call = item('s1', 1000, { partId: 'p1' })
    expect(isUnassigned(call, 'voice')).toBe(false)
    expect(isUnassigned(call, 'camera')).toBe(true)

    const shot = item('s2', 1000, { cameraId: 'c1' })
    expect(isUnassigned(shot, 'camera')).toBe(false)
    expect(isUnassigned(shot, 'voice')).toBe(true)
  })
})

describe('announcementProblemsByCallId', () => {
  const phrase = (partId: string): number | null => (partId === 'long' ? 3000 : 500)
  /** A generous countdown, so only the Call's own length decides the outcome. */
  const settings = {
    countdown: [10, 5, 3, 2, 1],
    placement: 'flush' as const,
    transmissionDelayMs: 0,
  }

  it('badges as dropped the Call whose phrase does not fit the Call before it', () => {
    const items = [item('a', 1000, { partId: 'short' }), item('b', 5000, { partId: 'long' })]
    expect([...announcementProblemsByCallId(items, phrase, settings)]).toEqual([['b', 'dropped']])
  })

  it('badges as phrase-only a Call with room for the name but not for a number', () => {
    // 1.4s of lead: "1" lands at 400ms, nowhere near enough for 500ms of phrase
    // and its breath — but the name still fits against the Call's own start.
    const items = [item('a', 1400, { partId: 'short' }), item('b', 5000, { partId: 'short' })]
    expect(announcementProblemsByCallId(items, phrase, settings).get('b')).toBe('phrase-only')
  })

  it('says nothing about a Call that will announce normally', () => {
    const items = [item('a', 15000, { partId: 'short' }), item('b', 5000, { partId: 'short' })]
    expect(announcementProblemsByCallId(items, phrase, settings).size).toBe(0)
  })

  it('badges every Call as phrase-only when the countdown is empty', () => {
    const items = [item('a', 15000, { partId: 'short' }), item('b', 5000, { partId: 'short' })]
    const problems = announcementProblemsByCallId(items, phrase, { ...settings, countdown: [] })
    expect(problems.get('b')).toBe('phrase-only')
  })

  it('never badges the first item, which nothing announces', () => {
    const items = [item('a', 1000, { partId: 'long' })]
    expect(announcementProblemsByCallId(items, phrase, settings).size).toBe(0)
  })

  it('takes the lead from the previous visible item, skipping Hidden ones', () => {
    const items = [
      item('a', 10000, { partId: 'short' }),
      item('h', 800, { partId: 'short', hidden: true }),
      item('b', 5000, { partId: 'long' }),
    ]
    // 'b' is announced during 'a', not during the Hidden 'h', so 3000ms fits.
    expect(announcementProblemsByCallId(items, phrase, settings).size).toBe(0)
  })

  it('badges nothing when no duration is known for the Part', () => {
    const items = [item('a', 100, { partId: 'short' }), item('b', 5000, { partId: 'long' })]
    expect(announcementProblemsByCallId(items, () => null, settings).size).toBe(0)
  })

  it('ignores an unassigned item, which has no phrase to speak', () => {
    const items = [item('a', 100, { partId: 'short' }), item('b', 5000)]
    expect(announcementProblemsByCallId(items, phrase, settings).size).toBe(0)
  })

  it('accounts for the path delay eating the lead', () => {
    const items = [item('a', 15000, { partId: 'short' }), item('b', 5000, { partId: 'short' })]
    const withDelay = { ...settings, transmissionDelayMs: 400 }
    // Still plenty of room at 15s; the delay only shifts things.
    expect(announcementProblemsByCallId(items, phrase, withDelay).size).toBe(0)
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
