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

function renderLane(
  onUpdateMarker: (id: string, positionMs: number, label?: string | null) => void,
  dragOverride: Record<string, number>,
): void {
  render(
    <MarkerLane
      markers={[marker]}
      dragOverride={dragOverride}
      zoomPxPerSec={80}
      width={800}
      height={30}
      onMarkerMouseDown={() => {}}
      onUpdateMarker={onUpdateMarker}
      onDeleteMarker={() => {}}
      onTrackDoubleClick={() => {}}
    />,
  )
}

/** Clicks the label, types, and presses Enter. */
function label(text: string): void {
  const span = document.querySelector('span')
  if (span === null) throw new Error('no marker label to click')
  fireEvent.click(span)
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: text } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

afterEach(cleanup)

describe('labelling a Marker', () => {
  it('writes the dragged position, once, through onUpdateMarker', () => {
    // The Marker was dragged to 9s and the new props have not come back yet.
    const onUpdateMarker = vi.fn()
    renderLane(onUpdateMarker, { m1: 9000 })

    label('Refren')

    expect(onUpdateMarker).toHaveBeenCalledTimes(1)
    expect(onUpdateMarker).toHaveBeenCalledWith('m1', 9000, 'Refren')
  })

  it('writes the stored position when no drag is in progress', () => {
    const onUpdateMarker = vi.fn()
    renderLane(onUpdateMarker, {})

    label('Refren')

    expect(onUpdateMarker).toHaveBeenCalledWith('m1', 1000, 'Refren')
  })

  it('writes nothing when the label comes back unchanged', () => {
    const onUpdateMarker = vi.fn()
    renderLane(onUpdateMarker, { m1: 9000 })

    // Empty trims to null, which is what this Marker's label already is.
    label('   ')

    expect(onUpdateMarker).not.toHaveBeenCalled()
  })

  it('abandons the edit on Escape', () => {
    const onUpdateMarker = vi.fn()
    renderLane(onUpdateMarker, { m1: 9000 })

    const span = document.querySelector('span')
    if (span === null) throw new Error('no marker label to click')
    fireEvent.click(span)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Refren' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onUpdateMarker).not.toHaveBeenCalled()
  })
})
