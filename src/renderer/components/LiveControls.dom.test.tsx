/**
 * Who gets to see the Preview-first control.
 *
 * Preview-first is an OBS decision — it loads the opening Shot's scene into
 * preview when a Rundown is opened. A Voice-over Rundown never reaches OBS, so
 * offering the choice there is a control that does nothing, which is worse than
 * no control at all on show night.
 */

import React from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { LiveControls } from './LiveControls'
import { useAppStore } from '../store'
import type { Rundown, Shot } from '../../shared/types'

function rundown(kind: Rundown['kind']): Rundown {
  return {
    id: 'rd-1',
    projectId: 'p1',
    name: 'Morning',
    createdAt: 0,
    orderIndex: 0,
    folder: null,
    kind,
  }
}

function shot(): Shot {
  return {
    id: 'shot-0',
    rundownId: 'rd-1',
    cameraId: 'cam-1',
    partId: null,
    durationMs: 5000,
    label: null,
    orderIndex: 0,
    transitionName: null,
    transitionMs: 0,
  }
}

describe('the Preview-first control', () => {
  const storeSnapshot = useAppStore.getState()

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (): number => 1)
    vi.stubGlobal('cancelAnimationFrame', (): void => {})
    // The component reads the stored setting on mount; without the bridge that
    // is an unhandled rejection rather than a test failure.
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      live: {
        getPreviewFirst: () => Promise.resolve(true),
        savePreviewFirst: () => Promise.resolve(undefined),
      },
    }
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(storeSnapshot, true)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function mount(kind: Rundown['kind']): void {
    useAppStore.setState({
      uiMode: 'live',
      running: false,
      activeRundownId: 'rd-1',
      rundowns: [rundown(kind)],
      shots: [shot()],
    })
    render(<LiveControls />)
  }

  it('is offered for a Camera Rundown', () => {
    mount('camera')

    expect(screen.getByLabelText('Preview first')).toBeTruthy()
  })

  it('is not offered for a Voice-over Rundown', () => {
    mount('voice')

    expect(screen.queryByLabelText('Preview first')).toBeNull()
    // The rest of the bar is untouched — only the OBS-specific control goes.
    expect(screen.getByLabelText('Start rundown')).toBeTruthy()
  })
})
