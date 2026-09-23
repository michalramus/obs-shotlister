import { describe, it, expect } from 'vitest'
import { audioIndicator, audioLabel, connectionsLabel, unrenderedLabel } from './TopBar'

describe('audioIndicator', () => {
  it('is on when nothing is muted', () => {
    expect(audioIndicator({ muteCount: false, muteBeep: false, volume: 1 })).toBe('on')
  })

  it('is partial when only the countdown is muted', () => {
    expect(audioIndicator({ muteCount: true, muteBeep: false, volume: 1 })).toBe('partial')
  })

  it('is partial when only the beep is muted', () => {
    expect(audioIndicator({ muteCount: false, muteBeep: true, volume: 1 })).toBe('partial')
  })

  it('is muted when both are muted', () => {
    expect(audioIndicator({ muteCount: true, muteBeep: true, volume: 1 })).toBe('muted')
  })

  it('is muted at zero volume regardless of the toggles', () => {
    // Collapsing the three controls must not hide that nothing is audible.
    expect(audioIndicator({ muteCount: false, muteBeep: false, volume: 0 })).toBe('muted')
  })
})

describe('audioLabel', () => {
  it('names both cues when nothing is muted', () => {
    expect(audioLabel({ muteCount: false, muteBeep: false, volume: 1 })).toBe(
      'Audio: countdown on, beep on, volume 100%',
    )
  })

  it('names what is muted', () => {
    expect(audioLabel({ muteCount: true, muteBeep: false, volume: 0.5 })).toBe(
      'Audio: countdown muted, beep on, volume 50%',
    )
  })

  it('calls out zero volume', () => {
    expect(audioLabel({ muteCount: false, muteBeep: true, volume: 0 })).toBe(
      'Audio: countdown on, beep muted, volume 0%',
    )
  })
})

describe('connectionsLabel', () => {
  it('reports both connections', () => {
    expect(connectionsLabel({ obsStatus: 'connected', oscEnabled: true, oscPort: 8000 })).toBe(
      'OBS connected · OSC enabled on 8000',
    )
  })

  it('says enabled rather than listening, because only the saved setting is known', () => {
    expect(
      connectionsLabel({ obsStatus: 'connected', oscEnabled: true, oscPort: 9000 }),
    ).not.toContain('listening')
  })

  it('reports a disabled OSC server without a port', () => {
    expect(connectionsLabel({ obsStatus: 'disconnected', oscEnabled: false, oscPort: 8000 })).toBe(
      'OBS disconnected · OSC off',
    )
  })

  it('reports OBS mid-connect', () => {
    expect(connectionsLabel({ obsStatus: 'connecting', oscEnabled: false, oscPort: 8000 })).toBe(
      'OBS connecting · OSC off',
    )
  })
})

describe('unrenderedLabel', () => {
  it('says nothing when everything is rendered', () => {
    expect(unrenderedLabel(0)).toBeNull()
  })

  it('counts a single part in the singular', () => {
    expect(unrenderedLabel(1)).toBe('1 part has no up-to-date audio')
  })

  it('counts several parts', () => {
    expect(unrenderedLabel(4)).toBe('4 parts have no up-to-date audio')
  })

  it('says nothing for a count below zero, which can only be a bad status', () => {
    // A strip that appears for no reason is worse than one that stays hidden.
    expect(unrenderedLabel(-1)).toBeNull()
  })
})
