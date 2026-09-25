import { describe, it, expect } from 'vitest'
import {
  DEFAULT_COUNTDOWN,
  PHRASE_GAP_MS,
  announcementShape,
  scheduleAnnouncement,
} from './announcement'
import type { AnnouncementClip, ScheduleInput } from './announcement'

// ---------------------------------------------------------------------------
// Fixtures — phrase 800ms, every number 400ms, so every expected atMs below is
// readable arithmetic.
// ---------------------------------------------------------------------------

const PHRASE: AnnouncementClip = { url: 'phrase.opus', durationMs: 800 }

function makeNumbers(ns: number[] = DEFAULT_COUNTDOWN): Map<number, AnnouncementClip> {
  return new Map(ns.map((n) => [n, { url: `${n}.opus`, durationMs: 400 }]))
}

function makeInput(overrides: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    callId: 'call-1',
    leadMs: 15000,
    phrase: PHRASE,
    numbers: makeNumbers(),
    countdown: DEFAULT_COUNTDOWN,
    placement: 'flush',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe('DEFAULT_COUNTDOWN', () => {
  it('is 10, 5, 3, 2, 1', () => {
    expect(DEFAULT_COUNTDOWN).toEqual([10, 5, 3, 2, 1])
  })
})

// ---------------------------------------------------------------------------
// Countdown placement
// ---------------------------------------------------------------------------

describe('scheduleAnnouncement — countdown', () => {
  it('lands number n exactly n seconds before the Call starts', () => {
    const plan = scheduleAnnouncement(makeInput({ phrase: null, leadMs: 15000 }))

    expect(plan).not.toBeNull()
    expect(plan!.clips).toEqual([
      { url: '10.opus', atMs: 5000 },
      { url: '5.opus', atMs: 10000 },
      { url: '3.opus', atMs: 12000 },
      { url: '2.opus', atMs: 13000 },
      { url: '1.opus', atMs: 14000 },
    ])
  })

  it('carries the callId through', () => {
    const plan = scheduleAnnouncement(makeInput({ callId: 'call-42' }))

    expect(plan!.callId).toBe('call-42')
  })

  it('returns clips sorted by atMs ascending whatever order the countdown is in', () => {
    const plan = scheduleAnnouncement(
      makeInput({ phrase: null, countdown: [1, 10, 3, 5, 2], leadMs: 15000 }),
    )

    expect(plan!.clips.map((c) => c.atMs)).toEqual([5000, 10000, 12000, 13000, 14000])
  })

  it('starts from the largest number that still fits on a short Call', () => {
    // 6s of lead: "10" would have to start 4s before the previous Call went live.
    const plan = scheduleAnnouncement(makeInput({ phrase: null, leadMs: 6000 }))

    expect(plan!.clips).toEqual([
      { url: '5.opus', atMs: 1000 },
      { url: '3.opus', atMs: 3000 },
      { url: '2.opus', atMs: 4000 },
      { url: '1.opus', atMs: 5000 },
    ])
  })

  it('drops numbers that would start before 0 rather than clamping them to 0', () => {
    const plan = scheduleAnnouncement(makeInput({ phrase: null, leadMs: 6000 }))

    expect(plan!.clips.map((c) => c.url)).not.toContain('10.opus')
    expect(plan!.clips.filter((c) => c.atMs === 0)).toHaveLength(0)
  })

  it('schedules nothing at or after the Calls own start', () => {
    // "0" would land exactly on the Call; "1" is the last thing that may speak.
    const plan = scheduleAnnouncement(
      makeInput({
        phrase: null,
        countdown: [1, 0],
        numbers: makeNumbers([1, 0]),
        leadMs: 1000,
      }),
    )

    expect(plan!.clips).toEqual([{ url: '1.opus', atMs: 0 }])
  })

  it('skips a countdown number that has no rendered clip', () => {
    const plan = scheduleAnnouncement(
      makeInput({ phrase: null, numbers: makeNumbers([10, 3, 1]), leadMs: 15000 }),
    )

    expect(plan!.clips).toEqual([
      { url: '10.opus', atMs: 5000 },
      { url: '3.opus', atMs: 12000 },
      { url: '1.opus', atMs: 14000 },
    ])
  })
})

// ---------------------------------------------------------------------------
// flush placement
// ---------------------------------------------------------------------------

describe('scheduleAnnouncement — flush placement', () => {
  it('leaves one breath between the end of the phrase and the first number', () => {
    const plan = scheduleAnnouncement(makeInput({ leadMs: 15000 }))

    expect(plan!.clips).toEqual([
      { url: 'phrase.opus', atMs: 3900 }, // 5000 - 800 - 300
      { url: '10.opus', atMs: 5000 },
      { url: '5.opus', atMs: 10000 },
      { url: '3.opus', atMs: 12000 },
      { url: '2.opus', atMs: 13000 },
      { url: '1.opus', atMs: 14000 },
    ])
  })

  it('works backwards from the first number that actually fits', () => {
    // "5" lands at 1000ms, which leaves no room for 800ms of phrase plus its
    // breath, so the utterance begins at "3".
    const plan = scheduleAnnouncement(makeInput({ leadMs: 6000 }))

    expect(plan!.clips[0]).toEqual({ url: 'phrase.opus', atMs: 1900 }) // 3000 - 800 - 300
    expect(plan!.clips[1]).toEqual({ url: '3.opus', atMs: 3000 })
  })

  it('works backwards from the first number that has a clip', () => {
    // "10" is unrendered, so the utterance begins at "5" and the phrase moves with it.
    const plan = scheduleAnnouncement(
      makeInput({ numbers: makeNumbers([5, 3, 2, 1]), leadMs: 15000 }),
    )

    expect(plan!.clips[0]).toEqual({ url: 'phrase.opus', atMs: 8900 }) // 10000 - 800 - 300
    expect(plan!.clips[1]).toEqual({ url: '5.opus', atMs: 10000 })
  })

  it('drops a number the phrase cannot fit in front of, rather than falling silent', () => {
    // 5.2s of lead: "5" starts at 200ms, nowhere near enough for an 800ms
    // phrase and its breath — so the utterance begins at "3" instead. The Call
    // is too short for the full countdown, which the spec answers with the
    // largest number that still fits, not with silence.
    const plan = scheduleAnnouncement(makeInput({ leadMs: 5200 }))

    expect(plan!.clips).toEqual([
      { url: 'phrase.opus', atMs: 1100 }, // 2200 - 800 - 300
      { url: '3.opus', atMs: 2200 },
      { url: '2.opus', atMs: 3200 },
      { url: '1.opus', atMs: 4200 },
    ])
  })

  it('speaks the name alone when no number leaves room in front of it', () => {
    // 1.5s of lead: only "1" survives, at 500ms, and an 800ms phrase will not
    // fit before it — so the phrase flushes against the Call's own start.
    const plan = scheduleAnnouncement(makeInput({ leadMs: 1500 }))

    expect(plan!.clips).toEqual([{ url: 'phrase.opus', atMs: 700 }]) // 1500 - 800
  })

  it('drops the Announcement only when the phrase is longer than the lead', () => {
    // This, and only this, is what Edit mode badges.
    expect(scheduleAnnouncement(makeInput({ leadMs: 700 }))).toBeNull()
  })

  it('keeps the Announcement when the phrase and its breath fit exactly at 0', () => {
    const plan = scheduleAnnouncement(makeInput({ leadMs: 6100 }))

    expect(plan!.clips[0]).toEqual({ url: 'phrase.opus', atMs: 0 })
    expect(plan!.clips[1]).toEqual({ url: '5.opus', atMs: 1100 })
  })

  it('honours a caller that asks for no breath at all', () => {
    const plan = scheduleAnnouncement(makeInput({ leadMs: 15000, phraseGapMs: 0 }))

    expect(plan!.clips[0]).toEqual({ url: 'phrase.opus', atMs: 4200 }) // 5000 - 800
  })

  it('spends the breath out of the lead, not out of the numbers', () => {
    const plan = scheduleAnnouncement(makeInput({ leadMs: 15000 }))
    const numbers = plan!.clips.filter((c) => c.url !== 'phrase.opus')

    // Every number still lands on its own second; only the phrase moved.
    expect(numbers).toEqual([
      { url: '10.opus', atMs: 5000 },
      { url: '5.opus', atMs: 10000 },
      { url: '3.opus', atMs: 12000 },
      { url: '2.opus', atMs: 13000 },
      { url: '1.opus', atMs: 14000 },
    ])
  })

  it('falls back to the Calls own start when no number is spoken', () => {
    const plan = scheduleAnnouncement(makeInput({ countdown: [], leadMs: 15000 }))

    expect(plan!.clips).toEqual([{ url: 'phrase.opus', atMs: 14200 }]) // 15000 - 800
  })
})

// ---------------------------------------------------------------------------
// immediate placement
// ---------------------------------------------------------------------------

describe('scheduleAnnouncement — immediate placement', () => {
  it('plays the phrase the moment the previous Call goes live', () => {
    const plan = scheduleAnnouncement(makeInput({ placement: 'immediate', leadMs: 15000 }))

    expect(plan!.clips).toEqual([
      { url: 'phrase.opus', atMs: 0 },
      { url: '10.opus', atMs: 5000 },
      { url: '5.opus', atMs: 10000 },
      { url: '3.opus', atMs: 12000 },
      { url: '2.opus', atMs: 13000 },
      { url: '1.opus', atMs: 14000 },
    ])
  })

  it('leaves the phrase at 0 even when the first number starts before it ends', () => {
    // "1" lands 400ms in, mid-phrase; immediate does not move for it.
    const plan = scheduleAnnouncement(makeInput({ placement: 'immediate', leadMs: 1400 }))

    expect(plan!.clips).toEqual([
      { url: 'phrase.opus', atMs: 0 },
      { url: '1.opus', atMs: 400 },
    ])
  })

  it('drops the whole Announcement when the phrase cannot finish before the Call', () => {
    const plan = scheduleAnnouncement(makeInput({ placement: 'immediate', leadMs: 700 }))

    expect(plan).toBeNull()
  })

  it('keeps the Announcement when the phrase finishes exactly as the Call starts', () => {
    const plan = scheduleAnnouncement(makeInput({ placement: 'immediate', leadMs: 800 }))

    expect(plan!.clips).toEqual([{ url: 'phrase.opus', atMs: 0 }])
  })

  it('still speaks the phrase when the countdown is empty', () => {
    const plan = scheduleAnnouncement(
      makeInput({ placement: 'immediate', countdown: [], leadMs: 15000 }),
    )

    expect(plan!.clips).toEqual([{ url: 'phrase.opus', atMs: 0 }])
  })
})

// ---------------------------------------------------------------------------
// Nothing to say
// ---------------------------------------------------------------------------

describe('scheduleAnnouncement — nothing to say', () => {
  it('schedules the numbers alone when the Part has no rendered phrase', () => {
    const plan = scheduleAnnouncement(makeInput({ phrase: null, leadMs: 4000 }))

    expect(plan!.clips).toEqual([
      { url: '3.opus', atMs: 1000 },
      { url: '2.opus', atMs: 2000 },
      { url: '1.opus', atMs: 3000 },
    ])
  })

  it('returns null when there is no phrase and no number fits', () => {
    const plan = scheduleAnnouncement(makeInput({ phrase: null, leadMs: 500 }))

    expect(plan).toBeNull()
  })

  it('returns null when there is no phrase and an empty countdown', () => {
    const plan = scheduleAnnouncement(makeInput({ phrase: null, countdown: [] }))

    expect(plan).toBeNull()
  })

  it('returns null when the Call is already due', () => {
    expect(scheduleAnnouncement(makeInput({ leadMs: 0 }))).toBeNull()
    expect(scheduleAnnouncement(makeInput({ placement: 'immediate', leadMs: 0 }))).toBeNull()
  })
})

describe('scheduleAnnouncement — transmission delay', () => {
  it('plays everything earlier so the band hears it on the beat', () => {
    // 300ms of Mumble buffering: every clip fires 300ms sooner, so what the
    // band hears is identical to the zero-delay schedule.
    const plan = scheduleAnnouncement(makeInput({ leadMs: 15000, transmissionDelayMs: 300 }))

    expect(plan!.clips).toEqual([
      { url: 'phrase.opus', atMs: 3600 }, // 4700 - 800 - 300
      { url: '10.opus', atMs: 4700 }, // 5000 - 300
      { url: '5.opus', atMs: 9700 },
      { url: '3.opus', atMs: 11700 },
      { url: '2.opus', atMs: 12700 },
      { url: '1.opus', atMs: 13700 },
    ])
  })

  it('leaves the schedule alone when the path adds nothing', () => {
    const withZero = scheduleAnnouncement(makeInput({ leadMs: 15000, transmissionDelayMs: 0 }))
    const withNone = scheduleAnnouncement(makeInput({ leadMs: 15000 }))
    expect(withZero).toEqual(withNone)
  })

  it('accepts a negative delay, for a path that runs ahead', () => {
    const plan = scheduleAnnouncement(makeInput({ leadMs: 15000, transmissionDelayMs: -200 }))
    expect(plan!.clips).toContainEqual({ url: '10.opus', atMs: 5200 })
  })

  it('drops a number the delay pushes before the previous Call', () => {
    // 10 would play at 11000 - 10000 - 1500 = -500, so the countdown starts at 5.
    const plan = scheduleAnnouncement(makeInput({ leadMs: 11000, transmissionDelayMs: 1500 }))

    const urls = plan!.clips.map((c) => c.url)
    expect(urls).not.toContain('10.opus')
    expect(urls).toContain('5.opus')
    expect(plan!.clips).toContainEqual({ url: '5.opus', atMs: 4500 })
  })

  it('drops the Announcement when the delay leaves no room for the phrase', () => {
    // A 1s lead with 800ms of path delay leaves 200ms for an 800ms phrase.
    expect(scheduleAnnouncement(makeInput({ leadMs: 1000, transmissionDelayMs: 800 }))).toBeNull()
  })

  it('counts the delay against the phrase under immediate placement', () => {
    // Nothing can play before now, so the delay cannot be compensated — it eats
    // the time the band has to hear the name. 800ms phrase + 400ms path needs
    // 1200ms of lead.
    const tooTight = scheduleAnnouncement(
      makeInput({ leadMs: 1100, transmissionDelayMs: 400, placement: 'immediate' }),
    )
    expect(tooTight).toBeNull()

    const fits = scheduleAnnouncement(
      makeInput({ leadMs: 1200, transmissionDelayMs: 400, placement: 'immediate' }),
    )
    expect(fits!.clips).toContainEqual({ url: 'phrase.opus', atMs: 0 })
  })

  it('keeps the phrase the same breath ahead of the first number it is heard before', () => {
    // The gap between phrase end and first number must stay exactly one breath
    // whatever the delay: both shift together, which is the whole point of flush.
    for (const transmissionDelayMs of [0, 250, 900]) {
      const clips = scheduleAnnouncement(makeInput({ leadMs: 15000, transmissionDelayMs }))!.clips
      const phrase = clips.find((c) => c.url === 'phrase.opus')!
      const first = clips.find((c) => c.url === '10.opus')!
      expect(phrase.atMs + 800 + PHRASE_GAP_MS).toBe(first.atMs)
    }
  })
})

describe('announcementShape', () => {
  const base = {
    phraseDurationMs: 800,
    countdown: DEFAULT_COUNTDOWN,
    placement: 'flush' as const,
  }

  it('is full when a number fits in front of the phrase', () => {
    expect(announcementShape({ ...base, leadMs: 15000 })).toBe('full')
  })

  it('is phrase-only when the name fits but no number does', () => {
    // 1.5s: only "1" survives, at 500ms, with no room for 800ms of phrase.
    expect(announcementShape({ ...base, leadMs: 1500 })).toBe('phrase-only')
  })

  it('is dropped when not even the name fits', () => {
    expect(announcementShape({ ...base, leadMs: 700 })).toBe('dropped')
  })

  it('counts the breath when deciding a number survives', () => {
    // A countdown of one, so there is no smaller number to fall back to.
    // "5" lands at leadMs - 5000; the phrase needs 800 + 300 in front of it.
    const single = { ...base, countdown: [5] }
    expect(announcementShape({ ...single, leadMs: 6100 })).toBe('full')
    expect(announcementShape({ ...single, leadMs: 6099 })).toBe('phrase-only')
  })

  it('answers for immediate placement too, where the phrase never moves', () => {
    const immediate = { ...base, placement: 'immediate' as const }
    expect(announcementShape({ ...immediate, leadMs: 15000 })).toBe('full')
    // 900ms: the phrase fits, but "1" would land before the previous Call went live.
    expect(announcementShape({ ...immediate, leadMs: 900 })).toBe('phrase-only')
    expect(announcementShape({ ...immediate, leadMs: 700 })).toBe('dropped')
  })

  it('accounts for the path delay', () => {
    expect(announcementShape({ ...base, leadMs: 1000, transmissionDelayMs: 800 })).toBe('dropped')
  })

  it('is phrase-only when the countdown is empty, however long the Call', () => {
    expect(announcementShape({ ...base, countdown: [], leadMs: 60000 })).toBe('phrase-only')
  })

  it('agrees with the scheduler at every lead', () => {
    // The two must never disagree: badging is only useful if it describes what
    // the show will actually do.
    for (const placement of ['flush', 'immediate'] as const) {
      for (const transmissionDelayMs of [0, 400]) {
        for (let leadMs = 0; leadMs <= 16000; leadMs += 50) {
          const plan = scheduleAnnouncement(makeInput({ leadMs, placement, transmissionDelayMs }))
          const expected =
            plan === null
              ? 'dropped'
              : plan.clips.some((c) => c.url !== 'phrase.opus')
                ? 'full'
                : 'phrase-only'

          expect({
            leadMs,
            placement,
            transmissionDelayMs,
            shape: announcementShape({ ...base, leadMs, placement, transmissionDelayMs }),
          }).toEqual({ leadMs, placement, transmissionDelayMs, shape: expected })
        }
      }
    }
  })
})
