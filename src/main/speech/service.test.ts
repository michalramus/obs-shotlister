/**
 * When rendering is allowed to happen, and what it does when it is not.
 *
 * Every case here is a rule with a reason recorded in an ADR rather than a
 * behaviour anyone would guess: the three refusals ADR 0005 is made of, the
 * debounce that renders *every* Project queued during it, the latch that stops
 * auto-render restarting a hundred-megabyte download every few seconds (ADR
 * 0007), and the deletion that puts an unmeasurable clip back in reach.
 *
 * Nothing here spawns Piper, touches a cache directory or reaches the voice
 * catalogue. The cache is a Map and the synthesiser is a function, which is the
 * whole reason these rules are now assertable.
 */

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db/index'
import {
  DEFAULT_VOICE,
  saveGlobalVoiceSettings,
  getGlobalVoiceSettings,
  saveProjectVoiceSettings,
} from '../ipc/settings'
import { deletePart, upsertPart } from '../ipc/parts'
import { deleteProject } from '../ipc/projects'
import { recordClip, recordPartRenders } from '../ipc/speech'
import { ENGINE_ID, clipHash, partPhrase } from '../../shared/render-plan'
import { numberTexts } from '../../shared/number-text'
import { EngineUnusableError } from './batch'
import { clipsDir } from './cache'
import { createFileClipStore } from './clip-store'
import { AUTO_RENDER_DEBOUNCE_MS, createRenderService } from './service'
import type { RenderService, VoiceInstaller } from './service'
import {
  createFakeSynthesiser,
  createMemoryClipStore,
  wavOf,
  type FakeSynthesiser,
  type MemoryClipStore,
} from './clip-store.fixture'
import type { RenderPlanItem } from '../../shared/render-plan'

/** Taken from the setting rather than spelled out, as `ipc/speech.test` does. */
const VOICE = DEFAULT_VOICE

function openMemoryDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  return db
}

function insertProject(db: Database.Database, id: string): void {
  db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(id, id, 1000)
}

function phraseHash(name: string, connector = 'za', voice = VOICE): string {
  return clipHash(partPhrase(name, connector), voice, ENGINE_ID)
}

/**
 * Every countdown clip a Voice needs.
 *
 * Numbers are rendered 1..60 unconditionally (ADR 0005), so a Project with one
 * Part wants sixty-one clips. Seeding them is how a test gets down to the one
 * clip it is actually about.
 */
function numberHashes(voice = VOICE): string[] {
  return [...numberTexts().values()].map((text) => clipHash(text, voice, ENGINE_ID))
}

interface Harness {
  db: Database.Database
  clips: MemoryClipStore
  fake: FakeSynthesiser
  service: RenderService
  live: { running: boolean }
  installed: string[]
  statuses: number
}

function harness(
  options: {
    behaviour?: (item: RenderPlanItem) => number | Error
    installVoice?: VoiceInstaller
  } = {},
): Harness {
  const db = openMemoryDb()
  insertProject(db, 'p1')

  const clips = createMemoryClipStore()
  const fake = createFakeSynthesiser(clips, options.behaviour)
  const live = { running: false }
  const installed: string[] = []
  const h = {
    db,
    clips,
    fake,
    live,
    installed,
    statuses: 0,
  } as Harness

  h.service = createRenderService({
    db,
    clips,
    synthesise: fake.synthesise,
    installVoice:
      options.installVoice ??
      ((voice) => {
        installed.push(voice)
        return Promise.resolve()
      }),
    isLive: () => live.running,
    onStatus: () => {
      h.statuses++
    },
  })
  return h
}

/** Turns auto-render on; it is off by default, which is the point of the setting. */
function enableAutoRender(db: Database.Database): void {
  saveGlobalVoiceSettings(db, { ...getGlobalVoiceSettings(db), autoRender: true })
}

beforeEach(() => {
  // A sixty-one clip batch logs a line per clip, and every refusal logs its
  // reason. Neither is what is being asserted on.
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('renderMissing', () => {
  it('renders the one clip a Part is missing, and records its length', async () => {
    const h = harness({ behaviour: () => 640 })
    upsertPart(h.db, { projectId: 'p1', name: 'gitara' })
    for (const hash of numberHashes()) h.clips.seed(hash)

    const summary = await h.service.renderMissing('p1')

    expect(h.fake.asked.map((item) => item.text)).toEqual(['gitara za'])
    expect(await h.clips.hashes()).toContain(phraseHash('gitara'))
    expect(
      h.db.prepare('SELECT duration_ms FROM speech_clips WHERE hash = ?').get(phraseHash('gitara')),
    ).toEqual({ duration_ms: 640 })
    expect(summary.parts[0].state).toBe('rendered')
    // Pushed as it goes, because a batch is slow enough to look wedged.
    expect(h.statuses).toBeGreaterThan(0)
    h.db.close()
  })

  it('installs each Voice once per batch, before a single clip is attempted', async () => {
    // ADR 0007: a model is a hundred-odd megabytes, so it is fetched once, here,
    // and not per clip.
    const order: string[] = []
    const h = harness({
      behaviour: () => 400,
      installVoice: (voice) => {
        order.push(`install ${voice}`)
        return Promise.resolve()
      },
    })
    upsertPart(h.db, { projectId: 'p1', name: 'gitara' })
    for (const hash of numberHashes()) h.clips.seed(hash)

    await h.service.renderMissing('p1')

    expect(order).toEqual([`install ${VOICE}`])
    expect(h.fake.asked).toHaveLength(1)
    h.db.close()
  })

  it('stops after one clip when the engine cannot run, not after sixty-one', async () => {
    const h = harness({ behaviour: () => new EngineUnusableError('wrong CPU architecture') })
    upsertPart(h.db, { projectId: 'p1', name: 'gitara' })

    await expect(h.service.renderMissing('p1')).rejects.toThrow(/wrong CPU architecture/)

    expect(h.fake.asked).toHaveLength(1)
    h.db.close()
  })

  it('ignores a second ask while a render is already in flight', async () => {
    // The second caller gets the status of the render already running rather
    // than a second batch synthesising the same clips over the top of it.
    const h = harness({ behaviour: () => 400 })
    upsertPart(h.db, { projectId: 'p1', name: 'gitara' })
    for (const hash of numberHashes()) h.clips.seed(hash)

    const [, second] = await Promise.all([
      h.service.renderMissing('p1'),
      h.service.renderMissing('p1'),
    ])

    expect(h.fake.asked).toHaveLength(1)
    expect(second.rendering).toBe(true)
    h.db.close()
  })
})

describe('abortRender', () => {
  it('stops a batch already in flight, rather than only the next one (ADR 0005)', async () => {
    // The refusal in `renderMissing` only covers a batch that has not started.
    // Sixty-one clips is about five minutes on Apple Silicon, so a session
    // starting a minute in used to leave Piper spawning for four more on the
    // machine driving OBS — which is the one machine ADR 0005 is about.
    const h: Harness = harness({
      behaviour: () => {
        if (h.fake.asked.length === 2) {
          h.live.running = true
          h.service.abortRender()
        }
        return 400
      },
    })
    upsertPart(h.db, { projectId: 'p1', name: 'gitara' })

    const summary = await h.service.renderMissing('p1')

    expect(h.fake.asked).toHaveLength(2)
    // The clips it did finish keep their audio and their length: they are
    // recorded as each one lands, which is what makes stopping cheap.
    expect(await h.clips.hashes()).toHaveLength(2)
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM speech_clips').get()).toEqual({ n: 2 })
    // Stopping is not a failure, so nothing is latched and nothing throws — the
    // rest renders on the next explicit ask, after the show.
    expect(summary.rendering).toBe(false)
    h.db.close()
  })

  it('does nothing at all when no batch is running', () => {
    const h = harness()
    expect(() => {
      h.service.abortRender()
    }).not.toThrow()
    h.db.close()
  })
})

describe('the Live-session refusals (ADR 0005)', () => {
  let h: Harness

  beforeEach(() => {
    h = harness({ behaviour: () => 400 })
    upsertPart(h.db, { projectId: 'p1', name: 'gitara' })
    h.live.running = true
  })

  afterEach(() => {
    h.db.close()
  })

  it('refuses to render, because synthesis must never compete with OBS for CPU', async () => {
    await expect(h.service.renderMissing('p1')).rejects.toThrow(/Live session is running/)
    expect(h.fake.asked).toHaveLength(0)
  })

  it('refuses a clean the operator asked for, and says why', async () => {
    // Someone who pressed a button is owed the reason nothing happened.
    await expect(h.service.cleanOrphans('p1')).rejects.toThrow(/Live session is running/)
    expect(h.clips.removeAttempts).toEqual([])
  })

  it('refuses to delete a Project’s audio, and says why', async () => {
    await expect(h.service.deleteProjectClips('p1')).rejects.toThrow(/Live session is running/)
    expect(h.clips.removeAttempts).toEqual([])
  })

  it('sweeps nothing automatically, silently, because nobody is watching', async () => {
    h.clips.seed('deadbeef')
    expect(await h.service.sweepOrphans()).toBe(0)
    expect(await h.clips.hashes()).toEqual(['deadbeef'])
  })

  it('measures nothing, because reading the whole cache is not free either', async () => {
    h.clips.seed(phraseHash('gitara'))
    expect(await h.service.backfillDurations()).toBe(0)
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM speech_clips').get()).toEqual({ n: 0 })
  })

  it('drops an auto-render queued before the session started, rather than running it', async () => {
    vi.useFakeTimers()
    // Its own harness, because this one has to start with no session running.
    const idle = harness({ behaviour: () => 400 })
    enableAutoRender(idle.db)
    upsertPart(idle.db, { projectId: 'p1', name: 'gitara' })

    idle.service.scheduleAutoRender('p1')
    // A session may start part-way through the debounce; it is re-checked when
    // the timer fires rather than trusted from when it was scheduled.
    idle.live.running = true
    await vi.advanceTimersByTimeAsync(AUTO_RENDER_DEBOUNCE_MS)

    expect(idle.fake.asked).toHaveLength(0)
    idle.db.close()
  })
})

describe('scheduleAutoRender', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('renders every Project queued during the debounce, not only the last', async () => {
    // A global Voice change makes every Project stale at once; rendering only
    // the last of them left the rest silently unrendered.
    const h = harness({ behaviour: () => 400 })
    insertProject(h.db, 'p2')
    insertProject(h.db, 'p3')
    enableAutoRender(h.db)
    upsertPart(h.db, { projectId: 'p1', name: 'gitara' })
    upsertPart(h.db, { projectId: 'p2', name: 'wokal' })
    upsertPart(h.db, { projectId: 'p3', name: 'refren' })
    for (const hash of numberHashes()) h.clips.seed(hash)

    h.service.scheduleAutoRender('p1')
    h.service.scheduleAutoRender('p2')
    h.service.scheduleAutoRender('p3')
    await vi.advanceTimersByTimeAsync(AUTO_RENDER_DEBOUNCE_MS)

    expect(h.fake.asked.map((item) => item.text).sort()).toEqual([
      'gitara za',
      'refren za',
      'wokal za',
    ])
    h.db.close()
  })

  it('renders one Project once, however many times it was asked for', async () => {
    // The trigger is every keystroke of a rename; each intermediate spelling
    // would otherwise become a clip that is orphaned before it finishes.
    const h = harness({ behaviour: () => 400 })
    enableAutoRender(h.db)
    upsertPart(h.db, { projectId: 'p1', name: 'gitara' })
    for (const hash of numberHashes()) h.clips.seed(hash)

    for (let i = 0; i < 5; i++) {
      h.service.scheduleAutoRender('p1')
      await vi.advanceTimersByTimeAsync(AUTO_RENDER_DEBOUNCE_MS - 500)
    }
    expect(h.fake.asked).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(AUTO_RENDER_DEBOUNCE_MS)
    expect(h.fake.asked.map((item) => item.text)).toEqual(['gitara za'])
    h.db.close()
  })

  it('re-queues an auto-render that collided with a batch already running', async () => {
    // Only the Live-session drop above is deliberate. This one lost the ask
    // entirely: `renderMissing` returns the running batch's status instead of
    // throwing, so the queue entry was already gone and nothing retried it.
    let releaseInstall = (): void => {}
    let firstBatch = true
    const h = harness({
      behaviour: () => 400,
      installVoice: () => {
        if (!firstBatch) return Promise.resolve()
        firstBatch = false
        // Holds the manual batch open, the way a voice download or fifty
        // remaining clips would.
        return new Promise<void>((resolve) => {
          releaseInstall = resolve
        })
      },
    })
    enableAutoRender(h.db)
    const part = upsertPart(h.db, { projectId: 'p1', name: 'gitara' })
    for (const hash of numberHashes()) h.clips.seed(hash)

    const manual = h.service.renderMissing('p1')
    await vi.advanceTimersByTimeAsync(0)

    // The operator renames the Part while the manual batch runs. That batch
    // worked out what was missing before the rename, so the new phrase is in
    // neither it nor anything else — dropped, this stays `stale` until somebody
    // notices, which on the night is a countdown with no Part name.
    upsertPart(h.db, { projectId: 'p1', id: part.id, name: 'gitara solo' })
    h.service.scheduleAutoRender('p1')
    await vi.advanceTimersByTimeAsync(AUTO_RENDER_DEBOUNCE_MS)
    expect(h.fake.asked).toHaveLength(0)

    releaseInstall()
    await manual
    await vi.advanceTimersByTimeAsync(AUTO_RENDER_DEBOUNCE_MS)

    expect(h.fake.asked.map((item) => item.text)).toEqual(['gitara za', 'gitara solo za'])
    h.db.close()
  })

  it('does nothing at all while the setting is off, which is the default', async () => {
    const h = harness({ behaviour: () => 400 })
    upsertPart(h.db, { projectId: 'p1', name: 'gitara' })

    h.service.scheduleAutoRender('p1')
    await vi.advanceTimersByTimeAsync(AUTO_RENDER_DEBOUNCE_MS * 2)

    expect(h.fake.asked).toHaveLength(0)
    h.db.close()
  })
})

describe('the engine-broken latch', () => {
  it('latches, so auto-render stops retrying a binary that cannot work', async () => {
    vi.useFakeTimers()
    const h = harness({ behaviour: () => new EngineUnusableError('wrong CPU architecture') })
    enableAutoRender(h.db)
    upsertPart(h.db, { projectId: 'p1', name: 'gitara' })

    h.service.scheduleAutoRender('p1')
    await vi.advanceTimersByTimeAsync(AUTO_RENDER_DEBOUNCE_MS)
    expect(h.fake.asked).toHaveLength(1)

    // Every later debounce is a no-op: the operator saw this repeat on every
    // keystroke, and a failed voice download is worse — it restarts a
    // hundred-megabyte transfer (ADR 0007).
    for (let i = 0; i < 3; i++) {
      h.service.scheduleAutoRender('p1')
      await vi.advanceTimersByTimeAsync(AUTO_RENDER_DEBOUNCE_MS)
    }
    expect(h.fake.asked).toHaveLength(1)
    h.db.close()
  })

  it('latches on a Voice that could not be installed, not only on a dead binary', async () => {
    // ADR 0007: failing to obtain a voice is treated as the engine being
    // unusable rather than as sixty-one clip failures.
    vi.useFakeTimers()
    const attempts: string[] = []
    const h = harness({
      behaviour: () => 400,
      installVoice: (voice) => {
        attempts.push(voice)
        return Promise.reject(new Error('Could not reach the voice catalogue'))
      },
    })
    enableAutoRender(h.db)
    upsertPart(h.db, { projectId: 'p1', name: 'gitara' })

    for (let i = 0; i < 3; i++) {
      h.service.scheduleAutoRender('p1')
      await vi.advanceTimersByTimeAsync(AUTO_RENDER_DEBOUNCE_MS)
    }

    // One attempt, not one per debounce: the download is a hundred-odd megabytes.
    expect(attempts).toEqual([VOICE])
    expect(h.fake.asked).toHaveLength(0)
    h.db.close()
  })

  it('clears only when the operator asks for a render themselves', async () => {
    // Asking is the signal that they think they have dealt with the binary.
    let broken = true
    const h = harness({
      behaviour: () => (broken ? new EngineUnusableError('wrong CPU architecture') : 400),
    })
    enableAutoRender(h.db)
    upsertPart(h.db, { projectId: 'p1', name: 'gitara' })
    for (const hash of numberHashes()) h.clips.seed(hash)

    await expect(h.service.renderMissing('p1')).rejects.toThrow(/wrong CPU/)
    broken = false

    await h.service.renderMissing('p1')
    expect(h.fake.asked).toHaveLength(2)
    expect(await h.clips.hashes()).toContain(phraseHash('gitara'))
    h.db.close()
  })
})

describe('backfillDurations', () => {
  it('measures a clip that is on disk with no row, rather than re-synthesising it', async () => {
    // The text and Voice cannot be recovered from a hash, so the length is read
    // off the file; re-rendering would also be wrong, since the plan already
    // reads the clip as rendered.
    const h = harness()
    upsertPart(h.db, { projectId: 'p1', name: 'gitara' })
    recordPartRenders(h.db, 'p1')
    h.clips.seed(phraseHash('gitara'), wavOf(820))

    expect(await h.service.backfillDurations()).toBe(1)
    expect(
      h.db.prepare('SELECT duration_ms FROM speech_clips WHERE hash = ?').get(phraseHash('gitara')),
    ).toEqual({ duration_ms: 820 })
    expect(h.fake.asked).toHaveLength(0)
    h.db.close()
  })

  it('discards a clip it cannot measure, so a later render can reach it', async () => {
    // A clip that cannot be measured was never finished writing. Left alone it
    // reads as rendered forever and is never spoken.
    const h = harness()
    upsertPart(h.db, { projectId: 'p1', name: 'gitara' })
    recordPartRenders(h.db, 'p1')
    h.clips.seed(phraseHash('gitara'), Buffer.from('truncated, not a WAV at all'))

    expect(await h.service.backfillDurations()).toBe(0)

    expect(await h.clips.hashes()).not.toContain(phraseHash('gitara'))
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM speech_clips').get()).toEqual({ n: 0 })
    // Which is the whole point: it is back in the render plan.
    expect((await h.service.status('p1')).parts[0].state).not.toBe('rendered')
    h.db.close()
  })

  it('measures every clip it can, and discards only the one it could not', async () => {
    // Repair, so one bad clip must not abandon the others: they are invisible to
    // a re-render and to a sweep alike, and this is the only pass that reaches
    // them.
    const h = harness()
    insertProject(h.db, 'p2')
    upsertPart(h.db, { projectId: 'p1', name: 'gitara' })
    upsertPart(h.db, { projectId: 'p2', name: 'wokal' })
    recordPartRenders(h.db, 'p1')
    recordPartRenders(h.db, 'p2')
    h.clips.seed(phraseHash('gitara'), Buffer.from('truncated'))
    h.clips.seed(phraseHash('wokal'), wavOf(300))

    expect(await h.service.backfillDurations()).toBe(1)

    expect(h.clips.removeAttempts).toEqual([phraseHash('gitara')])
    expect(await h.clips.hashes()).toEqual([phraseHash('wokal')])
    h.db.close()
  })

  it('does nothing, and reads nothing, when every cached clip has a row', async () => {
    const h = harness()
    upsertPart(h.db, { projectId: 'p1', name: 'gitara' })
    expect(await h.service.backfillDurations()).toBe(0)
    h.db.close()
  })
})

describe('clipStats', () => {
  it('reads the cache on disk, so the picker counts what is really there', async () => {
    const h = harness()
    upsertPart(h.db, { projectId: 'p1', name: 'gitara' })

    // Nothing rendered yet: the Project wants a clip, the cache has none.
    expect(await h.service.clipStats()).toEqual([{ projectId: 'p1', name: 'p1', clipCount: 0 }])

    h.clips.seed(phraseHash('gitara'))
    expect(await h.service.clipStats()).toEqual([{ projectId: 'p1', name: 'p1', clipCount: 1 }])
    h.db.close()
  })

  it('counts a clip two Projects share for neither of them', async () => {
    const h = harness()
    insertProject(h.db, 'p2')
    upsertPart(h.db, { projectId: 'p1', name: 'gitara' })
    upsertPart(h.db, { projectId: 'p2', name: 'gitara' })
    h.clips.seed(phraseHash('gitara'))

    // Deleting either Project's recordings leaves the clip in place, so neither
    // Project may claim it in the count the operator decides on.
    expect((await h.service.clipStats()).map((row) => row.clipCount)).toEqual([0, 0])
    h.db.close()
  })

  it('answers during a Live session, because counting files changes nothing', async () => {
    const h = harness()
    upsertPart(h.db, { projectId: 'p1', name: 'gitara' })
    h.clips.seed(phraseHash('gitara'))
    h.live.running = true

    expect(await h.service.clipStats()).toEqual([{ projectId: 'p1', name: 'p1', clipCount: 1 }])
    expect(h.clips.removeAttempts).toEqual([])
    h.db.close()
  })
})

describe('cleanOrphans', () => {
  it('deletes the clip a renamed Part left behind, and drops its row', async () => {
    // The whole reason the button exists: the cache is content-addressed (ADR
    // 0005), so renaming a Part silently strands the clip its old name hashed to.
    const h = harness()
    const part = upsertPart(h.db, { projectId: 'p1', name: 'gitara' })
    recordPartRenders(h.db, 'p1')
    const stranded = phraseHash('gitara')
    h.clips.seed(stranded)
    recordClip(h.db, { hash: stranded, text: 'gitara za', voice: VOICE, engine: ENGINE_ID }, 400)
    upsertPart(h.db, { id: part.id, projectId: 'p1', name: 'wokal' })

    expect(await h.service.cleanOrphans('p1')).toBe(1)

    expect(await h.clips.hashes()).toEqual([])
    // The row goes with the file: a row is a promise that a clip exists, and the
    // announcer resolves clips through this table.
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM speech_clips').get()).toEqual({ n: 0 })
    // Which is what the operator then sees: stale before the clean, missing after.
    expect((await h.service.status('p1')).parts[0].state).toBe('missing')
    // And the panel is told without being asked.
    expect(h.statuses).toBeGreaterThan(0)
    h.db.close()
  })

  it('keeps a clip a second Project still wants, even when this one does not', async () => {
    // A clip is an orphan only when *every* Project agrees it is one. Sweeping a
    // Project's own `toSweep` would strip the audio from the Project next to it
    // the moment the two used different Voices.
    const h = harness()
    insertProject(h.db, 'p2')
    upsertPart(h.db, { projectId: 'p2', name: 'gitara' })
    saveProjectVoiceSettings(h.db, 'p1', {
      voice: 'en_US-amy-medium',
      countdown: null,
      placement: null,
      connector: 'in',
    })
    const sharedByP2 = phraseHash('gitara')
    h.clips.seed(sharedByP2)

    // Asked for from p1, which wants nothing of the sort.
    expect(await h.service.cleanOrphans('p1')).toBe(0)
    expect(await h.clips.hashes()).toEqual([sharedByP2])
    h.db.close()
  })

  it('forgets a row whose file has vanished, without counting it as a clip deleted', async () => {
    // The sweep alone can never reach these: it reasons about hashes listed from
    // the cache directory, so a file removed by some other route leaves a row
    // that nothing would ever look at or delete.
    const h = harness()
    const vanished = phraseHash('gitara')
    recordClip(h.db, { hash: vanished, text: 'gitara za', voice: VOICE, engine: ENGINE_ID }, 400)

    // Zero, not one: the count is clips deleted, and no clip was.
    expect(await h.service.cleanOrphans('p1')).toBe(0)
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM speech_clips').get()).toEqual({ n: 0 })
    expect(h.clips.removeAttempts).toEqual([])
    h.db.close()
  })

  it('never sweeps a countdown number, whatever the countdown is set to', async () => {
    // ADR 0005: numbers are rendered 1..60 unconditionally, so narrowing the
    // countdown is a settings change that can never require a re-render — and
    // must never let a clean throw the other numbers away.
    const h = harness()
    upsertPart(h.db, { projectId: 'p1', name: 'gitara' })
    saveProjectVoiceSettings(h.db, 'p1', {
      voice: null,
      countdown: [3, 2, 1],
      placement: null,
      connector: 'za',
    })
    for (const hash of numberHashes()) h.clips.seed(hash)

    expect(await h.service.cleanOrphans('p1')).toBe(0)
    expect((await h.clips.hashes()).sort()).toEqual(numberHashes().sort())
    h.db.close()
  })

  it('collects the clip of a Part that was deleted', async () => {
    // A rename strands one clip; a deletion strands one and leaves no Part
    // behind to explain it, which is the case nothing else in the app notices.
    const h = harness()
    const part = upsertPart(h.db, { projectId: 'p1', name: 'gitara' })
    recordPartRenders(h.db, 'p1')
    const stranded = phraseHash('gitara')
    h.clips.seed(stranded)
    recordClip(h.db, { hash: stranded, text: 'gitara za', voice: VOICE, engine: ENGINE_ID }, 400)
    deletePart(h.db, part.id)

    expect(await h.service.cleanOrphans('p1')).toBe(1)

    expect(await h.clips.hashes()).toEqual([])
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM speech_clips').get()).toEqual({ n: 0 })
    h.db.close()
  })

  it('collects a deleted Project’s clips while leaving the surviving one’s alone', async () => {
    // The intersection is what protects a shared clip, so the case that matters
    // is the one where the *other* Project stops existing: nothing speaks for it
    // any more, and its audio is exactly what an operator expects to reclaim.
    const h = harness()
    insertProject(h.db, 'p2')
    upsertPart(h.db, { projectId: 'p1', name: 'gitara' })
    upsertPart(h.db, { projectId: 'p2', name: 'refren' })
    const mine = phraseHash('gitara')
    const theirs = phraseHash('refren')
    h.clips.seed(mine)
    h.clips.seed(theirs)
    recordClip(h.db, { hash: theirs, text: 'refren za', voice: VOICE, engine: ENGINE_ID }, 400)
    deleteProject(h.db, 'p2')

    expect(await h.service.cleanOrphans('p1')).toBe(1)

    expect(await h.clips.hashes()).toEqual([mine])
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM speech_clips').get()).toEqual({ n: 0 })
    h.db.close()
  })

  it('collects the whole set the Voice it left behind had rendered', async () => {
    // A Voice change orphans sixty-one clips at once — the phrase and every
    // number — because the Voice is part of each clip's content address. This is
    // the one press of the button that actually frees a meaningful amount.
    const h = harness()
    upsertPart(h.db, { projectId: 'p1', name: 'gitara' })
    const old = [phraseHash('gitara'), ...numberHashes()]
    for (const hash of old) h.clips.seed(hash)
    recordPartRenders(h.db, 'p1')
    // Stale, not missing: the old clip still plays, it just says it in the wrong
    // voice — which is the state the operator is looking at when they clean.
    saveGlobalVoiceSettings(h.db, {
      ...getGlobalVoiceSettings(h.db),
      voice: 'en_US-amy-medium',
    })
    expect((await h.service.status('p1')).parts[0].state).toBe('stale')

    expect(await h.service.cleanOrphans('p1')).toBe(old.length)

    expect(await h.clips.hashes()).toEqual([])
    expect((await h.service.status('p1')).parts[0].state).toBe('missing')
    h.db.close()
  })

  it('keeps the row of a clip it could not delete', async () => {
    // A locked file still exists and still answers a lookup, so forgetting its
    // row would make the index disagree with the disk.
    const h = harness()
    const locked = phraseHash('gitara')
    h.clips.seed(locked)
    recordClip(h.db, { hash: locked, text: 'gitara za', voice: VOICE, engine: ENGINE_ID }, 400)
    h.clips.locked.add(locked)

    expect(await h.service.cleanOrphans('p1')).toBe(0)

    expect(h.clips.removeAttempts).toEqual([locked])
    expect(await h.clips.hashes()).toEqual([locked])
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM speech_clips').get()).toEqual({ n: 1 })
    h.db.close()
  })

  it('refuses while a render is running, and says why', async () => {
    // Nothing may delete from the cache while a batch is writing into it, and
    // someone who pressed a button is owed the reason nothing happened.
    let release = (): void => {}
    const h = harness({
      behaviour: () => 400,
      installVoice: () =>
        new Promise<void>((resolve) => {
          release = () => resolve()
        }),
    })
    upsertPart(h.db, { projectId: 'p1', name: 'gitara' })
    const orphan = phraseHash('obsolete')
    h.clips.seed(orphan)

    const inFlight = h.service.renderMissing('p1')
    // The render is parked inside the voice install, which happens after the
    // `rendering` latch is set and before a single clip is written.
    await vi.waitFor(() => expect(h.statuses).toBeGreaterThan(0))

    await expect(h.service.cleanOrphans('p1')).rejects.toThrow(/render is running/)
    expect(h.clips.removeAttempts).toEqual([])

    release()
    await inFlight
    h.db.close()
  })
})

describe('cleanOrphans against the real cache directory', () => {
  // The memory store cannot catch a filesystem-level bug: the extension
  // filtering, the staged `.part` names `put` leaves in the same directory, and
  // the unlink itself only exist in `cache`/`clip-store`.
  let userData: string

  beforeEach(async () => {
    userData = await mkdtemp(join(tmpdir(), 'shotlister-clips-'))
  })

  afterEach(async () => {
    await rm(userData, { recursive: true, force: true })
  })

  it('unlinks the orphan WAV and nothing else in the directory', async () => {
    const db = openMemoryDb()
    insertProject(db, 'p1')
    const clips = createFileClipStore(userData)
    const service = createRenderService({
      db,
      clips,
      synthesise: createFakeSynthesiser(clips).synthesise,
      installVoice: () => Promise.resolve(),
      isLive: () => false,
    })

    const part = upsertPart(db, { projectId: 'p1', name: 'gitara' })
    const stranded = phraseHash('gitara')
    await clips.put({ hash: stranded }, wavOf(400))
    recordClip(db, { hash: stranded, text: 'gitara za', voice: VOICE, engine: ENGINE_ID }, 400)
    upsertPart(db, { id: part.id, projectId: 'p1', name: 'wokal' })

    const wanted = phraseHash('wokal')
    await clips.put({ hash: wanted }, wavOf(400))
    const number = clipHash('3', VOICE, ENGINE_ID)
    await clips.put({ hash: number }, wavOf(200))

    // A write that crashed part-way leaves one of these behind. It is not a clip
    // — `hashes()` filters it out by extension — so a clean must neither count it
    // nor mistake the hash in its name for a clip that exists.
    const staged = `.${stranded}.a1b2c3d4e5f6.part`
    await writeFile(join(clipsDir(userData), staged), 'half a clip')
    // Nor is anything else an operator may have dropped in the folder.
    await writeFile(join(clipsDir(userData), 'notes.txt'), 'mine')

    expect(await service.cleanOrphans('p1')).toBe(1)

    expect((await readdir(clipsDir(userData))).sort()).toEqual(
      [staged, 'notes.txt', `${wanted}.wav`, `${number}.wav`].sort(),
    )
    expect(db.prepare('SELECT COUNT(*) AS n FROM speech_clips').get()).toEqual({ n: 0 })
    // The clip that survived is still readable, which is the other half of
    // "deleted the right one".
    expect((await clips.read(wanted)).length).toBeGreaterThan(44)
    db.close()
  })

  it('unlinks every file the Voice it left behind had rendered', async () => {
    // Sixty-one real unlinks in one press, which is the only case where this
    // button frees anything worth the operator's attention — and the only one
    // where a per-file failure could quietly leave the cache half-swept.
    const db = openMemoryDb()
    insertProject(db, 'p1')
    const clips = createFileClipStore(userData)
    const service = createRenderService({
      db,
      clips,
      synthesise: createFakeSynthesiser(clips).synthesise,
      installVoice: () => Promise.resolve(),
      isLive: () => false,
    })

    upsertPart(db, { projectId: 'p1', name: 'gitara' })
    const old = [phraseHash('gitara'), ...numberHashes()]
    for (const hash of old) await clips.put({ hash }, wavOf(200))
    recordPartRenders(db, 'p1')

    const other = 'en_US-amy-medium'
    saveGlobalVoiceSettings(db, { ...getGlobalVoiceSettings(db), voice: other })
    // What a render under the new Voice would already have put there.
    const kept = phraseHash('gitara', 'za', other)
    await clips.put({ hash: kept }, wavOf(200))

    expect(await service.cleanOrphans('p1')).toBe(old.length)

    expect(await readdir(clipsDir(userData))).toEqual([`${kept}.wav`])
    db.close()
  })
})
