/**
 * The cache's whole job is to be correct about staleness: a stale hit would draw
 * one file's waveform under another's Shots, which is worse than re-decoding.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fsPromises } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWaveformCache } from './waveform-cache'

let dir: string
let mediaPath: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'waveform-cache-'))
  mediaPath = join(dir, 'reference.mp3')
  await fsPromises.writeFile(mediaPath, 'original bytes')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createWaveformCache', () => {
  it('returns what was stored', async () => {
    const cache = createWaveformCache(dir)
    await cache.put(mediaPath, { peaks: [0, 0.5, 1], durationMs: 1234 })
    expect(await cache.get(mediaPath)).toEqual({ peaks: [0, 0.5, 1], durationMs: 1234 })
  })

  it('misses for a file it has never seen', async () => {
    const cache = createWaveformCache(dir)
    expect(await cache.get(mediaPath)).toBeNull()
  })

  it('misses once the file is replaced at the same path', async () => {
    const cache = createWaveformCache(dir)
    await cache.put(mediaPath, { peaks: [1], durationMs: 10 })
    expect(await cache.get(mediaPath)).not.toBeNull()

    // A different size is a different file, whatever the path says.
    await fsPromises.writeFile(mediaPath, 'completely different bytes, longer')
    expect(await cache.get(mediaPath)).toBeNull()
  })

  it('misses for a file that no longer exists rather than serving stale peaks', async () => {
    const cache = createWaveformCache(dir)
    await cache.put(mediaPath, { peaks: [1], durationMs: 10 })
    await fsPromises.rm(mediaPath)
    expect(await cache.get(mediaPath)).toBeNull()
  })

  it('treats an unreadable cache file as empty instead of throwing', async () => {
    await fsPromises.writeFile(join(dir, 'waveform-cache.json'), 'not json{{{')
    const cache = createWaveformCache(dir)
    expect(await cache.get(mediaPath)).toBeNull()
    // And it recovers: a put over the corrupt file is readable again.
    await cache.put(mediaPath, { peaks: [0.25], durationMs: 5 })
    expect(await cache.get(mediaPath)).toEqual({ peaks: [0.25], durationMs: 5 })
  })

  it('does not store peaks for a path that cannot be stat-ed', async () => {
    const cache = createWaveformCache(dir)
    await cache.put(join(dir, 'missing.mp3'), { peaks: [1], durationMs: 1 })
    expect(await cache.get(join(dir, 'missing.mp3'))).toBeNull()
  })

  it('keeps the cache bounded', async () => {
    const cache = createWaveformCache(dir)
    for (let i = 0; i < 70; i++) {
      const p = join(dir, `f${i}.mp3`)
      await fsPromises.writeFile(p, `bytes ${i}`)
      await cache.put(p, { peaks: [i], durationMs: i })
    }
    const raw = JSON.parse(
      await fsPromises.readFile(join(dir, 'waveform-cache.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(Object.keys(raw).length).toBeLessThanOrEqual(64)
    // The most recent write survives eviction.
    expect(await cache.get(join(dir, 'f69.mp3'))).toEqual({ peaks: [69], durationMs: 69 })
  })
})
