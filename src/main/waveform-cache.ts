/**
 * Remembering the waveform peaks for a Reference media file.
 *
 * Extracting peaks means handing the whole file to `decodeAudioData` in the
 * renderer — the entire container buffered into one ArrayBuffer, then decoded.
 * For a 4K reference cut that is a multi-second freeze and a multi-gigabyte
 * allocation, and it happened again on every Rundown switch and every app start
 * for a file that had not changed.
 *
 * The peaks themselves are tiny — at most a few tens of thousands of floats — so
 * the fix is simply to keep them. Stored under userData rather than in the
 * project database: they are a derived artifact of a file on this machine, so
 * they must not travel in a Project export, and losing them costs only one
 * re-decode.
 *
 * Freshness is the file's own identity — size and mtime — so replacing the file
 * at the same path invalidates the entry without anyone having to remember to.
 */

import { promises as fsPromises } from 'node:fs'
import { join } from 'node:path'

/** What the renderer needs to draw the media lane without decoding anything. */
export interface WaveformEntry {
  peaks: number[]
  durationMs: number
}

interface StoredEntry extends WaveformEntry {
  /** Identity of the file the peaks were taken from. */
  sizeBytes: number
  mtimeMs: number
}

type CacheFile = Record<string, StoredEntry>

const FILE_NAME = 'waveform-cache.json'

/**
 * Cap on remembered files, so a long-running install does not grow without
 * bound. Evicts the least recently written — the operator's current material is
 * what matters, and an evicted entry costs one re-decode.
 */
const MAX_ENTRIES = 64

export interface WaveformCache {
  get(filePath: string): Promise<WaveformEntry | null>
  put(filePath: string, entry: WaveformEntry): Promise<void>
}

/** Identity of the file at `filePath`, or null if it cannot be read. */
async function identify(filePath: string): Promise<{ sizeBytes: number; mtimeMs: number } | null> {
  try {
    const stat = await fsPromises.stat(filePath)
    return { sizeBytes: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return null
  }
}

export function createWaveformCache(userDataDir: string): WaveformCache {
  const cachePath = join(userDataDir, FILE_NAME)

  async function read(): Promise<CacheFile> {
    try {
      const raw = await fsPromises.readFile(cachePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      // A hand-edited or truncated cache must not break media loading; an
      // unreadable cache is simply an empty one.
      return parsed !== null && typeof parsed === 'object' ? (parsed as CacheFile) : {}
    } catch {
      return {}
    }
  }

  return {
    async get(filePath) {
      const identity = await identify(filePath)
      if (!identity) return null
      const entry = (await read())[filePath]
      if (!entry) return null
      if (entry.sizeBytes !== identity.sizeBytes || entry.mtimeMs !== identity.mtimeMs) return null
      if (!Array.isArray(entry.peaks) || typeof entry.durationMs !== 'number') return null
      return { peaks: entry.peaks, durationMs: entry.durationMs }
    },

    async put(filePath, entry) {
      const identity = await identify(filePath)
      if (!identity) return
      const cache = await read()
      cache[filePath] = { ...entry, ...identity }

      const keys = Object.keys(cache)
      if (keys.length > MAX_ENTRIES) {
        for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete cache[key]
      }

      try {
        await fsPromises.writeFile(cachePath, JSON.stringify(cache), 'utf8')
      } catch (err) {
        // A cache that cannot be written is a slow app, not a broken one.
        // eslint-disable-next-line no-console
        console.error('[waveform-cache] write failed:', err)
      }
    },
  }
}
