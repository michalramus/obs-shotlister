/**
 * Remembering the waveform peaks for a Reference media file.
 *
 * Extracting peaks means handing the whole file to `decodeAudioData` in the
 * renderer — the entire container buffered into one ArrayBuffer, then decoded.
 * For a 4K reference cut that is a multi-second freeze and a multi-gigabyte
 * allocation, and it happened again on every Rundown switch and every app start
 * for a file that had not changed.
 *
 * Under userData rather than in the project database: peaks are a derived artifact
 * of a file on this machine, so they must not travel in a Project export, and
 * losing them costs only one re-decode.
 *
 * One file per entry, not one file for all of them. A single shared document
 * reached 13MB at the entry cap, and answering one lookup meant parsing all of it
 * on the thread that also serves IPC, OBS and SQLite — reintroducing the stall the
 * cache exists to remove. Per-entry files also make a write atomic rather than a
 * read-modify-write two concurrent decodes can clobber.
 *
 * Freshness is the file's own size and mtime plus the version of the algorithm
 * that produced the peaks, so replacing a file at the same path — or changing the
 * peak resolution in a later release — invalidates the entry without anyone having
 * to remember to.
 */

import { promises as fsPromises } from 'node:fs'
import { createHash } from 'node:crypto'
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
  /** Identifies the settings the peaks were produced with. */
  version: string
}

const DIR_NAME = 'waveform-cache'

/**
 * Cap on remembered files, so a long-running install does not grow without bound.
 * Evicts by write time — a re-decode is cheap next to an unbounded cache, and
 * tracking true recency would mean a write on every read.
 */
const MAX_ENTRIES = 64

export interface WaveformCache {
  get(filePath: string, version: string): Promise<WaveformEntry | null>
  put(filePath: string, version: string, entry: WaveformEntry): Promise<void>
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

/** Hashed so any path — spaces, unicode, length — is a usable filename. */
function entryName(filePath: string): string {
  return createHash('sha256').update(filePath).digest('hex').slice(0, 32) + '.json'
}

export function createWaveformCache(userDataDir: string): WaveformCache {
  const dir = join(userDataDir, DIR_NAME)

  /** Deletes the oldest entries once the directory is over the cap. */
  async function evict(): Promise<void> {
    const names = await fsPromises.readdir(dir).catch(() => [])
    if (names.length <= MAX_ENTRIES) return
    const withTimes = await Promise.all(
      names.map(async (name) => ({
        name,
        mtimeMs: await fsPromises
          .stat(join(dir, name))
          .then((s) => s.mtimeMs)
          .catch(() => 0),
      })),
    )
    withTimes.sort((a, b) => a.mtimeMs - b.mtimeMs)
    await Promise.all(
      withTimes
        .slice(0, withTimes.length - MAX_ENTRIES)
        .map((e) => fsPromises.rm(join(dir, e.name), { force: true })),
    )
  }

  return {
    async get(filePath, version) {
      const identity = await identify(filePath)
      if (!identity) return null

      let entry: StoredEntry
      try {
        const raw = await fsPromises.readFile(join(dir, entryName(filePath)), 'utf8')
        entry = JSON.parse(raw) as StoredEntry
      } catch {
        // Missing, truncated or hand-edited: an unreadable entry is simply a miss.
        return null
      }

      if (entry === null || typeof entry !== 'object') return null
      if (!Array.isArray(entry.peaks) || typeof entry.durationMs !== 'number') return null
      if (entry.version !== version) return null
      if (entry.sizeBytes !== identity.sizeBytes || entry.mtimeMs !== identity.mtimeMs) return null
      return { peaks: entry.peaks, durationMs: entry.durationMs }
    },

    async put(filePath, version, entry) {
      const identity = await identify(filePath)
      if (!identity) return

      const stored: StoredEntry = { ...entry, ...identity, version }
      const target = join(dir, entryName(filePath))
      // Written beside the target and renamed: a crash or a concurrent write must
      // not leave a half-written entry that later parses as garbage.
      const temp = `${target}.${process.pid}.tmp`
      try {
        await fsPromises.mkdir(dir, { recursive: true })
        await fsPromises.writeFile(temp, JSON.stringify(stored), 'utf8')
        await fsPromises.rename(temp, target)
        await evict()
      } catch (err) {
        await fsPromises.rm(temp, { force: true }).catch(() => undefined)
        // A cache that cannot be written is a slow app, not a broken one.
        // eslint-disable-next-line no-console
        console.error('[waveform-cache] write failed:', err)
      }
    },
  }
}
