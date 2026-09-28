/**
 * The one writer every editable row in the Cameras and Parts panels goes
 * through.
 *
 * It exists because four rows had four copies of the same draft-and-commit
 * code, and one of the copies was wrong in a way nothing could see: a colour
 * picked from the palette was only ever set, never written, because a swatch is
 * a button and blurs nothing. `pick` is that fix, so it is pinned here rather
 * than in each panel.
 */

import React from 'react'
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { useDraftRow } from './use-draft-row'

interface Row {
  name: string
  color: string
}

interface HarnessProps {
  committed: Row
  save: (draft: Row) => Promise<unknown>
  fallbackError?: string
}

/** A row with one typed field and one clicked one, which is the shape at issue. */
function Harness({ committed, save, fallbackError }: HarnessProps): React.JSX.Element {
  const row = useDraftRow<Row>(committed, save, fallbackError)
  return (
    <div>
      <input
        aria-label="name"
        value={row.draft.name}
        onChange={(e) => row.set({ name: e.target.value })}
        onBlur={row.commit}
      />
      <button onClick={() => row.pick({ color: '#00ff00' })}>green</button>
      <button onClick={row.submit}>save</button>
      <span data-testid="state">{row.saving ? 'saving' : 'idle'}</span>
      {row.error !== null && <span data-testid="error">{row.error}</span>}
    </div>
  )
}

const committed: Row = { name: 'CAM1', color: '#ff0000' }

function type(value: string): void {
  act(() => {
    fireEvent.change(screen.getByLabelText('name'), { target: { value } })
  })
}

function blur(): void {
  act(() => {
    fireEvent.blur(screen.getByLabelText('name'))
  })
}

describe('useDraftRow', () => {
  afterEach(cleanup)

  it('writes nothing while a field is being typed into', () => {
    const save = vi.fn().mockResolvedValue(undefined)
    render(<Harness committed={committed} save={save} />)

    type('CAM2')

    expect(save).not.toHaveBeenCalled()
  })

  it('writes the draft when the field is left', () => {
    const save = vi.fn().mockResolvedValue(undefined)
    render(<Harness committed={committed} save={save} />)

    type('CAM2')
    blur()

    expect(save).toHaveBeenCalledWith({ name: 'CAM2', color: '#ff0000' })
  })

  it('writes nothing when a blur changed nothing', () => {
    const save = vi.fn().mockResolvedValue(undefined)
    render(<Harness committed={committed} save={save} />)

    blur()

    expect(save).not.toHaveBeenCalled()
  })

  // The regression: clicking a palette swatch blurs no field, so `onBlur` alone
  // saved nothing and the colour was gone the next time the panel opened.
  it('writes a picked value straight away, with nothing to blur', () => {
    const save = vi.fn().mockResolvedValue(undefined)
    render(<Harness committed={committed} save={save} />)

    act(() => {
      fireEvent.click(screen.getByText('green'))
    })

    expect(save).toHaveBeenCalledWith({ name: 'CAM1', color: '#00ff00' })
  })

  it('picks from the draft in hand, not the one state still holds', () => {
    const save = vi.fn().mockResolvedValue(undefined)
    render(<Harness committed={committed} save={save} />)

    type('CAM2')
    act(() => {
      fireEvent.click(screen.getByText('green'))
    })

    expect(save).toHaveBeenCalledWith({ name: 'CAM2', color: '#00ff00' })
  })

  it('submits whether or not anything changed', () => {
    const save = vi.fn().mockResolvedValue(undefined)
    render(<Harness committed={committed} save={save} />)

    act(() => {
      fireEvent.click(screen.getByText('save'))
    })

    expect(save).toHaveBeenCalledWith(committed)
  })

  it('shows what the refusal said and stops saving', async () => {
    const save = vi.fn().mockRejectedValue(new Error('Name is required.'))
    render(<Harness committed={committed} save={save} />)

    await act(async () => {
      fireEvent.click(screen.getByText('save'))
    })

    expect(screen.getByTestId('error').textContent).toBe('Name is required.')
    expect(screen.getByTestId('state').textContent).toBe('idle')
  })

  it('falls back to the caller’s wording when the refusal carries none', async () => {
    const save = vi.fn().mockRejectedValue('nope')
    render(<Harness committed={committed} save={save} fallbackError="Failed to add camera." />)

    await act(async () => {
      fireEvent.click(screen.getByText('save'))
    })

    expect(screen.getByTestId('error').textContent).toBe('Failed to add camera.')
  })
})
