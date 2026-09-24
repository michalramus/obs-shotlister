/**
 * Where synthesised Announcement clips live on disk, and how they are swept.
 *
 * The cache is content-addressed (ADR 0005): a clip's filename is the hash of
 * the text, the Voice and the engine it was made from, so nothing in here needs
 * to know what a Part is. That is the whole point — a renamed Part simply stops
 * pointing at its old clip, and the old clip becomes an orphan that a sweep
 * collects.
 *
 * Deciding *which* clips are wanted belongs to `shared/render-plan`; this module
 * only ever does the file IO it is told to do.
 */

import { mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Clips are WAV because that is what Piper writes.
 *
 * The spec says `.opus`, but transcoding would mean shipping ffmpeg with the
 * app for a cache that holds a few hundred one-second clips — a dependency and
 * a per-clip failure mode bought for a few megabytes of disk. WAV also keeps
 * the duration readable from the file's own header, which is what flush
 * placement schedules against.
 */
export const CLIP_EXTENSION = '.wav'

/**
 * A hash is a filename, and it arrives from the database, so it is checked
 * rather than trusted: anything but lowercase hex could escape the cache
 * directory or clobber a file that is not ours.
 */
const HASH_PATTERN = /^[0-9a-f]{8,64}$/

function assertHash(hash: string): void {
  if (!HASH_PATTERN.test(hash)) {
    throw new Error(`invalid clip hash ${JSON.stringify(hash)}`)
  }
}

export function clipsDir(userDataDir: string): string {
  return join(userDataDir, 'speech')
}

export function clipPath(userDataDir: string, hash: string): string {
  assertHash(hash)
  return join(clipsDir(userDataDir), `${hash}${CLIP_EXTENSION}`)
}

/** Creates the cache directory if it is missing, and returns it. */
export async function ensureClipsDir(userDataDir: string): Promise<string> {
  const dir = clipsDir(userDataDir)
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * Every hash the cache currently holds — what `computeRenderPlan` compares
 * against to decide what is rendered, stale or orphaned.
 *
 * A cache directory that does not exist yet is an empty cache, not an error:
 * that is the state of every fresh install.
 */
export async function listCachedHashes(userDataDir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(clipsDir(userDataDir))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return entries
    .filter((name) => name.endsWith(CLIP_EXTENSION))
    .map((name) => name.slice(0, -CLIP_EXTENSION.length))
    .filter((hash) => HASH_PATTERN.test(hash))
}

/**
 * Deletes the named clips, returning how many actually went.
 *
 * Sweeping runs at app start and app close only, never during a session (ADR
 * 0005), which is exactly when a failure must not be allowed to escalate: a
 * clip that another process has open is a reason to keep the file, not a reason
 * to refuse to start the app. So per-file failures are reported through
 * `onError` and the sweep carries on. A missing file is not a failure at all —
 * the caller wanted it gone and it is gone.
 */
export async function sweep(
  userDataDir: string,
  hashes: readonly string[],
  onError?: (hash: string, error: unknown) => void,
): Promise<string[]> {
  const gone: string[] = []
  for (const hash of hashes) {
    try {
      await unlink(clipPath(userDataDir, hash))
      gone.push(hash)
    } catch (error) {
      // Already absent counts as swept: the caller's job after this is to drop
      // the rows describing clips that are no longer on disk, and a file that
      // was never there qualifies.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        gone.push(hash)
        continue
      }
      // Anything else — a locked or read-only file — leaves the clip in place,
      // so its row has to stay too or the cache index would claim a file is
      // gone while it still occupies disk and still answers a lookup.
      onError?.(hash, error)
    }
  }
  return gone
}
