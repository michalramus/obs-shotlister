import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { openMemoryDb } from '../db/memory-db.fixture'
import { defaultAudioOutputs } from '../../shared/audio/outputs'
import {
  getGlobalVoiceSettings,
  saveGlobalVoiceSettings,
  getProjectVoiceSettings,
  saveProjectVoiceSettings,
  getEffectiveVoiceSettings,
  getAudioDevices,
  saveAudioDevices,
  migrateAudioDevices,
  DEFAULT_VOICE,
  DEFAULT_CONNECTOR,
  MAX_OUTPUT_DELAY_MS,
  MIN_OUTPUT_DELAY_MS,
} from './settings'

function readKey(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value
}

describe('voice settings', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
  })

  afterEach(() => {
    db.close()
  })

  it('defaults to flush placement, manual rendering and the standard countdown', () => {
    expect(getGlobalVoiceSettings(db)).toEqual({
      voice: DEFAULT_VOICE,
      countdown: [10, 5, 3, 2, 1],
      placement: 'flush',
      autoRender: false,
    })
  })

  it('round-trips the global settings', () => {
    saveGlobalVoiceSettings(db, {
      voice: 'en_US-amy-medium',
      countdown: [8, 4, 1],
      placement: 'immediate',
      autoRender: true,
    })
    expect(getGlobalVoiceSettings(db)).toEqual({
      voice: 'en_US-amy-medium',
      countdown: [8, 4, 1],
      placement: 'immediate',
      autoRender: true,
    })
  })

  it('reads a corrupt countdown as unset rather than throwing', () => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'voice_countdown',
      'not,a,countdown',
    )
    expect(getGlobalVoiceSettings(db).countdown).toEqual([10, 5, 3, 2, 1])
  })

  it('drops countdown numbers outside the rendered 1..60 range', () => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'voice_countdown',
      '90,10,0,3',
    )
    expect(getGlobalVoiceSettings(db).countdown).toEqual([10, 3])
  })

  it('leaves a Project overriding nothing by default', () => {
    expect(getProjectVoiceSettings(db, 'p1')).toEqual({
      voice: null,
      countdown: null,
      placement: null,
      connector: DEFAULT_CONNECTOR,
    })
  })

  it('falls back to the global settings where the Project overrides nothing', () => {
    saveGlobalVoiceSettings(db, {
      voice: 'pl_PL-gosia-medium',
      countdown: [10, 5, 1],
      placement: 'flush',
      autoRender: false,
    })
    saveProjectVoiceSettings(db, 'p1', {
      voice: null,
      countdown: null,
      placement: null,
      connector: 'za',
    })
    expect(getEffectiveVoiceSettings(db, 'p1')).toEqual({
      voice: 'pl_PL-gosia-medium',
      countdown: [10, 5, 1],
      placement: 'flush',
      connector: 'za',
    })
  })

  it('lets a Project override the Voice, countdown and placement', () => {
    saveGlobalVoiceSettings(db, {
      voice: 'pl_PL-gosia-medium',
      countdown: [10, 5, 1],
      placement: 'flush',
      autoRender: false,
    })
    saveProjectVoiceSettings(db, 'p1', {
      voice: 'en_US-amy-medium',
      countdown: [20, 10],
      placement: 'immediate',
      connector: 'in',
    })
    expect(getEffectiveVoiceSettings(db, 'p1')).toEqual({
      voice: 'en_US-amy-medium',
      countdown: [20, 10],
      placement: 'immediate',
      connector: 'in',
    })
  })

  it('keeps one Project’s overrides out of another’s', () => {
    saveProjectVoiceSettings(db, 'p1', {
      voice: 'en_US-amy-medium',
      countdown: null,
      placement: null,
      connector: 'in',
    })
    expect(getEffectiveVoiceSettings(db, 'p2').voice).toBe(DEFAULT_VOICE)
    expect(getEffectiveVoiceSettings(db, 'p2').connector).toBe(DEFAULT_CONNECTOR)
  })

  it('clears an override when it is saved back as null', () => {
    saveProjectVoiceSettings(db, 'p1', {
      voice: 'en_US-amy-medium',
      countdown: [3],
      placement: 'immediate',
      connector: 'in',
    })
    saveProjectVoiceSettings(db, 'p1', {
      voice: null,
      countdown: null,
      placement: null,
      connector: 'in',
    })
    expect(getProjectVoiceSettings(db, 'p1')).toEqual({
      voice: null,
      countdown: null,
      placement: null,
      connector: 'in',
    })
  })
})

describe('output delays', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
  })

  afterEach(() => {
    db.close()
  })

  it('defaults to no delay, which is what a local speaker has', () => {
    expect(getAudioDevices(db).outputs.map((o) => o.delayMs)).toEqual([0, 0])
  })

  it('round-trips a delay per Output, positive and negative', () => {
    saveAudioDevices(db, {
      outputs: [
        { enabled: true, sinkId: 'speakers', delayMs: -120, carries: 'cues' },
        { enabled: true, sinkId: 'cable', delayMs: 350, carries: 'voice' },
      ],
    })
    expect(getAudioDevices(db).outputs.map((o) => o.delayMs)).toEqual([-120, 350])
  })

  it('reads a corrupt delay as none rather than throwing', () => {
    // A bad setting must not be able to stop a show from starting.
    saveAudioDevices(db, { outputs: defaultAudioOutputs() })
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'audio_output1_delay',
      'soon',
    )
    expect(getAudioDevices(db).outputs[0].delayMs).toBe(0)
  })

  it('clamps a delay that would mute everything it moved', () => {
    saveAudioDevices(db, { outputs: defaultAudioOutputs() })
    const write = (value: string): void => {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
        'audio_output2_delay',
        value,
      )
    }

    write('999999')
    expect(getAudioDevices(db).outputs[1].delayMs).toBe(MAX_OUTPUT_DELAY_MS)

    write('-999999')
    expect(getAudioDevices(db).outputs[1].delayMs).toBe(MIN_OUTPUT_DELAY_MS)
  })
})

describe('outputs', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
  })

  afterEach(() => {
    db.close()
  })

  it('starts audible: one output carrying everything on the system default', () => {
    expect(getAudioDevices(db)).toEqual({
      outputs: [
        { enabled: true, sinkId: null, delayMs: 0, carries: 'both' },
        { enabled: false, sinkId: null, delayMs: 0, carries: 'voice' },
      ],
    })
  })

  it('round-trips both outputs', () => {
    const outputs = [
      { enabled: true, sinkId: 'speakers', delayMs: 0, carries: 'cues' },
      { enabled: true, sinkId: 'shotlister-out', delayMs: 400, carries: 'both' },
    ] as const
    saveAudioDevices(db, { outputs: [...outputs] })
    expect(getAudioDevices(db).outputs).toEqual([...outputs])
  })

  it('remembers that output 2 was switched off again', () => {
    // Off must survive a restart as deliberately as on does: a Cue arriving on
    // the band's intercom because a stored 'true' outlived the operator turning
    // it off is the one failure this setting cannot have.
    saveAudioDevices(db, {
      outputs: [
        { enabled: true, sinkId: null, delayMs: 0, carries: 'cues' },
        { enabled: false, sinkId: 'shotlister-out', delayMs: 400, carries: 'voice' },
      ],
    })
    expect(getAudioDevices(db).outputs[1]).toEqual({
      enabled: false,
      // Kept, so switching it back on does not ask which device again.
      sinkId: 'shotlister-out',
      delayMs: 400,
      carries: 'voice',
    })
  })

  it('keeps output 1 enabled whatever is stored', () => {
    saveAudioDevices(db, { outputs: defaultAudioOutputs() })
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'audio_output1_enabled',
      'false',
    )
    expect(getAudioDevices(db).outputs[0].enabled).toBe(true)
  })

  it('reads a corrupt carries value as never stored, so the defaults stand', () => {
    saveAudioDevices(db, {
      outputs: [
        { enabled: true, sinkId: 'speakers', delayMs: 0, carries: 'cues' },
        { enabled: false, sinkId: null, delayMs: 0, carries: 'voice' },
      ],
    })
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'audio_output1_carries',
      'everything',
    )
    expect(getAudioDevices(db).outputs[0].carries).toBe('both')
  })
})

describe('migrating the fixed destinations to two Outputs', () => {
  let db: Database.Database

  function writeLegacy(entries: Record<string, string>): void {
    for (const [key, value] of Object.entries(entries)) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
    }
  }

  beforeEach(() => {
    db = openMemoryDb()
  })

  afterEach(() => {
    db.close()
  })

  it('reads an un-migrated install the way the migration will write it', () => {
    // The reader falls back rather than writing, so settings can be read during a
    // Live session without touching the database.
    writeLegacy({ audio_cue_sink: 'speakers', audio_announcement_sink: 'cable' })
    const before = getAudioDevices(db)

    migrateAudioDevices(db)

    expect(getAudioDevices(db)).toEqual(before)
  })

  it('gives output 1 the cue device and output 2 the announcement device and delay', () => {
    writeLegacy({
      audio_cue_sink: 'speakers',
      audio_announcement_sink: 'cable',
      voice_transmission_delay: '400',
    })

    migrateAudioDevices(db)

    expect(getAudioDevices(db).outputs).toEqual([
      { enabled: true, sinkId: 'speakers', delayMs: 0, carries: 'cues' },
      { enabled: true, sinkId: 'cable', delayMs: 400, carries: 'voice' },
    ])
  })

  it('carries both on one output when the old settings named one destination', () => {
    // Cues and Announcements on the same device with no delay is one Output's
    // worth of intent; splitting it would leave Announcements carried by nothing.
    writeLegacy({ audio_cue_sink: 'speakers', audio_announcement_sink: 'speakers' })

    migrateAudioDevices(db)

    expect(getAudioDevices(db).outputs).toEqual([
      { enabled: true, sinkId: 'speakers', delayMs: 0, carries: 'both' },
      { enabled: false, sinkId: 'speakers', delayMs: 0, carries: 'voice' },
    ])
  })

  it('keeps a delay alive even when both devices were the system default', () => {
    writeLegacy({ voice_transmission_delay: '250' })

    migrateAudioDevices(db)

    expect(getAudioDevices(db).outputs).toEqual([
      { enabled: true, sinkId: null, delayMs: 0, carries: 'cues' },
      { enabled: true, sinkId: null, delayMs: 250, carries: 'voice' },
    ])
  })

  it('drops the old keys, so they are never reinterpreted', () => {
    writeLegacy({
      audio_cue_sink: 'speakers',
      audio_announcement_sink: 'cable',
      audio_intercom_enabled: 'true',
      audio_intercom_sink: 'shotlister-out',
      voice_transmission_delay: '400',
    })

    migrateAudioDevices(db)

    const rows = db
      .prepare(
        "SELECT key FROM settings WHERE key LIKE 'audio_%' OR key = 'voice_transmission_delay'",
      )
      .all() as { key: string }[]
    expect(rows.map((r) => r.key).sort()).toEqual([
      'audio_output1_carries',
      'audio_output1_delay',
      'audio_output1_sink',
      'audio_output2_carries',
      'audio_output2_delay',
      'audio_output2_enabled',
      'audio_output2_sink',
    ])
  })

  it('leaves a fresh install alone rather than writing defaults over it', () => {
    migrateAudioDevices(db)

    expect(readKey(db, 'audio_output1_carries')).toBeUndefined()
    expect(getAudioDevices(db)).toEqual({ outputs: defaultAudioOutputs() })
  })

  it('never runs twice over settings the operator has since changed', () => {
    writeLegacy({ audio_cue_sink: 'speakers' })
    migrateAudioDevices(db)
    saveAudioDevices(db, {
      outputs: [
        { enabled: true, sinkId: 'headphones', delayMs: 0, carries: 'both' },
        { enabled: false, sinkId: null, delayMs: 0, carries: 'voice' },
      ],
    })
    writeLegacy({ audio_cue_sink: 'speakers' })

    migrateAudioDevices(db)

    expect(getAudioDevices(db).outputs[0].sinkId).toBe('headphones')
  })
})
