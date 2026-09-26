/**
 * The Announcement clip cache, as an interface.
 *
 * Everything above this line — which clips are wanted, what to do when one
 * fails, when a sweep is allowed to run — is policy that ADR 0005 pins down and
 * that is worth asserting on. Everything below it is four file operations. The
 * seam is here so the policy can be tested against a cache held in a Map,
 * exactly as `audio/virtual-sink` is tested against an injected CommandRunner.
 *
 * The layout is *not* negotiable and is not part of this interface: a clip's
 * filename is the hash of the text, the Voice and the engine it was made from
 * (ADR 0005), and operators have populated caches on disk. A store addresses
 * clips by hash and nothing else, so no implementation of it can invent a
 * second layout.
 */

import { randomBytes } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { clipPath, ensureClipsDir, listCachedHashes, sweep } from './cache'

export interface ClipStore {
  /**
   * Every hash the cache holds.
   *
   * Read from the store rather than from `speech_clips` on purpose: a clip
   * deleted behind the app's back has to read as missing, not as rendered.
   */
  hashes: () => Promise<string[]>
  /**
   * Puts one clip in place, named by its hash.
   *
   * Must not become visible until it is complete: a half-written file sitting
   * at a hash reads as rendered forever, and would be played as a truncated
   * Announcement. The item is passed whole rather than just its hash so a store
   * could record what it holds; the file store needs only the hash.
   */
  put: (item: { hash: string }, bytes: Buffer) => Promise<void>
  /** The bytes of one clip. Rejects when it is absent or unreadable. */
  read: (hash: string) => Promise<Buffer>
  /**
   * Deletes the named clips and returns those that actually went.
   *
   * Only what went, because the caller drops the database rows for exactly that
   * list: a clip that could not be deleted still exists and still answers a
   * lookup, so forgetting its row would make the index disagree with the disk.
   */
  remove: (
    hashes: readonly string[],
    onError?: (hash: string, error: unknown) => void,
  ) => Promise<string[]>
}

/** The real cache, under `<userData>/speech`. */
export function createFileClipStore(userDataDir: string): ClipStore {
  return {
    hashes: () => listCachedHashes(userDataDir),

    async put(item, bytes) {
      // Staged in the cache directory rather than in the system temp directory,
      // so the rename that publishes the clip is a rename within one filesystem
      // and therefore atomic. A dotted name keeps it out of `hashes()`.
      const dir = await ensureClipsDir(userDataDir)
      const temporary = join(dir, `.${item.hash}.${randomBytes(6).toString('hex')}.part`)
      try {
        await writeFile(temporary, bytes)
        await rename(temporary, clipPath(userDataDir, item.hash))
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined)
        throw error
      }
    },

    read: (hash) => readFile(clipPath(userDataDir, hash)),

    remove: (hashes, onError) => sweep(userDataDir, hashes, onError),
  }
}
