import { describe, it, expect } from 'vitest'
import { parsePortInput, OSC_PORT_MIN, OSC_PORT_MAX } from './OSCSettingsPanel'

describe('parsePortInput', () => {
  it('reads a port the OS will bind', () => {
    expect(parsePortInput('8000')).toEqual({ ok: true, port: 8000 })
    expect(parsePortInput(' 9000 ')).toEqual({ ok: true, port: 9000 })
  })

  it('takes the ends of the range', () => {
    expect(parsePortInput(String(OSC_PORT_MIN))).toEqual({ ok: true, port: OSC_PORT_MIN })
    expect(parsePortInput(String(OSC_PORT_MAX))).toEqual({ ok: true, port: OSC_PORT_MAX })
  })

  // Saved as-is, this one threw ERR_SOCKET_BAD_PORT in the main process, which
  // logged it and carried on — and the panel still said it was listening.
  it('refuses a port no socket can bind', () => {
    expect(parsePortInput('99999').ok).toBe(false)
    expect(parsePortInput('80').ok).toBe(false)
  })

  // `parseInt('')` is NaN, and NaN went to the database as the string "NaN".
  it('refuses an empty field rather than storing NaN', () => {
    expect(parsePortInput('')).toEqual({ ok: false, error: 'Enter a port number.' })
    expect(parsePortInput('   ').ok).toBe(false)
  })

  it('refuses what is not a whole port', () => {
    expect(parsePortInput('80.5').ok).toBe(false)
    expect(parsePortInput('eight thousand').ok).toBe(false)
  })
})
