/**
 * The "delete X?" dialog both config panels stack on top of themselves.
 *
 * What is worth pinning is the refusal path: the dialog stays open, says why,
 * and lets the operator try again — a refusal that closed the dialog would read
 * as a deletion that worked.
 */

import React from 'react'
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { ConfirmDestructive } from './ConfirmDestructive'

function confirm(): HTMLElement {
  return screen.getByText('Delete camera')
}

describe('ConfirmDestructive', () => {
  afterEach(cleanup)

  it('names the thing and what is about to go', () => {
    render(
      <ConfirmDestructive
        noun="camera"
        subject="#1 Wide"
        onCancel={() => {}}
        onConfirm={() => Promise.resolve()}
      />,
    )

    expect(screen.getByText('Delete camera?')).toBeTruthy()
    expect(screen.getByText('#1 Wide')).toBeTruthy()
  })

  it('asks the caller to delete, once', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(
      <ConfirmDestructive
        noun="part"
        subject="#2 refren"
        onCancel={() => {}}
        onConfirm={onConfirm}
      />,
    )

    await act(async () => {
      fireEvent.click(screen.getByText('Delete part'))
    })

    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('stays open on a refusal and repeats what it said', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('3 calls still use it.'))
    render(
      <ConfirmDestructive
        noun="camera"
        subject="#1 Wide"
        onCancel={() => {}}
        onConfirm={onConfirm}
      />,
    )

    await act(async () => {
      fireEvent.click(confirm())
    })

    expect(screen.getByText('3 calls still use it.')).toBeTruthy()
    expect(confirm().hasAttribute('disabled')).toBe(false)
  })

  it('lets the caller explain a refusal the operator cannot read', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('FOREIGN KEY constraint failed'))
    render(
      <ConfirmDestructive
        noun="camera"
        subject="#1 Wide"
        onCancel={() => {}}
        onConfirm={onConfirm}
        describeError={() => 'Shots still use this camera.'}
      />,
    )

    await act(async () => {
      fireEvent.click(confirm())
    })

    expect(screen.getByText('Shots still use this camera.')).toBeTruthy()
    expect(screen.queryByText('FOREIGN KEY constraint failed')).toBeNull()
  })
})
