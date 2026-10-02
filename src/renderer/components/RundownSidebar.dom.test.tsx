/**
 * What the sidebar stops offering once a Live session is running.
 *
 * Renaming, deleting, converting and switching the active Rundown are all refused
 * by the main process while a session runs — switching it left the in-memory queue
 * on the old Rundown, deleting it blanked every phone — so the sidebar must not
 * offer any of them in the first place. It offered all four: `startEdit` refused
 * to *open* a rename but said nothing about one already open when the pedal
 * started the show, and the row, the delete button and the convert menu item were
 * live throughout.
 */

import React from 'react'
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react'
import { describe, it, expect, afterEach, vi, type Mock } from 'vitest'
import { RundownSidebar } from './RundownSidebar'
import { useAppStore } from '../store'
import type { Rundown, RundownKind } from '../../shared/types'

function rundown(id: string, name: string): Rundown {
  return { id, projectId: 'p1', name, createdAt: 0, orderIndex: 0, folder: null, kind: 'camera' }
}

const rundowns = [rundown('r1', 'Opening'), rundown('r2', 'Encore')]

const storeSnapshot = useAppStore.getState()

afterEach(() => {
  cleanup()
  useAppStore.setState(storeSnapshot, true)
  vi.restoreAllMocks()
})

interface Spies {
  renameRundown: Mock<[string, string], Promise<void>>
  removeRundown: Mock<[string], Promise<void>>
  setRundownKind: Mock<[string, RundownKind], Promise<void>>
  setActiveRundown: Mock<[string | null], void>
}

/** Mounts the sidebar on two Rundowns, `r1` active, with every write spied on. */
function mount(running: boolean): Spies {
  const spies: Spies = {
    renameRundown: vi.fn<[string, string], Promise<void>>(async () => {}),
    removeRundown: vi.fn<[string], Promise<void>>(async () => {}),
    setRundownKind: vi.fn<[string, RundownKind], Promise<void>>(async () => {}),
    setActiveRundown: vi.fn<[string | null], void>(),
  }
  useAppStore.setState({
    rundowns,
    activeProjectId: 'p1',
    activeRundownId: 'r1',
    running,
    loadShots: async () => {},
    ...spies,
  })
  render(<RundownSidebar />)
  return spies
}

/** A Rundown's row, by the name it shows. */
function row(name: string): HTMLElement {
  const el = screen.getByText(name).closest('li')
  if (!(el instanceof HTMLElement)) throw new Error(`no row for ${name}`)
  return el
}

/** The delete and ⋯ buttons only exist while the row is hovered. */
function hover(name: string): void {
  act(() => {
    fireEvent.mouseEnter(row(name))
  })
}

function startSession(): void {
  act(() => {
    useAppStore.setState({ running: true })
  })
}

describe('renaming a Rundown', () => {
  it('commits the new name in Edit mode', () => {
    const { renameRundown } = mount(false)

    act(() => {
      fireEvent.doubleClick(screen.getByText('Opening'))
    })
    const input = screen.getByLabelText('Rename rundown')
    act(() => {
      fireEvent.change(input, { target: { value: 'Overture' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    expect(renameRundown).toHaveBeenCalledWith('r1', 'Overture')
  })

  it('abandons a rename still open when the session starts', () => {
    // The trigger is the OSC pedal: the show starts from outside this window
    // while the input has focus and a half-typed name in it.
    const { renameRundown } = mount(false)

    act(() => {
      fireEvent.doubleClick(screen.getByText('Opening'))
    })
    act(() => {
      fireEvent.change(screen.getByLabelText('Rename rundown'), { target: { value: 'Overture' } })
    })

    startSession()

    expect(screen.queryByLabelText('Rename rundown')).toBeNull()
    expect(renameRundown).not.toHaveBeenCalled()
    // And the name the Rundown actually has is what is on screen again.
    expect(screen.getByText('Opening')).toBeTruthy()
  })
})

describe('the sidebar while a session is running', () => {
  it('disables Delete rather than letting it throw', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { removeRundown } = mount(false)

    hover('Opening')
    const deleteBtn = screen.getByLabelText<HTMLButtonElement>('Delete Opening')
    expect(deleteBtn.disabled).toBe(false)

    startSession()
    hover('Opening')

    const locked = screen.getByLabelText<HTMLButtonElement>('Delete Opening')
    expect(locked.disabled).toBe(true)
    expect(locked.style.opacity).toBe('0.4')
    act(() => {
      locked.click()
    })
    expect(removeRundown).not.toHaveBeenCalled()
  })

  it('disables the convert menu item rather than letting it throw', () => {
    const { setRundownKind } = mount(true)

    hover('Opening')
    act(() => {
      screen.getByLabelText('Options for Opening').click()
    })

    const convert = screen.getByText<HTMLButtonElement>('Convert to voice-over rundown')
    expect(convert.disabled).toBe(true)
    expect(convert.style.opacity).toBe('0.4')
    act(() => {
      convert.click()
    })
    expect(setRundownKind).not.toHaveBeenCalled()
  })

  it('does not switch the active Rundown when another row is clicked', () => {
    const { setActiveRundown } = mount(false)

    act(() => {
      row('Encore').click()
    })
    expect(setActiveRundown).toHaveBeenCalledWith('r2')

    setActiveRundown.mockClear()
    startSession()
    act(() => {
      row('Encore').click()
    })

    expect(setActiveRundown).not.toHaveBeenCalled()
  })
})
