import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { openMemoryDb } from '../db/memory-db.fixture'
import { createAnnouncementBuilder } from './announcer'
import { ENGINE_ID, clipHash, partClipHash } from '../../shared/render-plan'
import { numberTexts } from '../../shared/number-text'
import { getEffectiveVoiceSettings } from '../ipc/settings'
import { getPart } from '../ipc/parts'
import { listShots } from '../ipc/shots'
import type { Shot } from '../../shared/types'

/**
 * Announcement planning had no tests, and it is the one place where being
 * wrong is silent: a Call that says nothing sounds exactly like a Call nobody
 * rendered. ADR-0005 forbids synthesising at play time, so everything here is
 * a cache lookup that either hits or produces silence.
 */

const CLIPS_DIR = '/tmp/clips'

function seed(db: Database.Database): void {
  db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?,?,?)').run('p1', 'Gig', 1)
  db.prepare('INSERT INTO parts (id, project_id, number, name, color) VALUES (?,?,?,?,?)').run(
    'pt1',
    'p1',
    1,
    'gitara',
    '#0f0',
  )
  db.prepare(
    'INSERT INTO rundowns (id, project_id, name, created_at, order_index, kind) VALUES (?,?,?,?,?,?)',
  ).run('rd1', 'p1', 'Voices', 2, 0, 'voice')
  db.prepare(
    'INSERT INTO shots (id, rundown_id, camera_id, part_id, duration_ms, order_index, transition_ms) VALUES (?,?,?,?,?,?,?)',
  ).run('call1', 'rd1', null, 'pt1', 20000, 0, 0)
  db.prepare("UPDATE live_state SET project_id='p1', rundown_id='rd1' WHERE id=1")
}

/** Puts a clip in the cache under the hash the planner will look for. */
function cacheClip(db: Database.Database, hash: string, durationMs: number): void {
  db.prepare(
    'INSERT OR REPLACE INTO speech_clips (hash, text, voice, engine, duration_ms) VALUES (?,?,?,?,?)',
  ).run(hash, 'spoken text', 'v', ENGINE_ID, durationMs)
}

/** Read the way the Live session reads it — the raw row is snake_case. */
const call = (db: Database.Database): Shot => listShots(db, 'rd1')[0]!

describe('createAnnouncementBuilder', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
    seed(db)
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  function phraseHashFor(): string {
    const part = getPart(db, 'pt1')!
    return partClipHash(part, getEffectiveVoiceSettings(db, 'p1'))
  }

  it('says nothing when the Part has never been rendered', () => {
    const builder = createAnnouncementBuilder(db, CLIPS_DIR)
    // Nothing in speech_clips, so there is no phrase and no number to place.
    expect(builder.planFor(call(db), 10_000)).toBeNull()
  })

  it('plans the phrase once it is in the cache', () => {
    cacheClip(db, phraseHashFor(), 800)
    const builder = createAnnouncementBuilder(db, CLIPS_DIR)

    const plan = builder.planFor(call(db), 10_000)
    expect(plan).not.toBeNull()
    expect(plan!.callId).toBe('call1')
    expect(plan!.routes.length).toBeGreaterThan(0)
  })

  it('serves clips over the media protocol, not as bare paths', () => {
    cacheClip(db, phraseHashFor(), 800)
    const builder = createAnnouncementBuilder(db, CLIPS_DIR)

    const clips = builder.planFor(call(db), 10_000)!.routes[0]!.clips
    // A file:// URL would be blocked in the renderer and a bare path would not
    // resolve at all.
    expect(clips.length).toBeGreaterThan(0)
    for (const clip of clips) expect(clip.url.startsWith('media://')).toBe(true)
  })

  it('goes silent when the Part is renamed, rather than speaking the old name', () => {
    cacheClip(db, phraseHashFor(), 800)
    const builder = createAnnouncementBuilder(db, CLIPS_DIR)
    expect(builder.planFor(call(db), 10_000)).not.toBeNull()

    // Content-addressed: the new name hashes to a clip nobody rendered. That is
    // exactly what "stale" means, and silence beats the wrong name.
    db.prepare('UPDATE parts SET name = ? WHERE id = ?').run('gitara solo', 'pt1')
    expect(builder.planFor(call(db), 10_000)).toBeNull()
  })

  it('says nothing for a Call with no Part', () => {
    db.prepare('UPDATE shots SET part_id = NULL WHERE id = ?').run('call1')
    const builder = createAnnouncementBuilder(db, CLIPS_DIR)
    expect(builder.planFor(call(db), 10_000)).toBeNull()
  })

  it('includes a countdown number that has been rendered', () => {
    const settings = getEffectiveVoiceSettings(db, 'p1')
    cacheClip(db, phraseHashFor(), 500)
    const texts = numberTexts()
    for (const n of settings.countdown) {
      const text = texts.get(n)
      if (text) cacheClip(db, clipHash(text, settings.voice, ENGINE_ID), 400)
    }

    const builder = createAnnouncementBuilder(db, CLIPS_DIR)
    const plan = builder.planFor(call(db), 30_000)
    expect(plan).not.toBeNull()
    // Phrase plus at least one number, where an unrendered countdown gave one.
    expect(plan!.routes[0]!.clips.length).toBeGreaterThan(1)
  })

  it('never lets a broken lookup abort the Next that asked for it', () => {
    cacheClip(db, phraseHashFor(), 800)
    const builder = createAnnouncementBuilder(db, CLIPS_DIR)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    db.close()

    // A show keeps running even when speech does not.
    expect(() => builder.planFor({ id: 'call1', partId: 'pt1' } as Shot, 10_000)).not.toThrow()
  })
})
