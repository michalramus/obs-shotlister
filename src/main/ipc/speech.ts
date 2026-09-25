/**
 * The render plan against SQLite: what is wanted, what was rendered, what is
 * junk.
 *
 * Two pure modules already decided everything interesting: `shared/render-plan`
 * says which clips are wanted and which are orphans, and `main/speech/engine`
 * knows how to spawn Piper. This is the seam between them and the database. It
 * touches no files — the caller hands it the cache listing and performs every
 * deletion (`main/speech/service`); this module only ever reads and writes rows.
 *
 * Nothing here may run during a Live session (ADR 0005). Rendering is something
 * the operator asks for before a show; sweeping happens at app start and app
 * close only.
 */

import type Database from 'better-sqlite3'
import type { PartRenderState, ProjectRenderSummary } from '../../shared/ipc-contract'
import type { Part } from '../../shared/types'
import {
  ENGINE_ID,
  type RenderPlan,
  type RenderPlanItem,
  computeRenderPlan,
  partClipHash,
} from '../../shared/render-plan'
import { numberTexts } from '../../shared/number-text'
import { listParts } from './parts'
import { getEffectiveVoiceSettings } from './settings'

interface PartRenderRow {
  part_id: string
  voice: string
  hash: string
}

/**
 * What each Part was last rendered to.
 *
 * A row for the current Voice wins; failing that, any row the Part has is used,
 * which is what makes changing the Voice report *stale* rather than *missing* —
 * a clip still exists and would play, it just says it in the wrong voice.
 */
function lastRenderedByPart(db: Database.Database, voice: string): Map<string, string> {
  const rows = db
    .prepare('SELECT part_id, voice, hash FROM part_renders WHERE engine = ?')
    .all(ENGINE_ID) as PartRenderRow[]

  // Any row first, then let the current Voice overwrite it. Two passes rather
  // than one conditional, because "prefer this voice, else anything" is not
  // expressible in a single pass without depending on row order.
  const byPart = new Map<string, string>()
  for (const row of rows) if (!byPart.has(row.part_id)) byPart.set(row.part_id, row.hash)
  for (const row of rows) if (row.voice === voice) byPart.set(row.part_id, row.hash)
  return byPart
}

/** The render plan for one Project, against the clips actually on disk. */
export function projectRenderPlan(
  db: Database.Database,
  projectId: string,
  cachedHashes: Iterable<string>,
): RenderPlan {
  const settings = getEffectiveVoiceSettings(db, projectId)
  return computeRenderPlan({
    parts: listParts(db, projectId),
    connector: settings.connector,
    voice: settings.voice,
    engine: ENGINE_ID,
    cachedHashes,
    lastRendered: lastRenderedByPart(db, settings.voice),
    countdownNumberTexts: numberTexts(),
  })
}

/** What the warning strip and the Parts panel read. */
export function projectRenderSummary(
  db: Database.Database,
  projectId: string,
  cachedHashes: Iterable<string>,
  rendering = false,
): ProjectRenderSummary {
  const plan = projectRenderPlan(db, projectId, cachedHashes)
  return {
    parts: plan.parts,
    unrenderedCount: plan.parts.filter((p: PartRenderState) => p.state !== 'rendered').length,
    rendering,
  }
}

/**
 * The clips every Project in the database still needs.
 *
 * Rendering is offered per Project, but "render everything missing" covers every
 * Rundown in it, and deduplicating across Projects matters because two bands
 * sharing a Voice share their number clips.
 */
export function missingClips(
  db: Database.Database,
  projectId: string,
  cachedHashes: Iterable<string>,
): RenderPlanItem[] {
  return projectRenderPlan(db, projectId, cachedHashes).toRender
}

/**
 * Hashes no Project wants any more.
 *
 * Deliberately not `projectRenderPlan(...).toSweep`: that is the orphan list
 * *for one Project*, and sweeping on it would delete another Project's clips
 * the moment two Projects used different Voices. A clip is an orphan only when
 * every Project agrees it is one, so the per-Project lists are intersected.
 */
export function orphanedClips(db: Database.Database, cachedHashes: Iterable<string>): string[] {
  const cached = [...cachedHashes]
  const projects = db.prepare('SELECT id FROM projects').all() as { id: string }[]

  // With no Projects at all nothing is wanted, so everything cached is orphaned.
  let orphans = new Set(cached)
  for (const { id } of projects) {
    const sweepable = new Set(projectRenderPlan(db, id, cached).toSweep)
    orphans = new Set([...orphans].filter((hash) => sweepable.has(hash)))
    if (orphans.size === 0) break
  }
  return [...orphans]
}

/**
 * Cached clips that exist on disk but whose length nobody wrote down.
 *
 * A render records each clip as it lands, but the batch that left this database
 * in its current state did not — it recorded everything only once the whole run
 * finished, so a run interrupted after fifty of sixty clips left fifty WAVs with
 * no rows. Those clips are then invisible to a re-render, because the plan reads
 * the cache from disk and sees them as already rendered, and invisible to a
 * sweep, because they are still wanted. Without a duration the announcer can
 * play them but never place them, so they have to be measured rather than
 * re-synthesised.
 *
 * The text and Voice cannot be recovered from a hash — that is what content
 * addressing costs — so they come from the plan instead: every Project is asked
 * what it wants, and a wanted clip that is on disk without a row is one of these.
 */
export function clipsNeedingDurations(
  db: Database.Database,
  cachedHashes: Iterable<string>,
): RenderPlanItem[] {
  const cached = new Set(cachedHashes)
  if (cached.size === 0) return []

  const known = new Set(
    (db.prepare('SELECT hash FROM speech_clips').all() as { hash: string }[]).map((r) => r.hash),
  )

  const projects = db.prepare('SELECT id FROM projects').all() as { id: string }[]
  const byHash = new Map<string, RenderPlanItem>()
  for (const { id } of projects) {
    for (const item of projectRenderPlan(db, id, cached).wanted) {
      if (cached.has(item.hash) && !known.has(item.hash)) byHash.set(item.hash, item)
    }
  }
  return [...byHash.values()]
}

/**
 * Cached clips this Project wants that no other Project wants.
 *
 * What "delete this Project's audio" is allowed to touch. Clips are
 * content-addressed and shared on purpose — two Projects on the same Voice share
 * every number clip — so deleting everything one Project points at would silently
 * strip the audio from the Project next to it. Only what nothing else claims goes.
 *
 * Orphans are deliberately not included: nothing claims those either, but they
 * are the other button's job, and a Project archive should not quietly become a
 * cache-wide clean.
 */
export function clipsOnlyUsedBy(
  db: Database.Database,
  projectId: string,
  cachedHashes: Iterable<string>,
): string[] {
  const cached = [...cachedHashes]
  const mine = new Set(
    projectRenderPlan(db, projectId, cached)
      .wanted.map((item) => item.hash)
      .filter((hash) => cached.includes(hash)),
  )
  if (mine.size === 0) return []

  const others = db.prepare('SELECT id FROM projects WHERE id != ?').all(projectId) as {
    id: string
  }[]
  for (const { id } of others) {
    for (const item of projectRenderPlan(db, id, cached).wanted) mine.delete(item.hash)
    if (mine.size === 0) break
  }
  return [...mine]
}

/**
 * Drops what a Project's Parts were last rendered to.
 *
 * Runs with the delete above, and has to: a `part_renders` row pointing at a
 * clip that is gone reads as `missing`, which is true, but leaving the rows
 * behind would make a Part whose clip another Project still holds read as
 * `rendered` while this Project believes it deleted its audio.
 */
export function forgetPartRenders(db: Database.Database, projectId: string): void {
  db.prepare(
    'DELETE FROM part_renders WHERE part_id IN (SELECT id FROM parts WHERE project_id = ?)',
  ).run(projectId)
}

/**
 * Records a clip that now exists on disk.
 *
 * The duration is the load-bearing part: flush placement schedules the phrase
 * backwards from the first number using it, so a clip with no row here can be
 * played but never placed.
 */
export function recordClip(db: Database.Database, item: RenderPlanItem, durationMs: number): void {
  db.prepare(
    'INSERT OR REPLACE INTO speech_clips (hash, text, voice, engine, duration_ms) VALUES (?, ?, ?, ?, ?)',
  ).run(item.hash, item.text, item.voice, item.engine, durationMs)
}

/**
 * Points each Part at the clip its current name renders to.
 *
 * The engine never learns what a Part is — clips are content-addressed — so the
 * mapping has to be written back here, and it is what later tells a renamed
 * Part (stale) from one never rendered (missing).
 */
export function recordPartRenders(db: Database.Database, projectId: string): void {
  const settings = getEffectiveVoiceSettings(db, projectId)
  const parts: Part[] = listParts(db, projectId)

  const upsert = db.prepare(
    'INSERT OR REPLACE INTO part_renders (part_id, voice, engine, hash) VALUES (?, ?, ?, ?)',
  )
  const apply = db.transaction(() => {
    for (const part of parts) {
      const hash = partClipHash(part, settings)
      upsert.run(part.id, settings.voice, ENGINE_ID, hash)
    }
  })
  apply()
}

/**
 * Rows describing clips that are not on disk any more.
 *
 * The sweep alone never collects these. `orphanedClips` reasons about hashes it
 * was handed from the cache directory, so a clip whose file disappeared by some
 * other route — an operator clearing the folder, a failed write, a re-pin that
 * changed what every Part hashes to — leaves a row that nothing will ever look
 * at again and nothing will ever delete. They accumulate quietly.
 *
 * Worse than untidy: `announcer` resolves a clip by reading this table and
 * hands the renderer a URL for whatever it finds. A row here is a promise that
 * a file exists.
 */
export function vanishedClips(db: Database.Database, cachedHashes: Iterable<string>): string[] {
  const cached = new Set(cachedHashes)
  const rows = db.prepare('SELECT hash FROM speech_clips').all() as { hash: string }[]
  return rows.map((row) => row.hash).filter((hash) => !cached.has(hash))
}

/** Drops the rows for clips that have been deleted from disk. */
export function forgetClips(db: Database.Database, hashes: readonly string[]): void {
  if (hashes.length === 0) return
  const remove = db.prepare('DELETE FROM speech_clips WHERE hash = ?')
  const apply = db.transaction(() => {
    for (const hash of hashes) remove.run(hash)
  })
  apply()
}

/**
 * How long each Part's phrase clip runs, keyed by Part id.
 *
 * Edit mode needs this to badge a Call too short to say its own name: the
 * scheduler drops such an Announcement entirely, and the operator should find
 * that out while editing rather than during a show. A Part with no rendered
 * clip is absent rather than zero — nothing is known about its length, which is
 * a different thing from knowing it is short.
 */
export function phraseDurations(db: Database.Database, projectId: string): Record<string, number> {
  const settings = getEffectiveVoiceSettings(db, projectId)
  const lookup = db.prepare('SELECT duration_ms FROM speech_clips WHERE hash = ?')

  const durations: Record<string, number> = {}
  for (const part of listParts(db, projectId)) {
    const hash = partClipHash(part, settings)
    const row = lookup.get(hash) as { duration_ms: number } | undefined
    if (row) durations[part.id] = row.duration_ms
  }
  return durations
}
