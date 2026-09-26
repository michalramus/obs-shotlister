/**
 * The authoring loop, without a renderer.
 *
 * Every rule here used to be reachable only by mounting a two-thousand-line
 * component and pressing keys at it, so none of it was tested — including the two
 * that cost the operator real work when they break: a refused write must leave the
 * typed line on screen, and a Lyric must never be stored with no length.
 */

import { describe, it, expect } from 'vitest'
import {
  applyLyricEvent,
  initialLyricAuthoring,
  type LyricAuthoringEvent,
  type LyricAuthoringState,
  type LyricTransition,
} from './lyric-authoring'
import type { Lyric } from '../../shared/types'

function lyric(id: string, startMs: number, endMs: number, text = id): Lyric {
  return { id, rundownId: 'r1', startMs, endMs, text }
}

/** Replays a sequence of events, keeping the last transition's write. */
function drive(
  lyrics: readonly Lyric[],
  events: LyricAuthoringEvent[],
  from: LyricAuthoringState = initialLyricAuthoring,
): LyricTransition {
  let result: LyricTransition = { state: from, write: null }
  for (const event of events) {
    result = applyLyricEvent(result.state, event, lyrics)
  }
  return result
}

describe('authoring a new Lyric', () => {
  it('opens a pending In point, then a draft on Out, then writes the typed line', () => {
    const opened = drive([], [{ type: 'setIn', atMs: 2000 }])
    expect(opened.state.pendingInMs).toBe(2000)
    expect(opened.state.draft).toBeNull()
    expect(opened.write).toBeNull()

    const drafted = applyLyricEvent(opened.state, { type: 'setOut', atMs: 5000 }, [])
    expect(drafted.state.draft).toEqual({ id: null, startMs: 2000, endMs: 5000, text: '' })
    expect(drafted.write).toBeNull()

    const typed = applyLyricEvent(drafted.state, { type: 'type', text: 'bez ciebie' }, [])
    const committed = applyLyricEvent(typed.state, { type: 'commit' }, [])
    expect(committed.write).toEqual({
      id: null,
      startMs: 2000,
      endMs: 5000,
      text: 'bez ciebie',
      closesLoop: true,
    })
  })

  it('clears the loop once the store confirms the write', () => {
    const committed = drive(
      [],
      [
        { type: 'setIn', atMs: 2000 },
        { type: 'setOut', atMs: 5000 },
        { type: 'type', text: 'bez ciebie' },
        { type: 'commit' },
      ],
    )
    const write = committed.write
    expect(write).not.toBeNull()
    if (write === null) return

    const done = applyLyricEvent(committed.state, { type: 'saved', write }, [])
    expect(done.state).toEqual(initialLyricAuthoring)
  })

  it('rounds the In point to whole milliseconds', () => {
    expect(drive([], [{ type: 'setIn', atMs: 2000.6 }]).state.pendingInMs).toBe(2001)
  })

  it('leaves the pending In point standing when the wording is abandoned', () => {
    // Escape gives up on the text, not on the mark made before typing it.
    const cancelled = drive(
      [],
      [{ type: 'setIn', atMs: 2000 }, { type: 'setOut', atMs: 5000 }, { type: 'cancel' }],
    )
    expect(cancelled.state.draft).toBeNull()
    expect(cancelled.state.pendingInMs).toBe(2000)
  })
})

describe('correcting a selected Lyric', () => {
  const lyrics = [lyric('a', 4000, 8000, 'wers')]

  it('moves the selected line in point and writes nothing else', () => {
    const moved = drive(lyrics, [
      { type: 'select', id: 'a' },
      { type: 'setIn', atMs: 3000 },
    ])
    expect(moved.write).toEqual({
      id: 'a',
      startMs: 3000,
      endMs: 8000,
      text: 'wers',
      closesLoop: false,
    })
    // No draft opened and no pending In left behind: In on a selected line is a
    // correction, not the start of a new line.
    expect(moved.state.draft).toBeNull()
    expect(moved.state.pendingInMs).toBeNull()
  })

  it('keeps the line selected after the move is stored', () => {
    const moved = drive(lyrics, [
      { type: 'select', id: 'a' },
      { type: 'setIn', atMs: 3000 },
    ])
    const write = moved.write
    if (write === null) throw new Error('expected a write')
    const done = applyLyricEvent(moved.state, { type: 'saved', write }, lyrics)
    expect(done.state.selectedId).toBe('a')
  })

  it('moves the selected line out point on Out rather than opening a draft', () => {
    const moved = drive(lyrics, [
      { type: 'select', id: 'a' },
      { type: 'setOut', atMs: 9000 },
    ])
    expect(moved.write).toMatchObject({ id: 'a', startMs: 4000, endMs: 9000 })
    expect(moved.state.draft).toBeNull()
  })

  it('treats a click on the selected line as a deselect', () => {
    const toggled = drive(lyrics, [
      { type: 'select', id: 'a' },
      { type: 'select', id: 'a' },
    ])
    expect(toggled.state.selectedId).toBeNull()
  })
})

describe('what the operator is told went wrong', () => {
  it('reports an Out with no In', () => {
    const out = drive([], [{ type: 'setOut', atMs: 5000 }])
    expect(out.state.error).toBe('Set an In point first')
    expect(out.state.draft).toBeNull()
    expect(out.write).toBeNull()
  })

  it('reports an Out set on top of the In', () => {
    const out = drive(
      [],
      [
        { type: 'setIn', atMs: 2000 },
        { type: 'setOut', atMs: 2000 },
      ],
    )
    expect(out.state.error).toBe('Set the Out point away from the In point')
    expect(out.write).toBeNull()
  })

  it('names the line an Out would run into', () => {
    const lyrics = [lyric('a', 4000, 8000, 'wers')]
    const out = drive(lyrics, [
      { type: 'setIn', atMs: 2000 },
      { type: 'setOut', atMs: 5000 },
    ])
    expect(out.state.error).toBe('Overlaps “wers”')
    expect(out.state.draft).toBeNull()
  })

  it('refuses to leave a selected line no length', () => {
    const lyrics = [lyric('a', 4000, 8000)]
    const moved = drive(lyrics, [
      { type: 'select', id: 'a' },
      { type: 'setIn', atMs: 8000 },
    ])
    expect(moved.state.error).toBe('That would leave the line no length')
    expect(moved.write).toBeNull()
  })

  it('clears the error when it is dismissed', () => {
    const dismissed = drive([], [{ type: 'setOut', atMs: 5000 }, { type: 'dismissError' }])
    expect(dismissed.state.error).toBeNull()
  })
})

describe('a refused write keeps the typed text', () => {
  const typeALine: LyricAuthoringEvent[] = [
    { type: 'setIn', atMs: 2000 },
    { type: 'setOut', atMs: 5000 },
    { type: 'type', text: 'bez ciebie' },
  ]

  it('refuses an overlap and leaves the draft exactly as typed', () => {
    // The clash appears after the range was fixed — another line was authored, or
    // dragged, while this one was being worded.
    const drafted = drive([], typeALine)
    const clashing = [lyric('a', 3000, 6000, 'wers')]
    const committed = applyLyricEvent(drafted.state, { type: 'commit' }, clashing)

    expect(committed.write).toBeNull()
    expect(committed.state.error).toBe('Overlaps “wers”')
    expect(committed.state.draft).toEqual({
      id: null,
      startMs: 2000,
      endMs: 5000,
      text: 'bez ciebie',
    })
  })

  it('refuses empty text without clearing the draft', () => {
    const drafted = drive(
      [],
      [
        { type: 'setIn', atMs: 2000 },
        { type: 'setOut', atMs: 5000 },
      ],
    )
    const blank = applyLyricEvent(drafted.state, { type: 'type', text: '   ' }, [])
    const committed = applyLyricEvent(blank.state, { type: 'commit' }, [])

    expect(committed.write).toBeNull()
    expect(committed.state.error).toBe('A line needs some text')
    expect(committed.state.draft?.text).toBe('   ')
  })

  it('keeps the draft when the store itself refuses the write', () => {
    const drafted = drive([], typeALine)
    const refused = applyLyricEvent(
      drafted.state,
      { type: 'refused', message: 'lyrics overlap an existing line' },
      [],
    )
    expect(refused.state.error).toBe('lyrics overlap an existing line')
    expect(refused.state.draft?.text).toBe('bez ciebie')
  })
})

describe('no Lyric is ever written with zero or negative length', () => {
  const zeroOrLess: Array<[string, LyricAuthoringEvent[], readonly Lyric[]]> = [
    [
      'Out on the In point',
      [
        { type: 'setIn', atMs: 2000 },
        { type: 'setOut', atMs: 2000 },
      ],
      [],
    ],
    [
      'In set on the selected line end',
      [
        { type: 'select', id: 'a' },
        { type: 'setIn', atMs: 8000 },
      ],
      [lyric('a', 4000, 8000)],
    ],
    [
      'Out set on the selected line start',
      [
        { type: 'select', id: 'a' },
        { type: 'setOut', atMs: 4000 },
      ],
      [lyric('a', 4000, 8000)],
    ],
    [
      'an inverted edge drag',
      [{ type: 'edgeDragged', id: 'a', startMs: 8000, endMs: 4000 }],
      [lyric('a', 4000, 8000)],
    ],
    [
      'an edge drag collapsed onto itself',
      [{ type: 'edgeDragged', id: 'a', startMs: 8000, endMs: 8000 }],
      [lyric('a', 4000, 8000)],
    ],
  ]

  for (const [what, events, lyrics] of zeroOrLess) {
    it(`refuses ${what}`, () => {
      const result = drive(lyrics, events)
      expect(result.write).toBeNull()
      expect(result.state.error).not.toBeNull()
    })
  }

  it('writes the edge a drag actually landed on', () => {
    const lyrics = [lyric('a', 4000, 8000, 'wers')]
    const dragged = drive(lyrics, [{ type: 'edgeDragged', id: 'a', startMs: 4000, endMs: 7000 }])
    expect(dragged.write).toEqual({
      id: 'a',
      startMs: 4000,
      endMs: 7000,
      text: 'wers',
      closesLoop: false,
    })
  })
})

describe('re-wording and deleting', () => {
  const lyrics = [lyric('a', 4000, 8000, 'wers')]

  it('loads the existing line into the draft, range and all', () => {
    const reworded = drive(lyrics, [{ type: 'reword', id: 'a' }])
    expect(reworded.state.draft).toEqual({ id: 'a', startMs: 4000, endMs: 8000, text: 'wers' })
    expect(reworded.state.selectedId).toBe('a')
  })

  it('writes the re-worded line against its own id, so it does not clash with itself', () => {
    const committed = drive(lyrics, [
      { type: 'reword', id: 'a' },
      { type: 'type', text: 'wers drugi' },
      { type: 'commit' },
    ])
    expect(committed.write).toEqual({
      id: 'a',
      startMs: 4000,
      endMs: 8000,
      text: 'wers drugi',
      closesLoop: true,
    })
  })

  it('drops the selection when the selected line is deleted', () => {
    const deleted = drive(lyrics, [
      { type: 'select', id: 'a' },
      { type: 'deleted', id: 'a' },
    ])
    expect(deleted.state.selectedId).toBeNull()
  })

  it('leaves the state object alone for an event that means nothing here', () => {
    // Identity matters: this is what stops a `useState` setter re-rendering the
    // timeline for a keystroke that changed nothing.
    const before = initialLyricAuthoring
    expect(applyLyricEvent(before, { type: 'type', text: 'x' }, []).state).toBe(before)
    expect(applyLyricEvent(before, { type: 'commit' }, []).state).toBe(before)
    expect(applyLyricEvent(before, { type: 'clearSelection' }, []).state).toBe(before)
  })
})
