import { describe, it, expect } from 'vitest'
import { cuesDueAt } from './cue-schedule'

/** One Output on the operator's own speakers: nothing is played early. */
const LOCAL = [0]

describe('cuesDueAt', () => {
  it('speaks the word for a second as that second ticks away', () => {
    expect(cuesDueAt({ previousRemainingMs: 3040, remainingMs: 2990, delaysMs: LOCAL })).toEqual([
      { cue: 'three', delayMs: 0 },
    ])
    expect(cuesDueAt({ previousRemainingMs: 2040, remainingMs: 1990, delaysMs: LOCAL })).toEqual([
      { cue: 'two', delayMs: 0 },
    ])
    expect(cuesDueAt({ previousRemainingMs: 1040, remainingMs: 990, delaysMs: LOCAL })).toEqual([
      { cue: 'one', delayMs: 0 },
    ])
  })

  it('says nothing on a tick that crosses no moment', () => {
    expect(cuesDueAt({ previousRemainingMs: 2800, remainingMs: 2750, delaysMs: LOCAL })).toEqual([])
  })

  it('beeps as the Shot expires', () => {
    expect(cuesDueAt({ previousRemainingMs: 40, remainingMs: 0, delaysMs: LOCAL })).toEqual([
      { cue: 'beep', delayMs: 0 },
    ])
  })

  it('does not beep again once the remaining time is pinned at zero', () => {
    expect(cuesDueAt({ previousRemainingMs: 0, remainingMs: 0, delaysMs: LOCAL })).toEqual([])
  })

  it('plays a delayed Output early, and the operator’s copy on the beat', () => {
    const delaysMs = [400, 0]

    // 400ms before the operator hears "three", the band's copy is already playing.
    expect(cuesDueAt({ previousRemainingMs: 3440, remainingMs: 3390, delaysMs })).toEqual([
      { cue: 'three', delayMs: 400 },
    ])
    expect(cuesDueAt({ previousRemainingMs: 3040, remainingMs: 2990, delaysMs })).toEqual([
      { cue: 'three', delayMs: 0 },
    ])

    // And the same for the expiry beep.
    expect(cuesDueAt({ previousRemainingMs: 440, remainingMs: 390, delaysMs })).toEqual([
      { cue: 'beep', delayMs: 400 },
    ])
    expect(cuesDueAt({ previousRemainingMs: 40, remainingMs: 0, delaysMs })).toEqual([
      { cue: 'beep', delayMs: 0 },
    ])
  })

  it('fires every moment a slow tick jumped over, in the order they are spoken', () => {
    // A frame lost to a repaint must cost information, not a whole countdown.
    const due = cuesDueAt({ previousRemainingMs: 3200, remainingMs: 0, delaysMs: LOCAL })

    expect(due).toEqual([
      { cue: 'three', delayMs: 0 },
      { cue: 'two', delayMs: 0 },
      { cue: 'one', delayMs: 0 },
      { cue: 'beep', delayMs: 0 },
    ])
  })

  it('fires both Outputs when one tick crosses both their moments', () => {
    const due = cuesDueAt({ previousRemainingMs: 1500, remainingMs: 900, delaysMs: [200, 0] })

    // "one" is due at 1200ms for the delayed Output and at 1000ms for the
    // operator's: one tick, two copies, neither dropped.
    expect(due).toEqual([
      { cue: 'one', delayMs: 200 },
      { cue: 'one', delayMs: 0 },
    ])
  })

  it('drops a copy whose moment was before the item went live', () => {
    // A delay longer than the countdown: the word for three seconds would have to
    // have been played before the previous Shot ended. There is nothing to play
    // early against, so that Output simply misses it.
    const delaysMs = [5000]
    const ticks = [
      { previousRemainingMs: 2000, remainingMs: 1500 },
      { previousRemainingMs: 1500, remainingMs: 1000 },
      { previousRemainingMs: 1000, remainingMs: 0 },
    ]

    expect(ticks.flatMap((tick) => cuesDueAt({ ...tick, delaysMs }))).toEqual([])
  })

  it('beeps at once when the Shot is shorter than the Output’s delay', () => {
    // A 1000ms route and an 800ms Shot: the moment the beep is wanted fell before
    // the Shot began, so there is no moment left to cross. Clamped into the Shot
    // and played at its first reading instead — late for that listener, which
    // reads as the slow route it is, where no beep at all reads as a fault.
    const delaysMs = [1000]
    const ticks = [
      { previousRemainingMs: null, remainingMs: 800 },
      { previousRemainingMs: 800, remainingMs: 600 },
      { previousRemainingMs: 600, remainingMs: 300 },
      { previousRemainingMs: 300, remainingMs: 0 },
    ]

    // Once, and only once: from the second tick on, that moment is above the
    // previous reading and can never be crossed.
    expect(ticks.flatMap((tick) => cuesDueAt({ ...tick, delaysMs }))).toEqual([
      { cue: 'beep', delayMs: 1000 },
    ])
  })

  it('still beeps for a route that runs ahead, at expiry rather than after it', () => {
    // A negative delay wants the beep played late, and the remaining time stops at
    // zero, so it is played on the beat instead of not at all.
    expect(cuesDueAt({ previousRemainingMs: 40, remainingMs: 0, delaysMs: [-300] })).toEqual([
      { cue: 'beep', delayMs: -300 },
    ])
  })

  it('shifts a word later for a route that runs ahead', () => {
    expect(cuesDueAt({ previousRemainingMs: 2750, remainingMs: 2690, delaysMs: [-300] })).toEqual([
      { cue: 'three', delayMs: -300 },
    ])
  })

  it('fires nothing on the first tick of a Live session', () => {
    // Every moment above the item's own duration has "already passed"; without a
    // previous reading they would all fire at once.
    expect(cuesDueAt({ previousRemainingMs: null, remainingMs: 2000, delaysMs: LOCAL })).toEqual([])
    // Nor for an Output whose delay the item has room for: its beep still has a
    // moment to be crossed, and crossing it is how it is recognised.
    expect(cuesDueAt({ previousRemainingMs: null, remainingMs: 5000, delaysMs: [1000] })).toEqual(
      [],
    )
  })

  it('fires nothing when nothing is live', () => {
    expect(cuesDueAt({ previousRemainingMs: 1000, remainingMs: null, delaysMs: LOCAL })).toEqual([])
  })

  it('plays nothing when no Output carries Cues', () => {
    expect(cuesDueAt({ previousRemainingMs: 3040, remainingMs: 0, delaysMs: [] })).toEqual([])
  })

  it('collapses two Outputs that share a delay into one play', () => {
    // The player plays every copy with that delay; asking twice would be a
    // stutter on both.
    expect(cuesDueAt({ previousRemainingMs: 40, remainingMs: 0, delaysMs: [0] })).toHaveLength(1)
  })
})
