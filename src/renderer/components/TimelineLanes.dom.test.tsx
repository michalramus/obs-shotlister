/**
 * Whether the memoised lanes actually stay out of a playback commit.
 *
 * Memoising a lane is only half the job: one unstable prop undoes all of it, and
 * nothing about the code looks wrong when it happens. It did happen — an optional
 * prop defaulted with `= {}` in the destructuring produced a fresh object every
 * render, which invalidated the memo deriving Announcement problems, which
 * produced a new Map, which re-rendered the largest lane on the timeline on every
 * commit. The lane was memoised the whole time.
 *
 * So the assertion is on the precondition rather than on a timing: each lane is
 * replaced by a memoised stand-in that counts its own renders, and playback must
 * not cause any.
 */

import React from 'react'
import { render, screen, act, cleanup } from '@testing-library/react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { Shot, Camera } from '../../shared/types'

const renders = { item: 0, ruler: 0, overview: 0 }

vi.mock('./timeline/ItemLane', () => ({
  ItemLane: React.memo(function ItemLaneStub(): React.JSX.Element {
    renders.item++
    return <div data-testid="item-lane" />
  }),
}))
vi.mock('./timeline/RulerLane', () => ({
  RulerLane: React.memo(function RulerLaneStub(): React.JSX.Element {
    renders.ruler++
    return <div data-testid="ruler-lane" />
  }),
}))
vi.mock('./timeline/OverviewBar', () => ({
  OverviewBar: React.memo(function OverviewBarStub(): React.JSX.Element {
    renders.overview++
    return <div data-testid="overview-bar" />
  }),
}))

// Imported after the mocks so the timeline picks up the stand-ins.
const { TimelineEditor } = await import('./TimelineEditor')

const cameras: Camera[] = [
  {
    id: 'c1',
    projectId: 'p1',
    number: 1,
    name: 'Wide',
    color: '#3498db',
    resolveColor: null,
    obsScene: null,
  },
]

const shots: Shot[] = Array.from({ length: 20 }, (_, i) => ({
  id: `s${i}`,
  rundownId: 'r1',
  cameraId: 'c1',
  partId: null,
  durationMs: 24_000,
  label: null,
  orderIndex: i,
  transitionName: null,
  transitionMs: 0,
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('lane memoisation during playback', () => {
  it('re-renders no lane while the playhead moves', () => {
    let now = 0
    let callbacks: FrameRequestCallback[] = []
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      callbacks.push(cb)
      return callbacks.length
    })
    vi.stubGlobal('cancelAnimationFrame', (): void => {
      callbacks = []
    })

    const noop = (): void => {}
    render(
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
      />,
    )

    act(() => {
      screen.getByTitle('Play/Pause (Space)').click()
    })

    renders.item = 0
    renders.ruler = 0
    renders.overview = 0

    const scroller = (): Element | null => document.querySelector('.timeline-scroll')
    let lastScrollLeft = 0
    for (let i = 0; i < 120; i++) {
      now += 1000 / 60
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

    expect(renders).toEqual({ item: 0, ruler: 0, overview: 0 })
  })
})
