/**
 * Who gets to see the Preview-first control.
 *
 * Preview-first is an OBS decision — it loads the opening Shot's scene into
 * preview when a Rundown is opened. A Voice-over Rundown never reaches OBS, so
 * offering the choice there is a control that does nothing, which is worse than
 * no control at all on show night.
 */

import React from 'react'
import { render, screen, act, cleanup } from '@testing-library/react'
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

/**
 * ⏭ Skip next and the "last shot" hint, against the Live queue rather than the
 * array.
 *
 * A skipped item stays in `shots` and is marked `hidden` by the main process, and
 * Next steps over it. Counting it left ⏭ lit and enabled on the final Shot of a
 * Rundown whose tail had been skipped, with every press a no-op, and kept the hint
 * off the one Shot it exists for.
 */
describe('what is left in the Live queue', () => {
  const storeSnapshot = useAppStore.getState()

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (): number => 1)
    vi.stubGlobal('cancelAnimationFrame', (): void => {})
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

  /** Three Shots, live on the first, with the given ones dropped from the queue. */
  function mountLive(hiddenIds: string[]): void {
    const queue: Shot[] = ['shot-0', 'shot-1', 'shot-2'].map((id, orderIndex) => ({
      ...shot(),
      id,
      orderIndex,
      hidden: hiddenIds.includes(id),
    }))
    useAppStore.setState({
      uiMode: 'live',
      running: true,
      liveIndex: 0,
      startedAt: 1_000,
      activeRundownId: 'rd-1',
      rundowns: [rundown('camera')],
      shots: queue,
    })
    render(<LiveControls />)
  }

  function skipButton(): HTMLButtonElement {
    return screen.getByLabelText<HTMLButtonElement>('Skip next shot')
  }

  it('offers Skip while a visible item is still ahead', () => {
    mountLive([])

    expect(skipButton().disabled).toBe(false)
    expect(screen.queryByText('last shot')).toBeNull()
  })

  it('offers Skip past an already-skipped item', () => {
    // The one after it is still coming, so there is something left to drop.
    mountLive(['shot-1'])

    expect(skipButton().disabled).toBe(false)
  })

  it('stops offering Skip once every item ahead has been skipped', () => {
    mountLive(['shot-1', 'shot-2'])

    expect(skipButton().disabled).toBe(true)
    expect(screen.getByText('last shot')).toBeTruthy()
  })
})

/**
 * The fault message beside the transport.
 *
 * It is meant to be read mid-show, so it may not be cleared by the next press —
 * but nothing cleared it at all except starting a session, so one transient OBS
 * failure left red text beside a transport that went on switching cameras happily
 * for the rest of the night.
 */
describe('the transport fault message', () => {
  const storeSnapshot = useAppStore.getState()

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (): number => 1)
    vi.stubGlobal('cancelAnimationFrame', (): void => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
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

  it('goes away on the next action that works', async () => {
    const liveNext = vi
      .fn<[], Promise<void>>()
      .mockRejectedValueOnce(new Error('OBS is not connected'))
      .mockResolvedValueOnce(undefined)
    useAppStore.setState({
      uiMode: 'live',
      running: true,
      liveIndex: 0,
      startedAt: 1_000,
      activeRundownId: 'rd-1',
      rundowns: [rundown('camera')],
      shots: [shot(), { ...shot(), id: 'shot-1', orderIndex: 1 }],
      liveNext,
    })
    render(<LiveControls />)

    await act(async () => {
      screen.getByLabelText('Next shot').click()
    })
    expect(screen.getByRole('alert').textContent).toBe('OBS is not connected')

    await act(async () => {
      screen.getByLabelText('Next shot').click()
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

/**
 * The frame loop that watches a Transition.
 *
 * `isInTransition` is true for `transitionMs` after the Shot went live and false
 * ever after, so the answer can only change once and only inside that window. The
 * loop asked for a frame for the whole of every Shot regardless — all show, at
 * 60Hz, and for a Rundown cut throughout it could never have been true at all.
 */
describe('the transition watch', () => {
  const storeSnapshot = useAppStore.getState()
  let frames: FrameRequestCallback[] = []

  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      frames.push(cb)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', (): void => {
      frames = []
    })
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

  /** Live on one Shot with the given in-Transition, `wentLiveMsAgo` ago. */
  function mountLive(transitionMs: number, wentLiveMsAgo: number): void {
    useAppStore.setState({
      uiMode: 'live',
      running: true,
      liveIndex: 0,
      startedAt: Date.now() - wentLiveMsAgo,
      activeRundownId: 'rd-1',
      rundowns: [rundown('camera')],
      shots: [{ ...shot(), transitionName: 'fade', transitionMs }],
    })
    render(<LiveControls />)
  }

  /** Runs whatever frames are pending, and returns how many were queued behind. */
  function step(): number {
    const due = frames
    frames = []
    act(() => {
      for (const cb of due) cb(0)
    })
    return frames.length
  }

  it('asks for no frame at all on a Shot taken with a cut', () => {
    mountLive(0, 0)

    expect(frames).toHaveLength(0)
  })

  it('keeps watching while the Transition is still running', () => {
    mountLive(5_000, 0)

    expect(frames).toHaveLength(1)
    expect(step()).toBe(1)
  })

  it('stops watching once the Transition has finished', () => {
    mountLive(500, 2_000)

    expect(frames).toHaveLength(1)
    expect(step()).toBe(0)
  })
})
