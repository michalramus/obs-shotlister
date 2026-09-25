/**
 * Deciding what speech a Project still needs synthesised, and what it no longer
 * needs at all.
 *
 * Announcements are rendered ahead of a show and merely played back during one
 * (ADR 0005), so something has to answer three questions before the operator
 * goes live: which Parts have usable audio, what is still to synthesise, and
 * which clips in the cache nothing points at any more. All three fall out of the
 * same comparison, so they are computed together, once, by this module.
 *
 * It is pure: plain data in, plain data out. No filesystem, no database, no
 * Piper. The caller loads the cache index and the render log, and acts on the
 * plan — this module never learns that clips are files.
 */

import { createHash } from 'node:crypto'
import type { PartRenderState, RenderState } from './ipc-contract'
import type { Part } from './types'
import { NUMBER_CLIP_RANGE } from './number-text'

// Re-exported so the render path keeps one import, but owned by number-text:
// that module has no Node dependencies, and the settings UI needs these bounds.
export { NUMBER_CLIP_RANGE } from './number-text'

/**
 * Joins the hashed fields with NUL, which cannot occur in a Part name, a voice id
 * or an engine id — so no two different triples can collide by disagreeing about
 * where one field ends and the next begins.
 */
const HASH_FIELD_SEPARATOR = '\u0000'

/** 32 hex chars = 128 bits, far more than enough to keep one cache collision-free. */
const HASH_LENGTH = 32

/**
 * The synthesiser every clip is rendered with.
 *
 * Part of each clip's content address, so it lives beside the hash rather than
 * with the engine that spawns Piper: the announcer resolves clips without ever
 * importing the renderer, and the two must agree on this string exactly or
 * every lookup misses and nothing is ever spoken.
 */
export const ENGINE_ID = 'piper'

/**
 * The content address of one clip.
 *
 * Every clip filename in the system derives from this, so it must stay stable
 * forever: changing the separator, the digest or the length orphans the whole
 * cache on the next app start.
 */
export function clipHash(text: string, voice: string, engine: string): string {
  return createHash('sha256')
    .update([text, voice, engine].join(HASH_FIELD_SEPARATOR))
    .digest('hex')
    .slice(0, HASH_LENGTH)
}

/**
 * What is actually spoken for a Part: its name followed by the Project's
 * connector — "gitara" + "za" → "gitara za". A Call's label is never spoken and
 * never reaches a hash, so every Call on the same Part shares one clip.
 *
 * Empty pieces are dropped rather than leaving stray whitespace in the hashed
 * text, because whitespace would silently fork the cache.
 */
export function partPhrase(name: string, connector: string): string {
  return [name.trim(), connector.trim()].filter((piece) => piece.length > 0).join(' ')
}

export interface RenderPlanInput {
  /** Every Part in scope for the Project, in whatever order the caller wants reported. */
  parts: Part[]
  /** The per-Project connector spoken after a Part's name ("za" / "in"). */
  connector: string
  voice: string
  engine: string
  /** Every hash the cache currently holds. */
  cachedHashes: Iterable<string>
  /**
   * What each Part was last rendered to: partId -> hash.
   *
   * Normally the caller loads the `part_renders` rows for this voice and engine.
   * Handing over a row rendered with a *different* voice is what makes a Voice
   * change read as `stale` rather than `missing` — this module only ever compares
   * hashes, so the caller's choice of rows decides which of the two it reports.
   */
  lastRendered: Map<string, string>
  /** The text each countdown number is synthesised from, e.g. 7 -> '7'. */
  countdownNumberTexts: Map<number, string>
}

/** One clip the caller still has to synthesise. */
export interface RenderPlanItem {
  hash: string
  text: string
  voice: string
  engine: string
}

export interface RenderPlan {
  parts: PartRenderState[]
  toRender: RenderPlanItem[]
  /**
   * Every clip this Project wants, cached or not — `toRender` is the subset that
   * is not on disk yet.
   *
   * Two callers need the whole list rather than the shortfall. Backfilling a
   * duration has to recover the text and Voice behind a hash, which a
   * content-addressed filename cannot give back. Deleting a Project's audio has
   * to know what that Project claims before it can work out what only it claims.
   */
  wanted: RenderPlanItem[]
  /** Hashes present in the cache that nothing needs; what orphan cleanup consumes. */
  toSweep: string[]
}

/**
 * Whether a Part's audio is usable, from the hash it was last rendered to.
 *
 * `missing` covers two cases that look different but sound the same: never
 * rendered at all, and rendered to a clip that has since vanished from the cache
 * (deleted behind our back). Both mean nothing would be spoken, so both have to
 * push the operator to render. `stale` is reserved for the case where a clip
 * *would* play but says the wrong thing — the Part was renamed, or the connector
 * or the Voice changed — which is the distinction the operator actually acts on.
 */
function partRenderState(
  lastHash: string | undefined,
  currentHash: string,
  cached: ReadonlySet<string>,
): RenderState {
  if (lastHash === undefined) return 'missing'
  if (!cached.has(lastHash)) return 'missing'
  return lastHash === currentHash ? 'rendered' : 'stale'
}

/**
 * Computes the render state of every Part, the clips still to synthesise, and the
 * orphans that can be swept.
 *
 * Scheduling is the caller's business: sweeping happens at app start and app close
 * only, never during a session (ADR 0005), and this function has no idea when it
 * was called.
 */
export function computeRenderPlan(input: RenderPlanInput): RenderPlan {
  const { parts, connector, voice, engine, lastRendered, countdownNumberTexts } = input
  const cached = new Set(input.cachedHashes)

  // Every hash the cache is entitled to keep. Whatever is left over is an orphan.
  const wantedHashes = new Set<string>()
  const wanted: RenderPlanItem[] = []
  const toRender: RenderPlanItem[] = []

  // Two Parts can share a name and a number word can repeat, so both lists are
  // deduplicated by hash: synthesising one clip twice writes the same file twice.
  const want = (text: string): string => {
    const hash = clipHash(text, voice, engine)
    if (!wantedHashes.has(hash)) {
      wantedHashes.add(hash)
      const item = { hash, text, voice, engine }
      wanted.push(item)
      if (!cached.has(hash)) toRender.push(item)
    }
    return hash
  }

  const partStates: PartRenderState[] = parts.map((part) => {
    const hash = want(partPhrase(part.name, connector))
    return {
      partId: part.id,
      name: part.name,
      state: partRenderState(lastRendered.get(part.id), hash, cached),
    }
  })

  for (let number = NUMBER_CLIP_RANGE.first; number <= NUMBER_CLIP_RANGE.last; number++) {
    const text = countdownNumberTexts.get(number)
    // A number with no text supplied is skipped rather than throwing: an
    // incomplete list is a settings problem, not a reason to refuse to render
    // everything else.
    if (text === undefined || text.trim().length === 0) continue
    want(text)
  }

  return {
    parts: partStates,
    toRender,
    wanted,
    toSweep: [...cached].filter((hash) => !wantedHashes.has(hash)),
  }
}
