/**
 * The pure helpers only. Nothing here mounts the timeline or touches a canvas —
 * but what the warning strip says is the one part of this component an operator
 * reads before a show, so it is worth pinning.
 */

import { describe, expect, it } from 'vitest'
import { announcementProblemLabel } from './TimelineEditor'

type Problems = Map<string, 'dropped' | 'phrase-only'>

describe('announcementProblemLabel', () => {
  it('says nothing when every call announces properly', () => {
    expect(announcementProblemLabel(new Map() as Problems)).toBeNull()
  })

  it('counts the silent calls', () => {
    const problems: Problems = new Map([
      ['a', 'dropped'],
      ['b', 'dropped'],
    ])
    expect(announcementProblemLabel(problems)).toBe('2 calls are too short: 2 silent')
  })

  it('counts the calls that will speak a name with no numbers', () => {
    const problems: Problems = new Map([['a', 'phrase-only']])
    expect(announcementProblemLabel(problems)).toBe('1 call is too short: 1 with no countdown')
  })

  it('keeps the two apart, because they are different problems', () => {
    const problems: Problems = new Map([
      ['a', 'dropped'],
      ['b', 'phrase-only'],
      ['c', 'phrase-only'],
    ])
    expect(announcementProblemLabel(problems)).toBe(
      '3 calls are too short: 1 silent, 2 with no countdown',
    )
  })

  it('agrees with itself about singular and plural', () => {
    expect(announcementProblemLabel(new Map([['a', 'dropped']]) as Problems)).toContain('1 call is')
    expect(
      announcementProblemLabel(
        new Map([
          ['a', 'dropped'],
          ['b', 'phrase-only'],
        ]) as Problems,
      ),
    ).toContain('2 calls are')
  })
})
