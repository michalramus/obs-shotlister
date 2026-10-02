/**
 * A Shot label left mid-edit when the show starts.
 *
 * The row's editing id lives in `App`, which a mode switch does not clear, and
 * React fires no blur when an input unmounts — so an edit opened in Edit mode
 * survived Start, and clicking EDIT MODE mid-show remounted it auto-focused. The
 * next Enter wrote to the database from a locked view, which the main process now
 * refuses outright. The rule is the one the Marker label already follows: an edit
 * still open when the view locks is abandoned, not saved.
 */

import React from 'react'
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react'
import { describe, it, expect, afterEach, vi, type Mock } from 'vitest'
import { ShotListPanel } from './ShotListPanel'
import { useAppStore } from '../store'
import type { Camera, Shot } from '../../shared/types'
import type { UpdateShotInput } from '../../shared/ipc-contract'

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

const shots: Shot[] = [
  {
    id: 's1',
    rundownId: 'r1',
    cameraId: 'c1',
    partId: null,
    durationMs: 30_000,
    label: null,
    orderIndex: 0,
    transitionName: null,
    transitionMs: 0,
  },
]

// jsdom has no layout and therefore no `scrollIntoView`; the panel brings the
// live row and the selected row into view on mount.
Element.prototype.scrollIntoView = function scrollIntoView(): void {}

const storeSnapshot = useAppStore.getState()

afterEach(() => {
  cleanup()
  useAppStore.setState(storeSnapshot, true)
  vi.restoreAllMocks()
})

/** Mounts the panel with `s1`'s label being edited, and one live state to start in. */
function mountEditing(running: boolean): { editShot: Mock<[UpdateShotInput], Promise<void>> } {
  const editShot = vi.fn<[UpdateShotInput], Promise<void>>(async () => {})
  useAppStore.setState({
    shots,
    cameras,
    activeRundownId: 'r1',
    liveIndex: running ? 0 : null,
    running,
    editShot,
  })
  render(<ShotListPanel selectedShotId="s1" labelEditingId="s1" onLabelEditDone={() => {}} />)
  return { editShot }
}

function labelInput(): HTMLElement | null {
  return screen.queryByLabelText('Edit label')
}

describe('the Shot label editor', () => {
  it('writes the typed label on Enter in Edit mode', () => {
    const { editShot } = mountEditing(false)

    const input = labelInput()
    if (input === null) throw new Error('no label editor in Edit mode')
    act(() => {
      fireEvent.change(input, { target: { value: 'Opening' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    expect(editShot).toHaveBeenCalledWith({ id: 's1', label: 'Opening' })
  })

  it('is gone the moment the session starts, and writes nothing', () => {
    const { editShot } = mountEditing(false)

    const input = labelInput()
    if (input === null) throw new Error('no label editor in Edit mode')
    act(() => {
      fireEvent.change(input, { target: { value: 'Opening' } })
    })

    // The show starts — from the pedal, the phone, or the operator — while the
    // input still has focus and the typed label has not been committed.
    act(() => {
      useAppStore.setState({ running: true, liveIndex: 0 })
    })

    expect(labelInput()).toBeNull()
    expect(editShot).not.toHaveBeenCalled()
  })

  it('does not reopen when the operator flips back to the Edit layout mid-show', () => {
    // `labelEditingId` lives in `App` and no mode switch clears it, so the row
    // must not act on it while the show is running: the panel used to remount the
    // input auto-focused, one keystroke away from a refused write.
    mountEditing(true)

    expect(labelInput()).toBeNull()
  })
})
