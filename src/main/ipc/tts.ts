/**
 * Turning the render plan into files on disk, and back into a status the
 * operator can act on.
 *
 * Two pure modules already decided everything interesting: `shared/render-plan`
 * says which clips are wanted and which are orphans, and `main/tts/engine`
 * knows how to spawn Piper. This is the seam between them and SQLite — it reads
 * the cache, records what was rendered, and never decides anything itself.
 *
 * Nothing here may run during a Live session (ADR 0005). Rendering is something
 * the operator asks for before a show; sweeping happens at app start and app
 * close only.
 */

import type Database from 'better-sqlite3'
import type { PartRenderState, ProjectRenderStatus } from '../../shared/ipc-contract'
import type { Part } from '../../shared/types'
import {
  ENGINE_ID,
  type RenderPlan,
  type RenderPlanItem,
  clipHash,
  computeRenderPlan,
  partPhrase,
} from '../../shared/render-plan'
import { languageOfVoice, numberWords } from '../../shared/number-words'
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
    countdownNumberWords: numberWords(languageOfVoice(settings.voice)),
  })
}

/** What the warning strip and the Parts panel read. */
export function projectRenderStatus(
  db: Database.Database,
  projectId: string,
  cachedHashes: Iterable<string>,
  rendering = false,
): ProjectRenderStatus {
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
 * Records a clip that now exists on disk.
 *
 * The duration is the load-bearing part: flush placement schedules the phrase
 * backwards from the first number using it, so a clip with no row here can be
 * played but never placed.
 */
export function recordClip(db: Database.Database, item: RenderPlanItem, durationMs: number): void {
  db.prepare(
    'INSERT OR REPLACE INTO tts_clips (hash, text, voice, engine, duration_ms) VALUES (?, ?, ?, ?, ?)',
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
      const hash = clipHash(partPhrase(part.name, settings.connector), settings.voice, ENGINE_ID)
      upsert.run(part.id, settings.voice, ENGINE_ID, hash)
    }
  })
  apply()
}

/** Drops the rows for clips that have been deleted from disk. */
export function forgetClips(db: Database.Database, hashes: readonly string[]): void {
  if (hashes.length === 0) return
  const remove = db.prepare('DELETE FROM tts_clips WHERE hash = ?')
  const apply = db.transaction(() => {
    for (const hash of hashes) remove.run(hash)
  })
  apply()
}
