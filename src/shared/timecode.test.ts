import { describe, it, expect } from 'vitest'
import { parseTimecode, tryParseTimecode } from './timecode'

/**
 * The import dialog and the main process used to parse timecode separately,
 * and disagreed on failure: the preview returned null, the writer threw. A
 * drop-frame timecode therefore previewed as an unflagged raw string and then
 * rolled the whole import back with nothing on screen to explain it.
 */
describe('timecode', () => {
  it('converts HH:MM:SS:FF to milliseconds', () => {
    expect(parseTimecode('00:00:05:00', 25)).toBe(5000)
    expect(parseTimecode('01:02:03:00', 25)).toBe((3600 + 120 + 3) * 1000)
  })

  it('converts the frame count with the given frame rate', () => {
    expect(parseTimecode('00:00:00:12', 24)).toBe(500)
    expect(parseTimecode('00:00:00:12', 25)).toBe(480)
  })

  it('rejects drop-frame timecode, which uses a semicolon before the frames', () => {
    // 29.97 and 59.94 fps Resolve projects write this, and it is the single
    // most likely reason a real export fails.
    expect(tryParseTimecode('00:00:05;12', 29.97)).toBeNull()
    expect(() => parseTimecode('00:00:05;12', 29.97)).toThrow()
  })

  it.each([
    ['too few parts', '00:00:05'],
    ['too many parts', '00:00:00:05:00'],
    ['a non-numeric part', '00:0a:05:00'],
    ['an empty part', '00::05:00'],
    ['nothing at all', ''],
  ])('rejects %s', (_what, timecode) => {
    expect(tryParseTimecode(timecode, 25)).toBeNull()
    expect(() => parseTimecode(timecode, 25)).toThrow()
  })

  it('rejects a frame rate that cannot divide', () => {
    expect(tryParseTimecode('00:00:00:12', 0)).toBeNull()
    expect(tryParseTimecode('00:00:00:12', -25)).toBeNull()
    expect(tryParseTimecode('00:00:00:12', Number.NaN)).toBeNull()
    expect(() => parseTimecode('00:00:00:12', 0)).toThrow(/fps/)
  })

  it('agrees with itself: whatever tryParse rejects, parse throws on', () => {
    const samples = ['00:00:05:00', '00:00:05;12', 'nope', '1:2:3:4', '00:00:00:00']
    for (const tc of samples) {
      const tried = tryParseTimecode(tc, 25)
      if (tried === null) expect(() => parseTimecode(tc, 25)).toThrow()
      else expect(parseTimecode(tc, 25)).toBe(tried)
    }
  })
})
