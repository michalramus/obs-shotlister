/**
 * Labelling a Marker writes once, through the one seam, at the dragged position.
 *
 * This is the shape of a fixed defect: the label used to be written twice, and the
 * second write went straight to `window.api` carrying the Marker's pre-drag
 * position, so naming a Marker just after moving it could put it back where it
 * came from. Nothing pinned that fix, because the editing state lived in a
 * two-thousand-line component and a test could not get at it. It lives in this
 * lane now, so it can be.
 */

import React from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { MarkerLane } from './MarkerLane'
import type { Marker } from '../../../shared/types'

const marker: Marker = { id: 'm1', rundownId: 'r1', positionMs: 1000, label: null }

interface LaneOptions {
  onUpdateMarker?: (id: string, positionMs: number, label?: string | null) => void
  onDeleteMarker?: (id: string) => void
  dragOverride?: Record<string, number>
  running?: boolean
}

/** Renders the lane, and can re-render it with one option changed. */
function renderLane(options: LaneOptions = {}): { setRunning: (running: boolean) => void } {
  const tree = (running: boolean): React.JSX.Element => (
    <MarkerLane
      markers={[marker]}
      dragOverride={options.dragOverride ?? {}}
      zoomPxPerSec={80}
      width={800}
      height={30}
      running={running}
      onMarkerMouseDown={() => {}}
      onUpdateMarker={options.onUpdateMarker ?? ((): void => {})}
      onDeleteMarker={options.onDeleteMarker ?? ((): void => {})}
      onTrackDoubleClick={() => {}}
    />
  )
  const result = render(tree(options.running ?? false))
  return { setRunning: (running) => result.rerender(tree(running)) }
}

/** The label, which is the lane's only span until a Marker is being edited. */
function labelSpan(): HTMLSpanElement {
  const span = document.querySelector('span')
  if (span === null) throw new Error('no marker label to click')
  return span
}

/** Clicks the label, types, and presses Enter. */
function label(text: string): void {
  fireEvent.click(labelSpan())
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: text } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

afterEach(cleanup)

describe('labelling a Marker', () => {
  it('writes the dragged position, once, through onUpdateMarker', () => {
    // The Marker was dragged to 9s and the new props have not come back yet.
    const onUpdateMarker = vi.fn()
    renderLane({ onUpdateMarker, dragOverride: { m1: 9000 } })

    label('Refren')

    expect(onUpdateMarker).toHaveBeenCalledTimes(1)
    expect(onUpdateMarker).toHaveBeenCalledWith('m1', 9000, 'Refren')
  })

  it('writes the stored position when no drag is in progress', () => {
    const onUpdateMarker = vi.fn()
    renderLane({ onUpdateMarker })

    label('Refren')

    expect(onUpdateMarker).toHaveBeenCalledWith('m1', 1000, 'Refren')
  })

  it('writes nothing when the label comes back unchanged', () => {
    const onUpdateMarker = vi.fn()
    renderLane({ onUpdateMarker, dragOverride: { m1: 9000 } })

    // Empty trims to null, which is what this Marker's label already is.
    label('   ')

    expect(onUpdateMarker).not.toHaveBeenCalled()
  })

  it('abandons the edit on Escape', () => {
    const onUpdateMarker = vi.fn()
    renderLane({ onUpdateMarker, dragOverride: { m1: 9000 } })

    fireEvent.click(labelSpan())
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Refren' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onUpdateMarker).not.toHaveBeenCalled()
  })
})

/**
 * A Marker is a Rundown's, not a Live session's, so during a show the Marker
 * Track is a read-out and nothing else. Both halves are asserted: the affordance
 * is gone, and the write refuses anyway — an operator mid-edit when the show
 * starts must not have their keystroke land in the database.
 */
describe('the Marker Track during a Live session', () => {
  it('offers no label edit while a Live session is running', () => {
    const onUpdateMarker = vi.fn()
    renderLane({ onUpdateMarker, running: true })

    fireEvent.click(labelSpan())

    expect(screen.queryByRole('textbox')).toBeNull()
    expect(onUpdateMarker).not.toHaveBeenCalled()
  })

  it('offers no delete while a Live session is running', () => {
    const onDeleteMarker = vi.fn()
    const lane = renderLane({ onDeleteMarker })

    // The delete button only exists while the Marker is hovered, so hover first
    // and check it is there: otherwise this asserts nothing about `running`.
    const line = labelSpan().parentElement
    if (line === null) throw new Error('no marker to hover')
    fireEvent.mouseEnter(line)
    expect(screen.queryByTitle('Delete marker')).not.toBeNull()

    lane.setRunning(true)

    expect(screen.queryByTitle('Delete marker')).toBeNull()
    expect(onDeleteMarker).not.toHaveBeenCalled()
  })

  it('refuses a label already being edited when the Live session starts', () => {
    const onUpdateMarker = vi.fn()
    const lane = renderLane({ onUpdateMarker })

    fireEvent.click(labelSpan())
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Refren' } })

    // The operator presses Start with the input still open.
    lane.setRunning(true)
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onUpdateMarker).not.toHaveBeenCalled()
  })
})
