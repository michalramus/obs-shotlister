import { describe, it, expect } from 'vitest'
import { outputTargets } from './audio-routing'

describe('outputTargets', () => {
  it('plays on one device when the intercom is off', () => {
    expect(outputTargets('speakers', null)).toEqual(['speakers'])
    expect(outputTargets(null, null)).toEqual([null])
  })

  it('adds the intercom as a second destination, primary first', () => {
    // Primary first matters: it is the copy that must not be dropped, and the
    // players treat every copy after the first as expendable.
    expect(outputTargets('speakers', 'shotlister-out')).toEqual(['speakers', 'shotlister-out'])
    expect(outputTargets(null, 'shotlister-out')).toEqual([null, 'shotlister-out'])
  })

  it('does not play the same device twice', () => {
    // Pointing the sound's own selector at the Virtual output and then switching
    // the intercom on as well is a reasonable thing to try, and two elements into
    // one device is a stutter rather than a duplicate.
    expect(outputTargets('shotlister-out', 'shotlister-out')).toEqual(['shotlister-out'])
  })
})
