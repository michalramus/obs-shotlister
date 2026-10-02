import { describe, it, expect } from 'vitest'
import type { AudioOutput } from '../ipc-contract'
import { defaultAudioOutputs, soundDelaysMs, soundDestinations, worstCaseDelayMs } from './outputs'

function output(over: Partial<AudioOutput> = {}): AudioOutput {
  return { enabled: true, sinkId: null, delayMs: 0, carries: 'both', ...over }
}

function pair(one: Partial<AudioOutput>, two: Partial<AudioOutput>): [AudioOutput, AudioOutput] {
  return [output(one), output(two)]
}

describe('soundDestinations', () => {
  it('plays a Cue on both Outputs when both carry Cues', () => {
    const destinations = soundDestinations(
      pair({ sinkId: 'speakers', carries: 'cues' }, { sinkId: 'cable', carries: 'both' }),
      'cue',
    )

    // Output 1 first: it is the copy that must not be dropped, and the players
    // treat every copy after the first as expendable.
    expect(destinations).toEqual([
      { sinkId: 'speakers', delayMs: 0, primary: true },
      { sinkId: 'cable', delayMs: 0, primary: false },
    ])
  })

  it('leaves out an Output whose selector excludes the sound', () => {
    const outputs = pair(
      { sinkId: 'speakers', carries: 'cues' },
      { sinkId: 'cable', carries: 'voice' },
    )

    expect(soundDestinations(outputs, 'cue')).toEqual([
      { sinkId: 'speakers', delayMs: 0, primary: true },
    ])
    expect(soundDestinations(outputs, 'voice')).toEqual([
      { sinkId: 'cable', delayMs: 0, primary: false },
    ])
  })

  it('leaves out a disabled Output, device and all', () => {
    const outputs = pair({ sinkId: 'speakers' }, { sinkId: 'cable', enabled: false })

    expect(soundDestinations(outputs, 'cue')).toEqual([
      { sinkId: 'speakers', delayMs: 0, primary: true },
    ])
  })

  it('has no destination at all when nothing carries the sound', () => {
    // An operator choosing silence, not a fault: the players simply play nothing.
    const outputs = pair({ carries: 'cues' }, { carries: 'cues' })

    expect(soundDestinations(outputs, 'voice')).toEqual([])
  })

  it('plays one copy when both Outputs name the same device at the same delay', () => {
    // Two elements into one device is a stutter rather than a duplicate.
    const outputs = pair({ sinkId: 'cable', delayMs: 400 }, { sinkId: 'cable', delayMs: 400 })

    expect(soundDestinations(outputs, 'cue')).toEqual([
      { sinkId: 'cable', delayMs: 400, primary: true },
    ])
  })

  it('keeps both copies when one device is wanted at two moments', () => {
    // The same cable early and late is two wanted sounds, not one heard twice.
    const outputs = pair({ sinkId: 'cable', delayMs: 0 }, { sinkId: 'cable', delayMs: 400 })

    expect(soundDestinations(outputs, 'cue')).toEqual([
      { sinkId: 'cable', delayMs: 0, primary: true },
      { sinkId: 'cable', delayMs: 400, primary: false },
    ])
  })

  it('treats the system default as a device like any other when deduplicating', () => {
    const outputs = pair({ sinkId: null }, { sinkId: null })

    expect(soundDestinations(outputs, 'cue')).toHaveLength(1)
  })
})

describe('soundDelaysMs', () => {
  it('lists each delay once, earliest moment first', () => {
    const outputs = pair({ sinkId: 'speakers', delayMs: 0 }, { sinkId: 'cable', delayMs: 400 })

    expect(soundDelaysMs(outputs, 'cue')).toEqual([400, 0])
  })

  it('collapses two Outputs that share a delay into one moment', () => {
    const outputs = pair({ sinkId: 'speakers', delayMs: 400 }, { sinkId: 'cable', delayMs: 400 })

    expect(soundDelaysMs(outputs, 'cue')).toEqual([400])
  })

  it('is empty when the sound has nowhere to go', () => {
    expect(soundDelaysMs(pair({ carries: 'voice' }, { enabled: false }), 'cue')).toEqual([])
  })
})

describe('worstCaseDelayMs', () => {
  it('reports the longest delay, which is what Edit mode has to badge against', () => {
    const outputs = pair({ delayMs: 120 }, { delayMs: 800 })

    expect(worstCaseDelayMs(outputs, 'voice')).toBe(800)
  })

  it('reads as no delay when nothing carries the sound', () => {
    expect(worstCaseDelayMs(pair({ carries: 'cues' }, { enabled: false }), 'voice')).toBe(0)
  })

  it('ignores a delay on an Output that carries something else', () => {
    const outputs = pair({ delayMs: 0, carries: 'voice' }, { delayMs: 900, carries: 'cues' })

    expect(worstCaseDelayMs(outputs, 'voice')).toBe(0)
  })
})

describe('defaultAudioOutputs', () => {
  it('starts audible on the system default, with output 2 off', () => {
    expect(defaultAudioOutputs()).toEqual([
      { enabled: true, sinkId: null, delayMs: 0, carries: 'both' },
      { enabled: false, sinkId: null, delayMs: 0, carries: 'voice' },
    ])
  })
})
