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

const V = 'v1:8000:40:20000'

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
    await cache.put(mediaPath, V, { peaks: [0, 0.5, 1], durationMs: 1234 })
    expect(await cache.get(mediaPath, V)).toEqual({ peaks: [0, 0.5, 1], durationMs: 1234 })
  })

  it('misses for a file it has never seen', async () => {
    const cache = createWaveformCache(dir)
    expect(await cache.get(mediaPath, V)).toBeNull()
  })

  it('misses once the file is replaced at the same path', async () => {
    const cache = createWaveformCache(dir)
    await cache.put(mediaPath, V, { peaks: [1], durationMs: 10 })
    expect(await cache.get(mediaPath, V)).not.toBeNull()

    // A different size is a different file, whatever the path says.
    await fsPromises.writeFile(mediaPath, 'completely different bytes, longer')
    expect(await cache.get(mediaPath, V)).toBeNull()
  })

  it('misses for a file that no longer exists rather than serving stale peaks', async () => {
    const cache = createWaveformCache(dir)
    await cache.put(mediaPath, V, { peaks: [1], durationMs: 10 })
    await fsPromises.rm(mediaPath)
    expect(await cache.get(mediaPath, V)).toBeNull()
  })

  it('treats an unreadable entry as a miss instead of throwing', async () => {
    const cache = createWaveformCache(dir)
    await cache.put(mediaPath, V, { peaks: [1], durationMs: 10 })
    // Corrupt the entry in place, whatever it happens to be called.
    const cacheDir = join(dir, 'waveform-cache')
    for (const name of await fsPromises.readdir(cacheDir)) {
      await fsPromises.writeFile(join(cacheDir, name), 'not json{{{')
    }
    expect(await cache.get(mediaPath, V)).toBeNull()
    // And it recovers: a put over the corrupt entry is readable again.
    await cache.put(mediaPath, V, { peaks: [0.25], durationMs: 5 })
    expect(await cache.get(mediaPath, V)).toEqual({ peaks: [0.25], durationMs: 5 })
  })

  it('misses when the peaks were produced by different settings', async () => {
    const cache = createWaveformCache(dir)
    await cache.put(mediaPath, V, { peaks: [1], durationMs: 10 })
    expect(await cache.get(mediaPath, 'v1:8000:80:20000')).toBeNull()
    // The matching version still hits, so this is a version check and not a
    // blanket invalidation.
    expect(await cache.get(mediaPath, V)).not.toBeNull()
  })

  it('does not answer one lookup by reading every other entry', async () => {
    // A single shared document reached 13MB at the entry cap, and parsing all of
    // it to answer one lookup was the stall the cache exists to remove.
    const cache = createWaveformCache(dir)
    const big = Array.from({ length: 5_000 }, (_, i) => i / 5_000)
    for (let i = 0; i < 5; i++) {
      const p = join(dir, `big${i}.mp3`)
      await fsPromises.writeFile(p, `bytes ${i}`)
      await cache.put(p, V, { peaks: big, durationMs: 1000 })
    }
    const names = await fsPromises.readdir(join(dir, 'waveform-cache'))
    expect(names.length).toBe(5)
    // Each entry stands alone, so a lookup reads one file rather than all five.
    for (const name of names) {
      const bytes = (await fsPromises.stat(join(dir, 'waveform-cache', name))).size
      expect(bytes).toBeLessThan(200_000)
    }
  })

  it('does not store peaks for a path that cannot be stat-ed', async () => {
    const cache = createWaveformCache(dir)
    await cache.put(join(dir, 'missing.mp3'), V, { peaks: [1], durationMs: 1 })
    expect(await cache.get(join(dir, 'missing.mp3'), V)).toBeNull()
  })

  it('keeps the cache bounded', async () => {
    const cache = createWaveformCache(dir)
    for (let i = 0; i < 70; i++) {
      const p = join(dir, `f${i}.mp3`)
      await fsPromises.writeFile(p, `bytes ${i}`)
      await cache.put(p, V, { peaks: [i], durationMs: i })
    }
    const names = await fsPromises.readdir(join(dir, 'waveform-cache'))
    expect(names.length).toBeLessThanOrEqual(64)
    // The most recent write survives eviction.
    expect(await cache.get(join(dir, 'f69.mp3'), V)).toEqual({ peaks: [69], durationMs: 69 })
  })
})
