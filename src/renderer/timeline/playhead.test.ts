/**
 * The Playhead, driven by hand.
 *
 * Every rule this module exists to enforce used to be unassertable: the loop lived
 * inline in a 2500-line component, so the only way to reach it was to mount the
 * timeline, and the only suite that does that had to build a frame clock and a
 * Profiler to see anything at all. With the clock and the frame scheduler injected,
 * the same rules are ordinary unit tests — no DOM, no React, no jsdom.
 *
 * The first two blocks are the position arithmetic, which was already covered when
 * it lived in playhead-clock.ts and scroll-sync.ts. The third drives the loop.
 */

import { describe, it, expect } from 'vitest'
import {
  createPlayhead,
  editPlayheadMs,
  isEchoScroll,
  isOverrunning,
  livePlayheadMs,
  mediaTimeSecFor,
  shouldCommit,
  type BoxTarget,
  type Playhead,
  type ScrollTarget,
  type TextTarget,
} from './playhead'

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

describe('isEchoScroll', () => {
  it('recognises the exact value we wrote', () => {
    expect(isEchoScroll(1200, 1200)).toBe(true)
  })

  it('absorbs the browser rounding scrollLeft by a fraction of a pixel', () => {
    expect(isEchoScroll(1200.4, 1200)).toBe(true)
    expect(isEchoScroll(1199, 1200)).toBe(true)
  })

  it('treats a position we did not write as the operator scrolling', () => {
    expect(isEchoScroll(900, 1200)).toBe(false)
  })

  it('treats anything as the operator when we have written nothing', () => {
    // The state during an overrunning Live Shot: the playhead is frozen, nothing
    // auto-scrolls, and a drag on the overview has to be acted on.
    expect(isEchoScroll(0, null)).toBe(false)
    expect(isEchoScroll(1200, null)).toBe(false)
  })
})

const FRAME_MS = 1000 / 60
const COMMIT_INTERVAL_MS = 100
const ZOOM = 80
const TOTAL_MS = 300_000

/**
 * A hand-cranked playhead.
 *
 * `now` starts well above zero on purpose: `performance.now()` is never near the
 * commit interval in the app, and a clock starting at zero would swallow the first
 * commit and make the commit-rate assertions read differently from reality.
 */
function harness(): {
  playhead: Playhead
  /** Runs `n` frames, advancing the injected clock one frame each time. */
  step: (n: number) => void
  readout: TextTarget
  marker: BoxTarget
  viewportRect: BoxTarget
  scroller: ScrollTarget
  /** Property names read off each paint target, for the layout-reads assertion. */
  reads: { readout: string[]; marker: string[]; viewportRect: string[]; scroller: string[] }
  media: {
    currentTimeSec: number | null
    offsetMs: number | null
    plays: number
    pauses: number
    seeks: number[]
  }
  committed: { positions: number[]; scrollLefts: number[]; editEnded: number }
  /** How many frames have ever been scheduled — a restart shows up as a jump here. */
  scheduled: () => number
  frames: () => number
} {
  const START_NOW_MS = 1000
  const START_EPOCH_MS = 1_700_000_000_000
  /** Ticks elapsed, so the two clocks are computed rather than accumulated. */
  let ticks = 0
  let nowMs = START_NOW_MS
  let epochMs = START_EPOCH_MS
  let scheduled = 0
  let frames = 0
  let nextHandle = 1
  const pending = new Map<number, () => void>()

  const reads = {
    readout: [] as string[],
    marker: [] as string[],
    viewportRect: [] as string[],
    scroller: [] as string[],
  }

  /**
   * Records every property *read* off a paint target.
   *
   * This is how "the per-frame path reads no layout" becomes an assertion rather
   * than a comment: the frame path is allowed to touch `style` and to write
   * `scrollLeft` and `textContent`, and anything else it reaches for — a
   * `clientWidth`, a `getBoundingClientRect` — shows up in this list.
   */
  function watch<T extends object>(target: T, into: string[]): T {
    return new Proxy(target, {
      get(obj, key, receiver) {
        if (typeof key === 'string') into.push(key)
        return Reflect.get(obj, key, receiver)
      },
    })
  }

  const readout: TextTarget = { textContent: null }
  const marker: BoxTarget = { style: { left: '', width: '' } }
  const viewportRect: BoxTarget = { style: { left: '', width: '' } }
  const scroller: ScrollTarget = { scrollLeft: 0 }

  const media = {
    currentTimeSec: null as number | null,
    offsetMs: null as number | null,
    plays: 0,
    pauses: 0,
    seeks: [] as number[],
  }

  const committed = { positions: [] as number[], scrollLefts: [] as number[], editEnded: 0 }

  const playhead = createPlayhead({
    now: () => nowMs,
    epochNow: () => epochMs,
    scheduleFrame: (cb) => {
      scheduled++
      const handle = nextHandle++
      pending.set(handle, cb)
      return handle
    },
    cancelFrame: (handle) => {
      pending.delete(handle)
    },
    targets: {
      readout: () => watch(readout, reads.readout),
      overviewMarker: () => watch(marker, reads.marker),
      viewportRect: () => watch(viewportRect, reads.viewportRect),
      scroller: () => watch(scroller, reads.scroller),
    },
    media: {
      currentTimeSec: () => media.currentTimeSec,
      offsetMs: () => media.offsetMs,
      play: () => {
        media.plays++
      },
      pause: () => {
        media.pauses++
      },
      seekSec: (sec) => media.seeks.push(sec),
    },
    formatPosition: (ms) => `${Math.round(ms)}ms`,
    onCommitPosition: (ms) => committed.positions.push(ms),
    onCommitScrollLeft: (px) => committed.scrollLefts.push(px),
    onEditEnded: () => {
      committed.editEnded++
    },
    commitIntervalMs: COMMIT_INTERVAL_MS,
  })

  playhead.setGeometry({ totalMs: TOTAL_MS, totalPx: (TOTAL_MS / 1000) * ZOOM, zoomPxPerSec: ZOOM })
  playhead.setWidths({ scrollerPx: 800, overviewPx: 300 })

  return {
    playhead,
    step(n) {
      for (let i = 0; i < n; i++) {
        ticks++
        nowMs = START_NOW_MS + ticks * FRAME_MS
        epochMs = START_EPOCH_MS + ticks * FRAME_MS
        const due = [...pending.values()]
        pending.clear()
        for (const cb of due) {
          frames++
          cb()
        }
      }
    },
    readout,
    marker,
    viewportRect,
    scroller,
    reads,
    media,
    committed,
    scheduled: () => scheduled,
    frames: () => frames,
  }
}

describe('the playhead loop, edit mode', () => {
  it('commits at the commit interval, not once per frame', () => {
    const h = harness()
    h.playhead.playEdit()
    h.step(60)

    // 60 frames is a second of playback, so ten commit windows, give or take the
    // frame each boundary lands on.
    const expected = Math.floor((60 * FRAME_MS) / COMMIT_INTERVAL_MS)
    expect(h.committed.positions.length).toBeLessThanOrEqual(expected + 1)
    // The regression this guards: a commit on every single frame.
    expect(h.committed.positions.length).toBeLessThan(60 / 2)
  })

  it('paints every frame even though it commits rarely', () => {
    const h = harness()
    h.playhead.playEdit()

    const painted: string[] = []
    for (let i = 0; i < 20; i++) {
      h.step(1)
      painted.push(h.readout.textContent ?? '')
    }

    // Twenty frames is a third of a second: twenty distinct readouts, four commits.
    expect(new Set(painted).size).toBe(20)
    expect(h.committed.positions.length).toBeLessThanOrEqual(4)
  })

  it('reads nothing off its paint targets but the style objects it writes', () => {
    const h = harness()
    h.playhead.playEdit()
    h.step(30)

    // Reading a width back after writing a style or a scrollLeft forces a
    // synchronous layout, thirty times here and sixty times a second in the app.
    // Widths come from `setWidths`, so the frame path has no reason to touch the
    // elements beyond the two `style` objects it positions.
    expect(new Set(h.reads.marker)).toEqual(new Set(['style']))
    expect(new Set(h.reads.viewportRect)).toEqual(new Set(['style']))
    expect(h.reads.scroller).toEqual([])
    expect(h.reads.readout).toEqual([])
  })

  it('paints the overview marker and the viewport rect from the mirrored widths', () => {
    const h = harness()
    h.playhead.moveTo(150_000)

    // Half way through a 300s Rundown, on a 300px overview strip.
    expect(h.marker.style.left).toBe('150px')

    h.playhead.playEdit()
    h.step(1)
    // 800px of scroller against 24000px of content is 1/30th of a 300px strip.
    expect(h.viewportRect.style.width).toBe('10px')
  })

  it('keeps going through a zoom change, without restarting or moving its origin', () => {
    const h = harness()
    h.playhead.playEdit()
    h.step(30)

    const before = h.playhead.positionMs()
    const scheduledBefore = h.scheduled()
    expect(h.media.plays).toBe(1)

    // The operator zooms in. This is a `setGeometry` from the render body, which
    // is all a zoom step is allowed to be: the RAF effect used to list the zoom as
    // a dependency, which cancelled the loop, called play() again and re-stamped
    // the playback origin — a visible jump on every zoom step.
    h.playhead.setGeometry({
      totalMs: TOTAL_MS,
      totalPx: (TOTAL_MS / 1000) * 200,
      zoomPxPerSec: 200,
    })
    h.step(30)

    // Position still on the same wall-clock line it started on.
    expect(h.playhead.positionMs()).toBeCloseTo(before + 30 * FRAME_MS, 6)
    // One frame scheduled per frame served, plus the one still pending.
    expect(h.scheduled() - scheduledBefore).toBe(30)
    expect(h.media.plays).toBe(1)
    // And the new zoom is in force, so the mirror really is read per tick.
    expect(h.scroller.scrollLeft).toBeCloseTo((h.playhead.positionMs() / 1000) * 200, 6)
  })

  it('keeps going through a Shot edit that changes the total duration', () => {
    const h = harness()
    h.playhead.playEdit()
    h.step(30)
    const before = h.playhead.positionMs()

    h.playhead.setGeometry({
      totalMs: TOTAL_MS + 45_000,
      totalPx: ((TOTAL_MS + 45_000) / 1000) * ZOOM,
      zoomPxPerSec: ZOOM,
    })
    h.step(30)

    expect(h.playhead.positionMs()).toBeCloseTo(before + 30 * FRAME_MS, 6)
    expect(h.media.plays).toBe(1)
  })

  it('starts Reference media attached mid-playback and keeps the playhead moving', () => {
    const h = harness()
    h.playhead.playEdit()
    h.step(10)
    expect(h.playhead.positionMs()).toBeGreaterThan(0)

    // The operator imports Reference media without stopping. `editPlayheadMs`
    // treats a media clock as authoritative the moment one exists, so with nothing
    // starting the new element the playhead freezes at the media offset.
    h.media.offsetMs = 5000
    h.media.currentTimeSec = 0
    h.playhead.playEdit()
    expect(h.media.plays).toBe(2)

    const positions: number[] = []
    for (let i = 0; i < 10; i++) {
      h.media.currentTimeSec = (h.media.currentTimeSec ?? 0) + FRAME_MS / 1000
      h.step(1)
      positions.push(h.playhead.positionMs())
    }

    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1])
    }
  })

  it('leaves the origin alone when media is attached mid-playback', () => {
    const h = harness()
    h.playhead.playEdit()
    h.step(30)
    const before = h.playhead.positionMs()

    // Media that starts well before the Rundown does: its clock is pinned at zero
    // and maps to a negative timeline position, so the wall-clock branch stays in
    // charge and the origin is visible again. Re-stamping the origin's wall time
    // here — which is what the old transport did on every media change — rewinds
    // the playhead to wherever playback began.
    h.media.offsetMs = -60_000
    h.media.currentTimeSec = 0
    h.playhead.playEdit()
    h.step(1)

    expect(h.playhead.positionMs()).toBeCloseTo(before + FRAME_MS, 6)
  })

  it('stops itself at the end of the Rundown and commits where it stopped', () => {
    const h = harness()
    h.playhead.setGeometry({ totalMs: 200, totalPx: 16, zoomPxPerSec: ZOOM })
    h.playhead.playEdit()
    h.step(20)

    expect(h.playhead.positionMs()).toBe(200)
    expect(h.committed.editEnded).toBe(1)
    expect(h.media.pauses).toBe(1)
    expect(h.committed.positions.at(-1)).toBe(200)
    expect(h.committed.scrollLefts.length).toBeGreaterThan(0)
    expect(h.playhead.isRunning()).toBe(false)
    // Nothing more was scheduled once it ran off the end.
    const scheduledAtEnd = h.scheduled()
    h.step(10)
    expect(h.scheduled()).toBe(scheduledAtEnd)
  })

  it('commits the last painted position and the scroll position on stop', () => {
    const h = harness()
    h.playhead.playEdit()
    h.step(7)
    const painted = h.playhead.positionMs()
    h.playhead.stopEdit()

    expect(h.committed.positions.at(-1)).toBe(painted)
    expect(h.committed.scrollLefts.at(-1)).toBe(h.scroller.scrollLeft)
    // Stopped: the loop must not serve another frame.
    const framesAtStop = h.frames()
    h.step(5)
    expect(h.frames()).toBe(framesAtStop)
  })
})

describe('the playhead loop, Live mode', () => {
  const shot = { startMs: 60_000, durationMs: 5000 }

  it('advances from the start of the live Shot', () => {
    const h = harness()
    h.playhead.runLive({ ...shot, startedAt: 1_700_000_000_000 })
    h.step(30)

    expect(h.playhead.positionMs()).toBeCloseTo(60_000 + 30 * FRAME_MS, 6)
  })

  it('holds the playhead and stops scrolling once the live Shot overruns', () => {
    const h = harness()
    // Started six seconds ago on a five-second Shot.
    h.playhead.runLive({ ...shot, startedAt: 1_700_000_000_000 - 6000 })
    h.step(10)

    expect(h.playhead.positionMs()).toBe(65_000)
    // Nothing auto-scrolled, so nothing was committed either: an overrunning Shot
    // is not a reason to re-render the timeline sixty times a second.
    expect(h.scroller.scrollLeft).toBe(0)
    expect(h.committed.positions).toEqual([])
  })
})

describe('telling the operator scrolling apart from our own', () => {
  it('ignores the echo of the scrollLeft the loop just wrote', () => {
    const h = harness()
    h.playhead.playEdit()
    h.step(5)

    // The browser dispatches this during the next frame's rendering steps, which
    // is exactly why a flag cleared in setTimeout(0) could never guard it.
    const commitsBefore = h.committed.scrollLefts.length
    expect(h.playhead.handleScroll(h.scroller.scrollLeft, false)).toBe('echo')
    expect(h.committed.scrollLefts.length).toBe(commitsBefore)
  })

  it('honours an operator scroll during an overrunning Live Shot', () => {
    const h = harness()
    h.playhead.runLive({ startMs: 60_000, durationMs: 5000, startedAt: 1_699_999_994_000 })
    h.step(10)

    // The Shot is overrunning, so the playhead is frozen and nothing has written
    // scrollLeft. Guarding on "is playback running" dropped this event and left
    // the overview's viewport rect stuck.
    expect(h.playhead.handleScroll(4200, false)).toBe('operator')
    expect(h.committed.scrollLefts.at(-1)).toBe(4200)
  })

  it('drags the playhead and the media with an operator scroll when nothing else owns them', () => {
    const h = harness()
    h.media.offsetMs = 10_000

    expect(h.playhead.handleScroll(1600, true)).toBe('operator')

    // 1600px at 80px/s is 20s, and the media sits 10s later than the Rundown.
    expect(h.playhead.positionMs()).toBe(20_000)
    expect(h.committed.positions).toEqual([20_000])
    expect(h.media.seeks).toEqual([10])
  })

  it('leaves the playhead alone when something else owns it', () => {
    const h = harness()
    h.playhead.moveTo(30_000)
    h.committed.positions.length = 0

    expect(h.playhead.handleScroll(1600, false)).toBe('operator')
    expect(h.playhead.positionMs()).toBe(30_000)
    expect(h.committed.positions).toEqual([])
    expect(h.committed.scrollLefts).toEqual([1600])
  })

  it('treats the next event as the operator once one has been honoured', () => {
    const h = harness()
    h.playhead.playEdit()
    h.step(5)
    const written = h.scroller.scrollLeft

    expect(h.playhead.handleScroll(written + 500, false)).toBe('operator')
    // The expected value is cleared, so the same position arriving again is not an
    // echo of anything.
    expect(h.playhead.handleScroll(written, false)).toBe('operator')
  })
})

describe('discrete moves', () => {
  it('paints as well as commits, because the marker is not rendered from state', () => {
    const h = harness()
    h.playhead.moveTo(90_000)

    expect(h.readout.textContent).toBe('90000ms')
    expect(h.marker.style.left).toBe('90px')
    expect(h.committed.positions).toEqual([90_000])
  })

  it('does not scroll the timeline while no loop is following', () => {
    const h = harness()
    h.playhead.moveTo(90_000)

    // Arrow keys and clicks move the view only while playback or a Live session
    // owns it; otherwise the operator's own scroll position stands.
    expect(h.scroller.scrollLeft).toBe(0)
  })

  it('brings the view along while a loop is following', () => {
    const h = harness()
    h.playhead.playEdit()
    h.playhead.moveTo(90_000)

    expect(h.scroller.scrollLeft).toBe(7200)
  })

  it('repaints at the current position when the geometry behind it changes', () => {
    const h = harness()
    h.playhead.moveTo(150_000)
    expect(h.marker.style.left).toBe('150px')

    // The strip got wider. React will not move the marker, because the marker's
    // position is painted rather than rendered.
    h.playhead.setWidths({ overviewPx: 600 })
    h.playhead.repaint()
    expect(h.marker.style.left).toBe('300px')
  })

  it('seeks the Reference media relative to its offset, and not at all without any', () => {
    const h = harness()
    h.playhead.seekMedia(30_000)
    expect(h.media.seeks).toEqual([])

    h.media.offsetMs = 10_000
    h.playhead.seekMedia(30_000)
    h.playhead.seekMedia(4000)
    // Never before the start of the media.
    expect(h.media.seeks).toEqual([20, 0])
  })
})
