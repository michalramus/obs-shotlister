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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db/index'
import { DEFAULT_VOICE, saveGlobalVoiceSettings, getGlobalVoiceSettings } from '../ipc/settings'
import { upsertPart } from '../ipc/parts'
import { recordPartRenders } from '../ipc/speech'
import { ENGINE_ID, clipHash, partPhrase } from '../../shared/render-plan'
import { numberTexts } from '../../shared/number-text'
import { EngineUnusableError } from './batch'
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
