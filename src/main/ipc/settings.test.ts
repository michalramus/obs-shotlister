import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db/index'
import {
  getGlobalVoiceSettings,
  saveGlobalVoiceSettings,
  getProjectVoiceSettings,
  saveProjectVoiceSettings,
  getEffectiveVoiceSettings,
  getAudioDevices,
  saveAudioDevices,
  DEFAULT_VOICE,
  DEFAULT_CONNECTOR,
} from './settings'

function openMemoryDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  return db
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

describe('audio devices', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb()
  })

  afterEach(() => {
    db.close()
  })

  it('defaults both outputs to the system default', () => {
    expect(getAudioDevices(db)).toEqual({ cueSinkId: null, announcementSinkId: null })
  })

  it('keeps the two outputs independent', () => {
    saveAudioDevices(db, { cueSinkId: 'speakers', announcementSinkId: 'virtual-cable' })
    expect(getAudioDevices(db)).toEqual({
      cueSinkId: 'speakers',
      announcementSinkId: 'virtual-cable',
    })

    saveAudioDevices(db, { cueSinkId: 'speakers', announcementSinkId: null })
    expect(getAudioDevices(db)).toEqual({ cueSinkId: 'speakers', announcementSinkId: null })
  })
})
