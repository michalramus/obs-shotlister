/**
 * The check that keeps a database-sourced hash inside the clips directory.
 *
 * Every path this module builds is `<userData>/speech/<hash>.wav`, and the hash
 * half comes from `speech_clips` and `part_renders` — rows, not literals. So the
 * only thing standing between a bad row and a path outside the cache is
 * `HASH_PATTERN`, and until now nothing asserted on it at all.
 */

import { describe, expect, it } from 'vitest'
import { CLIP_EXTENSION, HASH_PATTERN, clipPath, clipsDir, listCachedHashes } from './cache'

describe('HASH_PATTERN', () => {
  it('accepts a hash of the length clips are actually named with', () => {
    expect(HASH_PATTERN.test('a'.repeat(16))).toBe(true)
    expect(HASH_PATTERN.test('0123456789abcdef'.repeat(4))).toBe(true)
  })

  it('refuses anything that would escape the clips directory', () => {
    for (const bad of [
      '..',
      '../../etc/passwd',
      'abcdef12/../../x',
      '/etc/passwd',
      'abcdef12/abcdef12',
      '..%2fabcdef12',
      'C:\\windows\\system32',
      'abcdef12\\..\\x',
    ]) {
      expect(HASH_PATTERN.test(bad), bad).toBe(false)
    }
  })

  it('refuses anything that is not lower-case hex, so no file but ours is named', () => {
    for (const bad of ['', 'abc', 'ABCDEF12', 'abcdef1g', 'abcdef12.wav', 'a'.repeat(65), ' ']) {
      expect(HASH_PATTERN.test(bad), bad).toBe(false)
    }
  })
})

describe('clipPath', () => {
  it('puts a clip inside the cache directory, named by its hash', () => {
    expect(clipPath('/u', 'abcdef12')).toBe(`${clipsDir('/u')}/abcdef12${CLIP_EXTENSION}`)
  })

  it('throws rather than build a path out of a hash it does not trust', () => {
    // Throwing, not sanitising: a row this wrong is corruption, and a quietly
    // repaired path would delete or overwrite whatever it happened to land on.
    expect(() => clipPath('/u', '../../etc/passwd')).toThrow(/invalid clip hash/)
    expect(() => clipPath('/u', '')).toThrow(/invalid clip hash/)
  })
})

describe('listCachedHashes', () => {
  it('treats a cache directory that does not exist as an empty cache', async () => {
    // The state of every fresh install, and not an error.
    expect(await listCachedHashes('/nonexistent-userdata-dir')).toEqual([])
  })
})
