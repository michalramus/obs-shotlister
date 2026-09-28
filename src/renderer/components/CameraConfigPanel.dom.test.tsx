/**
 * The Cameras panel, mounted, because two of its defects were only visible once
 * it was: a palette pick that reached no writer at all, and a delete refusal
 * shown to the operator as SQLite wrote it.
 */

import React from 'react'
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Mock } from 'vitest'
import { CameraConfigPanel, describeCameraDeleteError } from './CameraConfigPanel'
import { useAppStore } from '../store'
import type { Camera } from '../../shared/types'
import { CAMERA_PALETTE } from '../../shared/camera-palette'

const camera: Camera = {
  id: 'c1',
  projectId: 'p1',
  number: 1,
  name: 'Wide',
  color: '#e74c3c',
  resolveColor: null,
  obsScene: 'Scene A',
}

const storeSnapshot = useAppStore.getState()

/** A palette colour the camera is not already on, so a pick is a change. */
const otherColor = CAMERA_PALETTE.find((c) => c.toLowerCase() !== camera.color) as string

describe('CameraConfigPanel', () => {
  let upsertCamera: Mock
  let removeCamera: Mock

  beforeEach(() => {
    upsertCamera = vi.fn().mockResolvedValue(camera)
    removeCamera = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({
      activeProjectId: 'p1',
      cameras: [camera],
      upsertCamera,
      removeCamera,
    })
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(storeSnapshot, true)
    vi.restoreAllMocks()
  })

  // The defect: a swatch is a button, so clicking one blurred nothing, and the
  // only writer was the fields' `onBlur`. The colour was gone on reopening.
  it('saves a colour picked from the palette', async () => {
    render(<CameraConfigPanel onClose={() => {}} />)

    await act(async () => {
      fireEvent.click(screen.getByLabelText(otherColor))
    })

    expect(upsertCamera).toHaveBeenCalledTimes(1)
    expect(upsertCamera.mock.calls[0][0]).toMatchObject({ id: 'c1', color: otherColor })
  })

  // The other half of that write: the main process rewrites every column, so a
  // row that forgets the scene writes NULL over whatever the OBS panel set.
  it('carries the OBS scene through an edit that never touches it', async () => {
    render(<CameraConfigPanel onClose={() => {}} />)

    const name = screen.getByLabelText('Camera name')
    await act(async () => {
      fireEvent.change(name, { target: { value: 'Wide left' } })
      fireEvent.blur(name)
    })

    expect(upsertCamera.mock.calls[0][0]).toMatchObject({
      name: 'Wide left',
      obsScene: 'Scene A',
    })
  })

  it('leaves the database alone when a field is left unchanged', async () => {
    render(<CameraConfigPanel onClose={() => {}} />)

    await act(async () => {
      fireEvent.blur(screen.getByLabelText('Camera name'))
    })

    expect(upsertCamera).not.toHaveBeenCalled()
  })

  it('explains a delete the foreign key refused', async () => {
    removeCamera.mockRejectedValue(new Error('SqliteError: FOREIGN KEY constraint failed'))
    render(<CameraConfigPanel onClose={() => {}} />)

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Delete camera Wide'))
    })
    await act(async () => {
      fireEvent.click(screen.getByText('Delete camera'))
    })

    expect(screen.queryByText(/FOREIGN KEY/)).toBeNull()
    expect(screen.getByText(/Shots still use this camera/)).toBeTruthy()
  })
})

describe('describeCameraDeleteError', () => {
  it('names Shots as the reason a delete was refused', () => {
    const message = describeCameraDeleteError(new Error('FOREIGN KEY constraint failed'))
    expect(message).toMatch(/Shots still use this camera/)
  })

  it('passes anything else through as it was said', () => {
    expect(describeCameraDeleteError(new Error('Camera not found: c9'))).toBe(
      'Camera not found: c9',
    )
  })
})
