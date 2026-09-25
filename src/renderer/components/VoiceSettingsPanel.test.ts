import { describe, it, expect } from 'vitest'
import {
  COUNTDOWN_MAX,
  COUNTDOWN_MIN,
  deviceLabel,
  deviceOptions,
  effectiveSetting,
  formatCountdown,
  parseCountdownInput,
  summarizeRenderStates,
  parseDelayInput,
  renderingHeadline,
} from './VoiceSettingsPanel'
import { TRANSMISSION_DELAY_MAX_MS, TRANSMISSION_DELAY_MIN_MS } from '../../shared/announcement'
import type { PartRenderState, RenderState } from '../../shared/ipc-contract'

function part(name: string, state: RenderState): PartRenderState {
  return { partId: `id-${name}`, name, state }
}

describe('parseCountdownInput', () => {
  it('reads a plain comma-separated list', () => {
    const parsed = parseCountdownInput('10,5,3,2,1')
    expect(parsed).toEqual({ ok: true, countdown: [10, 5, 3, 2, 1] })
  })

  it('tolerates whitespace around every entry', () => {
    const parsed = parseCountdownInput('  10 ,  5 , 1  ')
    expect(parsed).toEqual({ ok: true, countdown: [10, 5, 1] })
  })

  it('normalises to largest-first, the order it is spoken in', () => {
    const parsed = parseCountdownInput('1,3,10')
    expect(parsed).toEqual({ ok: true, countdown: [10, 3, 1] })
  })

  it('accepts the ends of the rendered range', () => {
    expect(parseCountdownInput(`${COUNTDOWN_MIN}, ${COUNTDOWN_MAX}`)).toEqual({
      ok: true,
      countdown: [COUNTDOWN_MAX, COUNTDOWN_MIN],
    })
  })

  it('rejects a number above the rendered range rather than dropping it', () => {
    // Nothing is rendered past 60, so a silently kept 61 would simply be silent.
    const parsed = parseCountdownInput('61, 5')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('61')
  })

  it('rejects zero and negatives', () => {
    expect(parseCountdownInput('10, 0').ok).toBe(false)
    expect(parseCountdownInput('-5').ok).toBe(false)
  })

  it('rejects a fractional number', () => {
    const parsed = parseCountdownInput('10, 2.5')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('2.5')
  })

  it('rejects a non-numeric entry, naming it', () => {
    const parsed = parseCountdownInput('10, five')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('five')
  })

  it('rejects an empty string', () => {
    const parsed = parseCountdownInput('   ')
    expect(parsed.ok).toBe(false)
  })

  it('rejects a stray comma rather than reading past it', () => {
    expect(parseCountdownInput('10,,5').ok).toBe(false)
    expect(parseCountdownInput('10,5,').ok).toBe(false)
  })

  it('rejects a duplicate, which would ask for one second twice', () => {
    const parsed = parseCountdownInput('10, 5, 5, 1')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('5')
  })
})

describe('formatCountdown', () => {
  it('round-trips through the parser', () => {
    const parsed = parseCountdownInput('1, 2, 3')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(formatCountdown(parsed.countdown)).toBe('3, 2, 1')
  })
})

describe('effectiveSetting', () => {
  it('follows the global value when nothing overrides it', () => {
    expect(effectiveSetting('flush', null)).toEqual({ value: 'flush', source: 'global' })
  })

  it('prefers the override', () => {
    expect(effectiveSetting('flush', 'immediate')).toEqual({
      value: 'immediate',
      source: 'project',
    })
  })

  it('treats an override equal to the global value as an override still', () => {
    // The distinction is load-bearing: an explicit override keeps its value
    // when the global one later changes.
    expect(effectiveSetting('flush', 'flush').source).toBe('project')
  })

  it('carries arrays and other non-scalars', () => {
    expect(effectiveSetting([10, 5, 1], null).value).toEqual([10, 5, 1])
    expect(effectiveSetting([10, 5, 1], [3, 1]).value).toEqual([3, 1])
  })
})

describe('summarizeRenderStates', () => {
  it('reports an empty project', () => {
    const summary = summarizeRenderStates([])
    expect(summary).toMatchObject({ total: 0, unrendered: 0 })
    expect(summary.headline).toBe('No parts in this project yet.')
  })

  it('reports everything rendered', () => {
    const summary = summarizeRenderStates([part('gitara', 'rendered'), part('refren', 'rendered')])
    expect(summary).toMatchObject({ total: 2, rendered: 2, stale: 0, missing: 0, unrendered: 0 })
    expect(summary.headline).toBe('All 2 parts are rendered.')
  })

  it('says "part is" for a single rendered part', () => {
    expect(summarizeRenderStates([part('gitara', 'rendered')]).headline).toBe(
      'All 1 part is rendered.',
    )
  })

  it('counts stale and missing apart, because they mean different things', () => {
    const summary = summarizeRenderStates([
      part('gitara', 'rendered'),
      part('wokal 1', 'stale'),
      part('wokal 2', 'missing'),
      part('refren', 'missing'),
    ])
    expect(summary).toMatchObject({ total: 4, rendered: 1, stale: 1, missing: 2, unrendered: 3 })
    expect(summary.headline).toBe('1 of 4 rendered - 1 stale, 2 never rendered.')
  })

  it('counts stale towards unrendered', () => {
    expect(summarizeRenderStates([part('gitara', 'stale')]).unrendered).toBe(1)
  })
})

describe('deviceLabel', () => {
  it('uses the reported label when there is one', () => {
    expect(deviceLabel({ deviceId: 'abc', label: 'CABLE Input (VB-Audio)' })).toBe(
      'CABLE Input (VB-Audio)',
    )
  })

  it('falls back to the id when permission hides the label', () => {
    // Blank rows would be unpickable; the id at least distinguishes them.
    expect(deviceLabel({ deviceId: '0123456789abcdef', label: '' })).toBe(
      'Unnamed output (01234567)',
    )
  })

  it('names the well-known ids rather than showing them raw', () => {
    expect(deviceLabel({ deviceId: 'default', label: '' })).toBe('System default output')
    expect(deviceLabel({ deviceId: 'communications', label: '  ' })).toBe('Communications output')
  })
})

describe('deviceOptions', () => {
  it('always offers the system default first, as the empty value', () => {
    const options = deviceOptions([{ deviceId: 'a', label: 'Speakers' }], null)
    expect(options[0]).toEqual({ deviceId: '', label: 'System default' })
    expect(options[1]).toEqual({ deviceId: 'a', label: 'Speakers' })
  })

  it('keeps a saved device that is not plugged in visible', () => {
    const options = deviceOptions([{ deviceId: 'a', label: 'Speakers' }], 'unplugged-cable')
    expect(options.map((o) => o.deviceId)).toEqual(['', 'a', 'unplugged-cable'])
    expect(options[2].label).toContain('Not connected')
  })

  it('does not duplicate a selected device that is present', () => {
    const options = deviceOptions([{ deviceId: 'a', label: 'Speakers' }], 'a')
    expect(options.map((o) => o.deviceId)).toEqual(['', 'a'])
  })
})

describe('parseDelayInput', () => {
  it('reads a plain number of milliseconds', () => {
    expect(parseDelayInput('350')).toEqual({ ok: true, delayMs: 350 })
  })

  it('treats an empty field as no delay', () => {
    expect(parseDelayInput('')).toEqual({ ok: true, delayMs: 0 })
    expect(parseDelayInput('   ')).toEqual({ ok: true, delayMs: 0 })
  })

  it('accepts a negative delay, for a path that runs ahead', () => {
    expect(parseDelayInput('-120')).toEqual({ ok: true, delayMs: -120 })
  })

  it('rounds a fractional millisecond rather than rejecting it', () => {
    expect(parseDelayInput('350.4')).toEqual({ ok: true, delayMs: 350 })
  })

  it('rejects anything that is not a number', () => {
    const result = parseDelayInput('soon')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('not a number')
  })

  it('rejects a delay long enough to mute every Announcement', () => {
    expect(parseDelayInput(String(TRANSMISSION_DELAY_MAX_MS + 1)).ok).toBe(false)
    expect(parseDelayInput(String(TRANSMISSION_DELAY_MIN_MS - 1)).ok).toBe(false)
  })

  it('accepts the bounds themselves', () => {
    expect(parseDelayInput(String(TRANSMISSION_DELAY_MAX_MS)).ok).toBe(true)
    expect(parseDelayInput(String(TRANSMISSION_DELAY_MIN_MS)).ok).toBe(true)
  })
})

describe('renderingHeadline', () => {
  it('counts the clips so a slow batch does not read as a hang', () => {
    expect(renderingHeadline({ completed: 7, total: 62 })).toBe('Rendering 7/62...')
  })

  it('falls back to the bare word before the first progress arrives', () => {
    expect(renderingHeadline(undefined)).toBe('Rendering...')
  })

  it('does not offer "0/0" for a batch with nothing in it', () => {
    expect(renderingHeadline({ completed: 0, total: 0 })).toBe('Rendering...')
  })
})
