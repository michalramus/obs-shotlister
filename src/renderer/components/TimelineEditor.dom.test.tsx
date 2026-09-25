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
import { render, screen, act, cleanup } from '@testing-library/react'
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

function renderTimeline(onCommit: () => void): void {
  const noop = (): void => {}
  render(
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
      />
    </Profiler>,
  )
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
