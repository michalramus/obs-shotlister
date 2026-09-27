import { describe, it, expect, beforeEach } from 'vitest'
import { refuseWhileLive, setLiveGuard } from './register'

/**
 * The guard exists because Live mode was enforced by convention: every write
 * path was supposed to check, around forty did, and the handful that did not
 * were invisible until a show. Deleting the running Rundown blanked every
 * phone; switching it pointed the phones at another Rundown's items while OBS
 * silently stopped switching.
 */
describe('refuseWhileLive', () => {
  beforeEach(() => {
    setLiveGuard(() => false)
  })

  it('passes the payload through and returns the result when nothing is live', () => {
    const handler = refuseWhileLive('delete a Rundown', (p: { id: string }) => `deleted ${p.id}`)
    expect(handler({ id: 'rd-1' })).toBe('deleted rd-1')
  })

  it('refuses, and does not run the handler at all, while a session is running', () => {
    let ran = false
    const handler = refuseWhileLive('delete a Rundown', () => {
      ran = true
    })
    setLiveGuard(() => true)

    expect(() => handler(undefined)).toThrow(/Cannot delete a Rundown while a Live session/)
    expect(ran).toBe(false)
  })

  it('names the operation, so the refusal says which control was refused', () => {
    setLiveGuard(() => true)
    const rename = refuseWhileLive('rename a Rundown', () => undefined)
    const convert = refuseWhileLive('convert a Rundown', () => undefined)

    expect(() => rename(undefined)).toThrow(/rename a Rundown/)
    expect(() => convert(undefined)).toThrow(/convert a Rundown/)
  })

  it('reads the session at call time, not at registration time', () => {
    let running = false
    setLiveGuard(() => running)
    // Registered while stopped — the handlers are wired up long before any
    // session exists, so a guard captured at registration would never fire.
    const handler = refuseWhileLive('edit an item', () => 'ok')

    expect(handler(undefined)).toBe('ok')
    running = true
    expect(() => handler(undefined)).toThrow()
    running = false
    expect(handler(undefined)).toBe('ok')
  })

  it('defaults to permitting, so a process that never starts a session is unaffected', () => {
    // Module default, before any setLiveGuard call in a fresh process.
    const handler = refuseWhileLive('edit an item', () => 'ok')
    expect(handler(undefined)).toBe('ok')
  })
})
