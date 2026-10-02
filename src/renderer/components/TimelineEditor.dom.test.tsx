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
import { useAppStore } from '../store'
import type { Shot, Camera, Lyric, Marker, Part, Rundown } from '../../shared/types'
import type { LyricUpsertInput } from '../../shared/ipc-contract'

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
        readOnly={false}
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

/**
 * The transport's position readout, `m:ss.t`.
 *
 * Read from the DOM rather than from committed state on purpose: it is painted
 * every frame and committed rarely, so it is the closest thing a test has to what
 * the operator is looking at.
 */
function readout(): string {
  const span = [...document.querySelectorAll('span')].find((el) =>
    /^\d+:\d\d\.\d$/.test(el.textContent ?? ''),
  )
  if (!span) throw new Error('no playhead readout on screen')
  return span.textContent ?? ''
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

  it('keeps the playhead moving when the Reference media file is missing', () => {
    // `App` mounts a <video> for any video-extension path without checking the
    // file is there, so a Rundown whose Reference media has been moved or deleted
    // still hands the timeline an element. That element reports `currentTime` 0
    // for good, and `editPlayheadMs` treats any media clock as authoritative: the
    // Playhead used to snap to the media offset on the first frame and sit there
    // for the rest of playback, with the transport showing as playing. Reference
    // media with a bare audio path never did this, because its `Audio` element is
    // only built after `mediaFileExists` — which is what made the freeze look
    // intermittent.
    const clock = installFrameClock(() => document.querySelector('.timeline-scroll'))
    // jsdom loads nothing, so a fresh element is exactly a media element whose
    // file has not arrived: readyState HAVE_NOTHING and no time of its own.
    const video = document.createElement('video')
    expect(video.readyState).toBe(HTMLMediaElement.HAVE_NOTHING)

    renderTimeline(() => {}, {
      mediaVideoRef: { current: video },
      rundownMedia: { filePath: '/gone/reference.mp4', offsetMs: 8000 },
    })

    act(() => {
      screen.getByTitle('Play/Pause (Space)').click()
    })

    const positions: string[] = []
    for (let i = 0; i < 4; i++) {
      clock.step(10)
      positions.push(readout())
    }

    // Never parked on the media offset, and further along on every sample.
    expect(positions).not.toContain('0:08.0')
    expect(new Set(positions).size).toBe(positions.length)
    expect(positions.at(-1)).not.toBe('0:00.0')
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
 * A Rundown is edited in Edit mode, so the timeline is a read-out in Live mode —
 * `specs/live-controls.md`.
 *
 * Every guard here keyed on `running` once, which is what made it worthless: a
 * Live session is only on air after Start, so for the whole of Live mode before it
 * `running` was false and the entire timeline was editable. The operator could
 * still drag a Shot's edge and press the Camera buttons with the show queued up.
 * The lock is the view now, which is why each refusal below is asserted twice —
 * before Start and on air — and always paired with the same gesture landing in
 * Edit mode, so a selector that stops matching fails instead of passing on an
 * element it never found.
 */
describe('the timeline is read-only in Live mode', () => {
  /** Live mode before Start: the view is locked, and nothing is on air. */
  const preStart: Overrides = { readOnly: true }
  /** Live mode with a Live session on air. */
  const onAir: Overrides = { readOnly: true, running: true, liveIndex: 0, startedAt: 1_000 }

  const marker: Marker = { id: 'm1', rundownId: 'r1', positionMs: 4_000, label: 'Refren' }
  const lyric: Lyric = { id: 'ly1', rundownId: 'r1', startMs: 0, endMs: 5_000, text: 'first line' }
  const part: Part = {
    id: 'pt1',
    projectId: 'p1',
    number: 1,
    name: 'Refren',
    color: '#e74c3c',
    folder: null,
    rundownId: null,
  }
  const voiceRundown: Rundown = {
    id: 'r1',
    projectId: 'p1',
    name: 'Calls',
    createdAt: 0,
    orderIndex: 0,
    folder: null,
    kind: 'voice',
  }

  /** Lyrics, Parts and the Rundown's Kind reach the timeline through the store. */
  const storeSnapshot = useAppStore.getState()

  beforeEach(() => {
    window.localStorage.clear()
    // The Live loop repaints every frame, which would overwrite what a scrub
    // painted. Nothing here needs a frame to run, so none is served.
    vi.stubGlobal('requestAnimationFrame', (): number => 1)
    vi.stubGlobal('cancelAnimationFrame', (): void => {})
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(storeSnapshot, true)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /** The item Track: the first `#0d0d0d` lane, ahead of the Reference media one. */
  function itemLane(): HTMLElement {
    const lane = document.querySelector('div[style*="rgb(13, 13, 13)"]')
    if (!(lane instanceof HTMLElement)) throw new Error('no item lane')
    return lane
  }

  /** The Reference media Track: the other `#0d0d0d` lane, below the item one. */
  function mediaLane(): HTMLElement {
    const lanes = document.querySelectorAll('div[style*="rgb(13, 13, 13)"]')
    const lane = lanes[lanes.length - 1]
    if (!(lane instanceof HTMLElement) || lanes.length < 2) throw new Error('no media lane')
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

  /** A Marker's label, which is also the handle its inline edit opens from. */
  function markerLabel(): HTMLElement {
    const span = markerLane().querySelector('span')
    if (!(span instanceof HTMLElement)) throw new Error('no marker label')
    return span
  }

  /** The Lyrics Track's `#141414` lane. */
  function lyricBlock(): HTMLElement {
    const lane = document.querySelector('div[style*="rgb(20, 20, 20)"]')
    const block = lane?.querySelector('div[title*="click to select"]')
    if (!(block instanceof HTMLElement)) throw new Error('no lyric block')
    return block
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

  function playButton(): HTMLButtonElement {
    return screen.getByTitle<HTMLButtonElement>('Play/Pause (Space)')
  }

  /** Press, move, release — the whole of a Grab, through the window listeners. */
  function drag(target: Element, fromX: number, toX: number): void {
    act(() => {
      fireEvent.mouseDown(target, { clientX: fromX })
      fireEvent.mouseMove(window, { clientX: toX })
      fireEvent.mouseUp(window, { clientX: toX })
    })
  }

  function press(init: KeyboardEventInit): void {
    act(() => {
      fireEvent.keyDown(window, init)
    })
  }

  /**
   * Both locked states, because the one that was missing is the one that was
   * broken: Live mode with the show not yet started.
   */
  const lockedViews = [
    { name: 'in Live mode before Start', view: preStart },
    { name: 'with a Live session on air', view: onAir },
  ]

  describe.each(lockedViews)('$name', ({ view }) => {
    it('offers no Shot boundary handle, and no extend handle on the last Shot', () => {
      // The item Track took no `readOnly` at all, so both 8px `ew-resize` strips
      // stayed on it and lit up under the pointer in Live mode — promising a drag
      // the grab adapter then refused.
      const onResizeShots = vi.fn()
      const onExtendLastShot = vi.fn()
      const { rerender } = renderTimeline(() => {}, { ...view, onResizeShots, onExtendLastShot })

      expect(itemLane().querySelectorAll('div[style*="ew-resize"]')).toHaveLength(0)

      // The same handles in Edit mode, so their absence is what is being asserted
      // rather than a selector that has stopped matching: two boundaries between
      // three Shots, plus the trailing one. 40px at 80px/s is 500ms of Shot.
      act(() => rerender({ onResizeShots, onExtendLastShot }))
      const handles = (): NodeListOf<Element> =>
        itemLane().querySelectorAll('div[style*="ew-resize"]')
      expect(handles()).toHaveLength(3)

      drag(boundaryHandle(), 100, 140)
      expect(onResizeShots).toHaveBeenCalledWith('s1', 30_500, 's2', 29_500)
      drag(handles()[2], 100, 200)
      expect(onExtendLastShot).toHaveBeenCalled()
    })

    it('refuses the Reference media offset drag', () => {
      // The lane keeps its `mousedown`: the refusal that matters is the grab
      // adapter's, which is what every Grab passes through and what a Grab added
      // later is refused by without anyone remembering to ask.
      const onUpdateMediaOffset = vi.fn()
      const media = { filePath: '/tmp/reference.mp3', offsetMs: 0 }
      const { rerender } = renderTimeline(() => {}, {
        ...view,
        rundownMedia: media,
        onUpdateMediaOffset,
      })

      drag(mediaLane(), 100, 300)
      expect(onUpdateMediaOffset).not.toHaveBeenCalled()
      // Nor does the lane invite the drag: a grab cursor is its only sign.
      expect(mediaLane().style.cursor).toBe('default')

      act(() => rerender({ rundownMedia: media, onUpdateMediaOffset }))
      expect(mediaLane().style.cursor).toBe('grab')
      drag(mediaLane(), 100, 300)
      expect(onUpdateMediaOffset).toHaveBeenCalledWith(2_500)
    })

    it('adds no Marker when the Marker Track is double-clicked', () => {
      const onAddMarker = vi.fn()
      const { rerender } = renderTimeline(() => {}, { ...view, onAddMarker })

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

    it("offers no edit of a Marker's label", () => {
      const onUpdateMarker = vi.fn()
      const { rerender } = renderTimeline(() => {}, { ...view, markers: [marker], onUpdateMarker })

      act(() => {
        fireEvent.click(markerLabel())
      })
      expect(screen.queryByRole('textbox')).toBeNull()

      act(() => rerender({ markers: [marker], onUpdateMarker }))
      act(() => {
        fireEvent.click(markerLabel())
      })
      const input = screen.getByRole('textbox')
      act(() => {
        fireEvent.change(input, { target: { value: 'Verse' } })
        fireEvent.keyDown(input, { key: 'Enter' })
      })
      expect(onUpdateMarker).toHaveBeenCalledWith('m1', 4_000, 'Verse')
    })

    it('offers no Marker delete', () => {
      const onDeleteMarker = vi.fn()
      const { rerender } = renderTimeline(() => {}, { ...view, markers: [marker], onDeleteMarker })

      // The delete button only exists while the Marker is hovered.
      const hoverMarker = (): void => {
        const line = markerLabel().parentElement
        if (line === null) throw new Error('no marker to hover')
        act(() => {
          fireEvent.mouseEnter(line)
        })
      }
      hoverMarker()
      expect(screen.queryByTitle('Delete marker')).toBeNull()

      act(() => rerender({ markers: [marker], onDeleteMarker }))
      hoverMarker()
      act(() => {
        screen.getByTitle('Delete marker').click()
      })
      expect(onDeleteMarker).toHaveBeenCalledWith('m1')
    })

    it('refuses to re-word a Lyric', () => {
      useAppStore.setState({ lyrics: [lyric], activeRundownId: 'r1' })
      const { rerender } = renderTimeline(() => {}, view)

      act(() => {
        fireEvent.doubleClick(lyricBlock())
      })
      expect(screen.queryByPlaceholderText('line of lyrics')).toBeNull()

      act(() => rerender({}))
      act(() => {
        fireEvent.doubleClick(lyricBlock())
      })
      expect(screen.getByPlaceholderText('line of lyrics')).toHaveProperty('value', 'first line')
    })

    it('offers no Lyric delete', () => {
      const removeLyric = vi.fn(async () => {})
      useAppStore.setState({ lyrics: [lyric], activeRundownId: 'r1', removeLyric })
      const { rerender } = renderTimeline(() => {}, view)

      const hoverLyric = (): void => {
        act(() => {
          fireEvent.mouseEnter(lyricBlock())
        })
      }
      hoverLyric()
      expect(screen.queryByTitle('Delete line')).toBeNull()

      act(() => rerender({}))
      hoverLyric()
      act(() => {
        screen.getByTitle('Delete line').click()
      })
      expect(removeLyric).toHaveBeenCalledWith('ly1')
    })

    it('imports no Reference media on a double-click of the empty lane', () => {
      const onImportMedia = vi.fn()
      const { rerender } = renderTimeline(() => {}, { ...view, onImportMedia })

      act(() => {
        fireEvent.doubleClick(mediaLane())
      })
      expect(onImportMedia).not.toHaveBeenCalled()

      act(() => rerender({ onImportMedia }))
      act(() => {
        fireEvent.doubleClick(mediaLane())
      })
      expect(onImportMedia).toHaveBeenCalledTimes(1)
    })

    it('offers no way to clear Reference media', () => {
      const onClearMedia = vi.fn()
      const media = { filePath: '/tmp/reference.mp3', offsetMs: 0 }
      const { rerender } = renderTimeline(() => {}, {
        ...view,
        rundownMedia: media,
        onClearMedia,
      })

      // The filename overlay and its Clear button only appear on hover.
      const hoverMedia = (): void => {
        act(() => {
          fireEvent.mouseEnter(mediaLane())
        })
      }
      hoverMedia()
      expect(screen.queryByTitle('Remove media track')).toBeNull()

      act(() => rerender({ rundownMedia: media, onClearMedia }))
      hoverMedia()
      act(() => {
        screen.getByTitle('Remove media track').click()
      })
      expect(onClearMedia).toHaveBeenCalledTimes(1)
    })

    it('opens no context menu on a Shot', () => {
      const onDeleteShot = vi.fn()
      const { rerender } = renderTimeline(() => {}, { ...view, onDeleteShot })

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

    it('disables the Camera buttons, and refuses the split behind them', () => {
      const onSplitShot = vi.fn()
      const { rerender } = renderTimeline(() => {}, { ...view, onSplitShot })

      const camButton = (): HTMLButtonElement =>
        screen.getByTitle<HTMLButtonElement>('Split at playhead and assign CAM1 Wide')
      expect(camButton().disabled).toBe(true)

      // Disabled or not, the handler refuses: the number keys reach the same one.
      act(() => {
        camButton().click()
      })
      press({ key: '1' })
      expect(onSplitShot).not.toHaveBeenCalled()

      act(() => rerender({ onSplitShot }))
      expect(camButton().disabled).toBe(false)
      act(() => {
        camButton().click()
      })
      expect(onSplitShot).toHaveBeenCalledTimes(1)
    })

    it('disables the Part buttons of a Voice-over Rundown', () => {
      const editShot = vi.fn(async () => {})
      useAppStore.setState({
        rundowns: [voiceRundown],
        activeRundownId: 'r1',
        partsInScope: [part],
        editShot,
      })
      const { rerender } = renderTimeline(() => {}, view)

      const partButton = (): HTMLButtonElement => screen.getByTitle<HTMLButtonElement>(/^Assign /)
      expect(partButton().disabled).toBe(true)
      expect(screen.getByTitle<HTMLButtonElement>('Find a part by name').disabled).toBe(true)
      act(() => {
        partButton().click()
      })
      expect(editShot).not.toHaveBeenCalled()

      act(() => rerender({}))
      expect(partButton().disabled).toBe(false)
      act(() => {
        partButton().click()
      })
      expect(editShot).toHaveBeenCalledWith({ id: 's1', partId: 'pt1' })
    })

    it('adds no Marker on M, and offers no Lyric In or Out', () => {
      const onAddMarker = vi.fn()
      const { rerender } = renderTimeline(() => {}, { ...view, onAddMarker })

      press({ code: 'KeyM' })
      expect(onAddMarker).not.toHaveBeenCalled()
      expect(
        screen.getByTitle<HTMLButtonElement>('Lyric In point at the playhead ([)').disabled,
      ).toBe(true)
      expect(
        screen.getByTitle<HTMLButtonElement>('Lyric Out point at the playhead (])').disabled,
      ).toBe(true)

      act(() => rerender({ onAddMarker }))
      press({ code: 'KeyM' })
      expect(onAddMarker).toHaveBeenCalledTimes(1)
    })

    /**
     * Space is claimed twice: `App` starts the Live session with it, the timeline
     * toggles Edit-mode preview playback with it. Gated on `running`, one press in
     * Live mode did both — started the show and set the timeline playing behind
     * it. In the read-only view the timeline does not answer Space at all.
     */
    it('does not toggle preview playback on Space', () => {
      const { rerender } = renderTimeline(() => {}, view)

      expect(playButton().disabled).toBe(true)
      press({ code: 'Space' })
      expect(playButton().textContent).toBe('▶')

      act(() => rerender({}))
      expect(playButton().disabled).toBe(false)
      press({ code: 'Space' })
      expect(playButton().textContent).toBe('⏸')
    })

    it('still scrubs the Playhead', () => {
      renderTimeline(() => {}, view)

      const before = overviewPlayhead().style.left

      // 400px at 80px/s: five seconds along, and nothing stored by either of them.
      drag(playheadGrip(), 0, 400)

      expect(overviewPlayhead().style.left).not.toBe(before)
    })

    it("still honours the operator's own scroll", () => {
      // An overrunning Live Shot freezes the Playhead and stops the auto-scroll, so
      // a scroll then is the operator's and must move the view. It used to be
      // dropped, which left the overview's viewport rect stuck.
      renderTimeline(() => {}, view)

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
})

/**
 * The assignment strip's thickness — the operator's complaint that a two-line
 * strip of Part buttons was "too thick".
 *
 * The strip was a hard 48px and that same 48 was summed into the timeline's total
 * height, so a wrapped second line had nowhere to go. The height is derived from a
 * measurement now (`timeline/assignment-strip.ts`), which is only worth anything
 * if the component measures the box that actually wraps and the total reads the
 * same value the strip does. Neither can be asserted without mounting: jsdom has
 * no layout, so the measurement is stubbed and the observer driven by hand.
 */
describe('the assignment strip grows from one line to two', () => {
  let offsetHeight: PropertyDescriptor | undefined

  afterEach(() => {
    cleanup()
    if (offsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight)
    offsetHeight = undefined
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /**
   * Reports the heights a browser would lay out: `contentPx` for the strip's
   * content box, `buttonPx` for each button in it.
   */
  function stubLayout(contentPx: number, buttonPx: number): void {
    offsetHeight ??= Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement): number {
        return this.tagName === 'BUTTON' ? buttonPx : contentPx
      },
    })
  }

  /** The measured content box: the Camera buttons' immediate parent. */
  function content(): HTMLElement {
    const button = screen.getByTitle('Split at playhead and assign CAM1 Wide')
    const el = button.parentElement
    if (!(el instanceof HTMLElement)) throw new Error('no assignment content box')
    return el
  }

  function strip(): HTMLElement {
    const el = content().parentElement
    if (!(el instanceof HTMLElement)) throw new Error('no assignment strip')
    return el
  }

  /** The timeline's fixed total height, which the strip is one term of. */
  function timelineHeight(): string {
    const el = strip().parentElement
    if (!(el instanceof HTMLElement)) throw new Error('no timeline root')
    return el.style.height
  }

  it('leaves one line at the height it always had', () => {
    stubLayout(29, 29)
    renderTimeline(() => {})

    expect(strip().style.height).toBe('48px')
    // 36 + 20 + 50 + 34 + 30 + 60 + 48 + 24: the sum before any of this.
    expect(timelineHeight()).toBe('302px')
    expect(strip().style.overflowY).toBe('hidden')
  })

  it('grows to fit a second line, and the timeline with it', () => {
    stubLayout(29 * 2 + 6, 29)
    renderTimeline(() => {})

    // Two 29px lines, a 6px gap between them, 6px padding either side, 1px border.
    expect(strip().style.height).toBe('77px')
    expect(timelineHeight()).toBe(`${302 - 48 + 77}px`)
    // Both lines fit, so there is nothing to scroll to.
    expect(strip().style.overflowY).toBe('hidden')
  })

  it('stops at two lines and scrolls the rest', () => {
    stubLayout(29 * 4 + 18, 29)
    renderTimeline(() => {})

    expect(strip().style.height).toBe('77px')
    expect(timelineHeight()).toBe(`${302 - 48 + 77}px`)
    expect(strip().style.overflowY).toBe('auto')
    // A centred overflow puts its first line above the scrollport, out of reach.
    expect(strip().style.alignItems).toBe('flex-start')
  })

  it('keeps the Camera buttons on one line, scrolling sideways', () => {
    stubLayout(29, 29)
    renderTimeline(() => {})

    expect(content().style.flexWrap).toBe('nowrap')
    expect(strip().style.overflowX).toBe('auto')
  })
})

/**
 * The Playhead's own keys, and the two writes that hang off where it is.
 *
 * The keyboard effect is bound once and never re-bound, which is deliberate —
 * re-binding it on every Shot edit is how the lyric keys used to lose a press —
 * but it means every handler it reaches for has to be republished through
 * `keyActionsRef` rather than captured. `movePlayhead` was not, and it closes over
 * `totalMs`: the editor mounts as soon as a Project is selected, with the store's
 * `shots` still empty, so the arrow keys bound a clamp of zero and did nothing for
 * the rest of the session while the ▶ button beside them worked.
 */
describe('stepping the Playhead', () => {
  const storeSnapshot = useAppStore.getState()

  beforeEach(() => {
    window.localStorage.clear()
    vi.stubGlobal('requestAnimationFrame', (): number => 1)
    vi.stubGlobal('cancelAnimationFrame', (): void => {})
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(storeSnapshot, true)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function press(init: KeyboardEventInit): void {
    act(() => {
      fireEvent.keyDown(window, init)
    })
  }

  /** The item Track: the first `#0d0d0d` lane, ahead of the Reference media one. */
  function itemLane(): HTMLElement {
    const lane = document.querySelector('div[style*="rgb(13, 13, 13)"]')
    if (!(lane instanceof HTMLElement)) throw new Error('no item lane')
    return lane
  }

  it('moves on the arrow keys once the Rundown has arrived', () => {
    // Mounted on an empty Rundown, exactly as the editor mounts on a Project
    // before its Shots are loaded.
    const { rerender } = renderTimeline(() => {}, { shots: [] })
    act(() => rerender({}))

    press({ code: 'ArrowRight' })
    expect(readout()).toBe('0:01.0')

    press({ code: 'ArrowRight', shiftKey: true })
    expect(readout()).toBe('0:11.0')

    press({ code: 'ArrowLeft' })
    expect(readout()).toBe('0:10.0')
  })

  it('clamps a step to the end of the Rundown it has now, not the one it mounted with', () => {
    const { rerender } = renderTimeline(() => {}, { shots: [] })
    act(() => rerender({}))

    // Three 30s Shots: ten shifted steps is 100s, well past the 90s end.
    for (let i = 0; i < 10; i++) press({ code: 'ArrowRight', shiftKey: true })

    expect(readout()).toBe('1:30.0')
  })

  it('rounds the split position the Camera buttons write', () => {
    // The Playhead is pixel-derived — one pixel at 80px/s is 12.5ms — and `atMs`
    // lands in an INTEGER column as a duration. Unrounded, a Playhead a fraction
    // of a millisecond past a boundary cleared `splitShot`'s `atMs <= 0` guard and
    // stored a Shot 0.4ms long: 0.03px wide, and unselectable ever after.
    const onSplitShot = vi.fn()
    renderTimeline(() => {}, { onSplitShot })

    act(() => {
      fireEvent.click(itemLane(), { clientX: 1 })
    })
    act(() => {
      screen.getByTitle('Split at playhead and assign CAM1 Wide').click()
    })

    expect(onSplitShot).toHaveBeenCalledWith('s1', 13, 'c1')
  })
})

/**
 * A Lyric draft is a write waiting for Enter, and Enter can arrive long after the
 * view has locked: In and Out are set in Edit mode, the operator switches to Live,
 * and only then types the line. The main process refuses that write now, so the
 * draft has to be abandoned as the view locks — the same rule a Marker label
 * mid-edit follows.
 */
describe('a Lyric draft when the view locks', () => {
  const storeSnapshot = useAppStore.getState()

  beforeEach(() => {
    window.localStorage.clear()
    vi.stubGlobal('requestAnimationFrame', (): number => 1)
    vi.stubGlobal('cancelAnimationFrame', (): void => {})
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(storeSnapshot, true)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /** In, a second along the timeline, Out: the range is fixed and the draft opens. */
  function openDraft(): void {
    act(() => {
      fireEvent.keyDown(window, { key: '[' })
      fireEvent.keyDown(window, { code: 'ArrowRight' })
      fireEvent.keyDown(window, { key: ']' })
    })
  }

  function draftInput(): HTMLElement | null {
    return screen.queryByPlaceholderText('line of lyrics')
  }

  it('is abandoned rather than left open to be typed into', () => {
    // Answers as the store does — the authoring loop feeds the stored line back
    // in as a `saved` event, and a mock returning nothing would end the loop in
    // the wrong state.
    const upsertLyric = vi.fn(
      async (input: LyricUpsertInput): Promise<Lyric> => ({
        id: input.id ?? 'ly-new',
        rundownId: input.rundownId,
        startMs: input.startMs,
        endMs: input.endMs,
        text: input.text,
      }),
    )
    useAppStore.setState({ lyrics: [], activeRundownId: 'r1', upsertLyric })
    const { rerender } = renderTimeline(() => {}, {})

    openDraft()
    expect(draftInput()).not.toBeNull()

    // The operator switches to Live mode before typing the line.
    act(() => rerender({ readOnly: true }))
    expect(draftInput()).toBeNull()

    // Abandoned, not parked: coming back does not restore a half-authored line.
    act(() => rerender({}))
    expect(draftInput()).toBeNull()
    expect(upsertLyric).not.toHaveBeenCalled()

    // The same three keys in Edit mode do open a draft that stores its line, so
    // what is asserted above is a refusal and not a sequence that stopped working.
    openDraft()
    const input = draftInput()
    if (input === null) throw new Error('no draft input in Edit mode')
    act(() => {
      fireEvent.change(input, { target: { value: 'first line' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(upsertLyric).toHaveBeenCalledWith(
      expect.objectContaining({ rundownId: 'r1', text: 'first line' }),
    )
  })
})

/**
 * Dragging the overview's viewport rect.
 *
 * The rect sits inside the strip's "centre the viewport on the pointer" handler,
 * and its `mousedown` stopped only `mousedown`: the `click` the browser
 * synthesises on release still reached the strip, so every drag ended by jumping
 * back to wherever the pointer let go — about half a viewport. Its window
 * listeners were also removed by their own `mouseup` and nothing else, so a
 * release the window never heard left the view following the bare pointer.
 */
describe('the overview viewport rect', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.stubGlobal('requestAnimationFrame', (): number => 1)
    vi.stubGlobal('cancelAnimationFrame', (): void => {})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function rect(): HTMLElement {
    const overview = document.querySelector('div[style*="rgb(17, 17, 17)"]')
    const el = overview?.querySelector('div[style*="2px solid white"]')
    if (!(el instanceof HTMLElement)) throw new Error('no viewport rect')
    return el
  }

  function scroller(): HTMLElement {
    const el = document.querySelector('.timeline-scroll')
    if (!(el instanceof HTMLElement)) throw new Error('no scroller')
    return el
  }

  it('stays where the drag left it when the button comes up', () => {
    renderTimeline(() => {})

    act(() => {
      fireEvent.mouseDown(rect(), { clientX: 100 })
      fireEvent.mouseMove(window, { clientX: 300, buttons: 1 })
    })
    const dragged = scroller().scrollLeft
    expect(dragged).toBeGreaterThan(0)

    act(() => {
      fireEvent.mouseUp(window, { clientX: 300 })
      // What the browser synthesises on release, and what used to re-centre the
      // view on the release point.
      fireEvent.click(rect(), { clientX: 300 })
    })

    expect(scroller().scrollLeft).toBe(dragged)
  })

  it('lets go when the window does', () => {
    // A mouseup that never arrives — the pointer released over another window, a
    // dialog taking focus — used to leave the view following the bare pointer.
    renderTimeline(() => {})

    act(() => {
      fireEvent.mouseDown(rect(), { clientX: 100 })
      fireEvent.mouseMove(window, { clientX: 300, buttons: 1 })
    })
    const dragged = scroller().scrollLeft

    act(() => {
      fireEvent.blur(window)
      fireEvent.mouseMove(window, { clientX: 600, buttons: 1 })
    })

    expect(scroller().scrollLeft).toBe(dragged)
  })

  it('lets go on a move with no button held', () => {
    // The other half of the same loss, and the only evidence there is without
    // pointer capture: the pointer is back and nothing is pressed.
    renderTimeline(() => {})

    act(() => {
      fireEvent.mouseDown(rect(), { clientX: 100 })
      fireEvent.mouseMove(window, { clientX: 300, buttons: 1 })
    })
    const dragged = scroller().scrollLeft

    act(() => {
      fireEvent.mouseMove(window, { clientX: 600, buttons: 0 })
      fireEvent.mouseMove(window, { clientX: 900, buttons: 1 })
    })

    expect(scroller().scrollLeft).toBe(dragged)
  })
})
