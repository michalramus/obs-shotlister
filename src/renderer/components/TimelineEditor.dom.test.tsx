/**
 * The frame budget of edit-mode playback.
 *
 * The timeline paints the playhead every frame but is only supposed to commit
 * React state every `PLAYHEAD_COMMIT_INTERVAL_MS`. That budget was silently lost
 * once already: `autoScroll` guarded its own `scroll` events with a flag cleared
 * in `setTimeout(0)`, but Chromium dispatches `scroll` during the *next* frame's
 * rendering steps, so the guard never held and every frame committed instead.
 * Nothing caught it, because nothing here could mount a component.
 *
 * So this is the one suite that mounts the timeline, and it asserts the two
 * things a profiler would otherwise have to tell you: how often playback
 * re-renders, and that the per-frame paint path never reads layout.
 */

import React, { Profiler } from 'react'
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TimelineEditor } from './TimelineEditor'
import type { Shot, Camera } from '../../shared/types'

const FRAME_MS = 1000 / 60
/** Must match PLAYHEAD_COMMIT_INTERVAL_MS in TimelineEditor.tsx. */
const COMMIT_INTERVAL_MS = 100

function shot(id: string, durationMs: number): Shot {
  return {
    id,
    rundownId: 'r1',
    cameraId: 'c1',
    partId: null,
    durationMs,
    label: null,
    orderIndex: Number(id.slice(1)),
    transitionName: null,
    transitionMs: 0,
  }
}

const cameras: Camera[] = [
  {
    id: 'c1',
    projectId: 'p1',
    number: 1,
    name: 'Wide',
    // Deliberately not the playhead's red, so a test can tell a Shot block in the
    // overview apart from the playhead marker.
    color: '#3498db',
    resolveColor: null,
    obsScene: null,
  },
]

const shots = [shot('s1', 30_000), shot('s2', 30_000), shot('s3', 30_000)]

/**
 * A manually driven frame clock that also models the browser step this code
 * depends on.
 *
 * jsdom has no layout, so assigning `scrollLeft` fires nothing. A real browser
 * dispatches `scroll` during the *next* frame's "update the rendering" steps —
 * which is precisely why a flag cleared in `setTimeout(0)` could never guard
 * against it. A clock that skipped this would make the regression invisible.
 */
function installFrameClock(scroller: () => Element | null): { step: (frames: number) => void } {
  let now = 0
  let callbacks: FrameRequestCallback[] = []
  let lastScrollLeft = 0

  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    callbacks.push(cb)
    return callbacks.length
  })
  vi.stubGlobal('cancelAnimationFrame', (): void => {
    callbacks = []
  })

  return {
    step(frames: number): void {
      for (let i = 0; i < frames; i++) {
        now += FRAME_MS
        const due = callbacks
        callbacks = []
        act(() => {
          for (const cb of due) cb(now)
        })
        const el = scroller()
        if (el && el.scrollLeft !== lastScrollLeft) {
          lastScrollLeft = el.scrollLeft
          act(() => {
            el.dispatchEvent(new Event('scroll'))
          })
        }
      }
    },
  }
}

/** Anything a test wants to say about the timeline, defaults for the rest. */
type Overrides = Partial<React.ComponentProps<typeof TimelineEditor>>

function renderTimeline(
  onCommit: () => void,
  overrides: Overrides = {},
): { rerender: (next: Overrides) => void } {
  const noop = (): void => {}
  const tree = (o: Overrides): React.JSX.Element => (
    <Profiler id="timeline" onRender={onCommit}>
      <TimelineEditor
        shots={shots}
        cameras={cameras}
        liveIndex={null}
        running={false}
        startedAt={null}
        markers={[]}
        onShotClick={noop}
        onSplitShot={noop}
        onResizeShots={noop}
        onExtendLastShot={noop}
        onAddMarker={noop}
        onUpdateMarker={noop}
        onDeleteMarker={noop}
        rundownMedia={null}
        onImportMedia={noop}
        onUpdateMediaOffset={noop}
        onClearMedia={noop}
        onDeleteShot={noop}
        onChangeShotCamera={noop}
        mediaVideoRef={{ current: null }}
        selectedShotId={null}
        onLabelEdit={noop}
        {...o}
      />
    </Profiler>
  )
  const result = render(tree(overrides))
  return { rerender: (next) => result.rerender(tree(next)) }
}

describe('edit-mode playback frame budget', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('commits React state at the commit interval, not once per frame', () => {
    const clock = installFrameClock(() => document.querySelector('.timeline-scroll'))
    let commits = 0
    renderTimeline(() => {
      commits++
    })

    act(() => {
      screen.getByTitle('Play/Pause (Space)').click()
    })

    const frames = 60
    commits = 0
    clock.step(frames)

    // One commit per COMMIT_INTERVAL_MS of elapsed playback, give or take the
    // frame the interval lands on.
    const expected = Math.floor((frames * FRAME_MS) / COMMIT_INTERVAL_MS)
    expect(commits).toBeLessThanOrEqual(expected + 1)
    // The regression this guards: a commit on every single frame.
    expect(commits).toBeLessThan(frames / 2)
  })

  it('moves the overview playhead marker on a discrete jump, not only during playback', () => {
    // The marker's position is painted imperatively rather than rendered, so that
    // a 60Hz paint is not overwritten by a 10Hz commit carrying a staler value.
    // The cost of that choice is that anything moving the playhead must paint —
    // a discrete step used to be React's job and would otherwise silently stop
    // moving the marker.
    installFrameClock(() => document.querySelector('.timeline-scroll'))
    renderTimeline(() => {})

    // Scoped to the overview strip: the sticky playhead line is the same red, and
    // a document-wide query finds that one first.
    const marker = (): HTMLElement | null => {
      const overview = document.querySelector('div[style*="rgb(17, 17, 17)"]')
      return overview?.querySelector('[style*="rgb(231, 76, 60)"]') ?? null
    }
    const before = marker()?.style.left
    expect(before).toBeDefined()

    act(() => {
      screen.getByTitle('Step forward 1s (→)').click()
    })

    expect(marker()?.style.left).not.toBe(before)
  })

  it('starts Reference media attached while the playhead is already running', () => {
    // editPlayheadMs treats a media clock as authoritative the moment one exists.
    // Attaching media mid-playback therefore hands it a clock sitting at zero: with
    // nothing to start that element, the playhead snaps to the media offset and
    // freezes there. The transport effect has to re-run when the media changes, not
    // only when playback starts.
    const clock = installFrameClock(() => document.querySelector('.timeline-scroll'))
    const video = document.createElement('video')
    const play = vi.spyOn(video, 'play')
    const videoRef = { current: video }

    const { rerender } = renderTimeline(() => {}, { mediaVideoRef: videoRef })

    act(() => {
      screen.getByTitle('Play/Pause (Space)').click()
    })
    clock.step(10)
    play.mockClear()

    // The operator imports Reference media without stopping.
    act(() => {
      rerender({
        mediaVideoRef: videoRef,
        rundownMedia: { filePath: '/tmp/reference.mp3', offsetMs: 5_000 },
      })
    })

    expect(play).toHaveBeenCalled()
  })

  it('never reads layout from the per-frame paint path', () => {
    const clock = installFrameClock(() => document.querySelector('.timeline-scroll'))
    renderTimeline(() => {})

    act(() => {
      screen.getByTitle('Play/Pause (Space)').click()
    })

    // Reading clientWidth after a style or scrollLeft write forces a synchronous
    // layout. The paint path must use the ResizeObserver mirrors instead.
    let reads = 0
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')
    Object.defineProperty(Element.prototype, 'clientWidth', {
      configurable: true,
      get() {
        reads++
        return 0
      },
    })

    try {
      clock.step(30)
    } finally {
      if (descriptor) Object.defineProperty(Element.prototype, 'clientWidth', descriptor)
    }

    expect(reads).toBe(0)
  })
})

/**
 * Editing a live Rundown is forbidden — `specs/live-controls.md` — and for most of
 * this component's life only the keyboard said so. Every mouse path was open: the
 * boundary drag, the Marker Track's double-click, the delete menu. The refusal now
 * lives at the seams every one of them passes through, and this is where that is
 * pinned, together with the two things that must survive it: the Playhead scrub,
 * which stores nothing, and the operator's own scroll.
 */
describe('the timeline is read-only during a Live session', () => {
  /** The props of a Rundown mid-show. */
  const live: Overrides = { running: true, liveIndex: 0, startedAt: 1_000 }

  beforeEach(() => {
    window.localStorage.clear()
    // The Live loop repaints every frame, which would overwrite what a scrub
    // painted. Nothing here needs a frame to run, so none is served.
    vi.stubGlobal('requestAnimationFrame', (): number => 1)
    vi.stubGlobal('cancelAnimationFrame', (): void => {})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /** The item Track: the first `#0d0d0d` lane, ahead of the Reference media one. */
  function itemLane(): HTMLElement {
    const lane = document.querySelector('div[style*="rgb(13, 13, 13)"]')
    if (!(lane instanceof HTMLElement)) throw new Error('no item lane')
    return lane
  }

  /** The grab strip between the first two Shots. */
  function boundaryHandle(): HTMLElement {
    const handle = itemLane().querySelector('div[style*="ew-resize"]')
    if (!(handle instanceof HTMLElement)) throw new Error('no boundary handle')
    return handle
  }

  /** The first Shot block, by the Camera colour it is painted in. */
  function shotBlock(): HTMLElement {
    const block = itemLane().querySelector('div[style*="rgb(52, 152, 219)"]')
    if (!(block instanceof HTMLElement)) throw new Error('no shot block')
    return block
  }

  function markerLane(): HTMLElement {
    const lane = document.querySelector('div[style*="rgb(30, 30, 30)"]')
    if (!(lane instanceof HTMLElement)) throw new Error('no marker lane')
    return lane
  }

  /** The Playhead's drag triangle, the only grabbable <svg> on the timeline. */
  function playheadGrip(): SVGElement {
    const grip = document.querySelector('svg[style*="cursor: grab"]')
    if (!(grip instanceof SVGElement)) throw new Error('no playhead grip')
    return grip
  }

  function overviewPlayhead(): HTMLElement {
    const overview = document.querySelector('div[style*="rgb(17, 17, 17)"]')
    const marker = overview?.querySelector('[style*="rgb(231, 76, 60)"]')
    if (!(marker instanceof HTMLElement)) throw new Error('no overview playhead')
    return marker
  }

  /** The overview's viewport rect, which follows the operator's scroll. */
  function viewportRect(): HTMLElement {
    const overview = document.querySelector('div[style*="rgb(17, 17, 17)"]')
    const rect = overview?.querySelector('div[style*="2px solid white"]')
    if (!(rect instanceof HTMLElement)) throw new Error('no viewport rect')
    return rect
  }

  /** Press, move, release — the whole of a Grab, through the window listeners. */
  function drag(target: Element, fromX: number, toX: number): void {
    act(() => {
      fireEvent.mouseDown(target, { clientX: fromX })
      fireEvent.mouseMove(window, { clientX: toX })
      fireEvent.mouseUp(window, { clientX: toX })
    })
  }

  it('refuses a Shot boundary drag while a Live session is running', () => {
    const onResizeShots = vi.fn()
    const { rerender } = renderTimeline(() => {}, { ...live, onResizeShots })

    drag(boundaryHandle(), 100, 140)
    expect(onResizeShots).not.toHaveBeenCalled()

    // The same drag in Edit mode, so a refusal is what is being asserted rather
    // than a handle this test cannot find: 40px at 80px/s is 500ms of Shot.
    act(() => rerender({ onResizeShots }))
    drag(boundaryHandle(), 100, 140)
    expect(onResizeShots).toHaveBeenCalledWith('s1', 30_500, 's2', 29_500)
  })

  it('refuses the extend drag on the last Shot while a Live session is running', () => {
    const onExtendLastShot = vi.fn()
    const { rerender } = renderTimeline(() => {}, { ...live, onExtendLastShot })

    // The trailing handle is the last `ew-resize` strip on the item Track.
    const handles = itemLane().querySelectorAll('div[style*="ew-resize"]')
    const trailing = handles[handles.length - 1]
    drag(trailing, 100, 200)
    expect(onExtendLastShot).not.toHaveBeenCalled()

    act(() => rerender({ onExtendLastShot }))
    drag(trailing, 100, 200)
    expect(onExtendLastShot).toHaveBeenCalled()
  })

  it('adds no Marker when the Marker Track is double-clicked during a Live session', () => {
    const onAddMarker = vi.fn()
    const { rerender } = renderTimeline(() => {}, { ...live, onAddMarker })

    act(() => {
      fireEvent.dblClick(markerLane())
    })
    expect(onAddMarker).not.toHaveBeenCalled()

    act(() => rerender({ onAddMarker }))
    act(() => {
      fireEvent.dblClick(markerLane())
    })
    expect(onAddMarker).toHaveBeenCalledTimes(1)
  })

  it('opens no context menu on a Shot during a Live session', () => {
    const onDeleteShot = vi.fn()
    const { rerender } = renderTimeline(() => {}, { ...live, onDeleteShot })

    act(() => {
      fireEvent.contextMenu(shotBlock())
    })
    // No menu means no way to reach either delete.
    expect(screen.queryByText('Delete shot')).toBeNull()
    expect(screen.queryByText('Delete and close gap')).toBeNull()

    act(() => rerender({ onDeleteShot }))
    act(() => {
      fireEvent.contextMenu(shotBlock())
    })
    expect(screen.queryByText('Delete shot')).not.toBeNull()
  })

  it('disables the Camera buttons during a Live session', () => {
    const onSplitShot = vi.fn()
    renderTimeline(() => {}, { ...live, onSplitShot })

    const button = screen.getByTitle<HTMLButtonElement>('Split at playhead and assign CAM1 Wide')
    expect(button.disabled).toBe(true)

    // Disabled or not, the handler refuses: the number keys reach the same one.
    act(() => {
      button.click()
    })
    expect(onSplitShot).not.toHaveBeenCalled()
  })

  it('still scrubs the Playhead during a Live session', () => {
    renderTimeline(() => {}, live)

    const before = overviewPlayhead().style.left

    // 400px at 80px/s: five seconds along, and nothing stored by either of them.
    drag(playheadGrip(), 0, 400)

    expect(overviewPlayhead().style.left).not.toBe(before)
  })

  it("still honours the operator's own scroll during a Live session", () => {
    // An overrunning Live Shot freezes the Playhead and stops the auto-scroll, so
    // a scroll then is the operator's and must move the view. It used to be
    // dropped, which left the overview's viewport rect stuck.
    renderTimeline(() => {}, live)

    const before = viewportRect().style.left
    const scroller = document.querySelector('.timeline-scroll')
    if (!(scroller instanceof HTMLElement)) throw new Error('no scroller')

    act(() => {
      scroller.scrollLeft = 1200
      scroller.dispatchEvent(new Event('scroll'))
    })

    expect(viewportRect().style.left).not.toBe(before)
  })
})
