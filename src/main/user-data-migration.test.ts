import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { migrateLegacyUserData } from './user-data-migration'

describe('migrateLegacyUserData', () => {
  let parent: string
  let legacy: string
  let current: string

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'userdata-'))
    legacy = join(parent, 'obs-queuer')
    current = join(parent, 'shotlister')
  })

  afterEach(() => {
    rmSync(parent, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function writeLegacy(name: string, contents: string): void {
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, name), contents)
  }

  it('does nothing when there is no previous install', () => {
    migrateLegacyUserData(current)
    expect(existsSync(current)).toBe(false)
  })

  it('moves the previous database under the new name', () => {
    writeLegacy('obs-queuer.db', 'shotlists')

    migrateLegacyUserData(current)

    expect(readFileSync(join(current, 'shotlister.db'), 'utf8')).toBe('shotlists')
    expect(existsSync(join(legacy, 'obs-queuer.db'))).toBe(false)
  })

  it('carries the write-ahead log across with the database', () => {
    // Renaming the database and leaving its -wal behind loses every committed
    // transaction that had not been checkpointed.
    writeLegacy('obs-queuer.db', 'shotlists')
    writeLegacy('obs-queuer.db-wal', 'pending')
    writeLegacy('obs-queuer.db-shm', 'index')

    migrateLegacyUserData(current)

    expect(readFileSync(join(current, 'shotlister.db-wal'), 'utf8')).toBe('pending')
    expect(readFileSync(join(current, 'shotlister.db-shm'), 'utf8')).toBe('index')
  })

  it('moves the rest of the profile, directories included', () => {
    writeLegacy('obs-queuer.db', 'shotlists')
    mkdirSync(join(legacy, 'piper-voices'), { recursive: true })
    writeFileSync(join(legacy, 'piper-voices', 'voice.onnx'), 'model')

    migrateLegacyUserData(current)

    expect(readFileSync(join(current, 'piper-voices', 'voice.onnx'), 'utf8')).toBe('model')
  })

  it('keeps what the new directory already has', () => {
    writeLegacy('obs-queuer.db', 'old')
    mkdirSync(current, { recursive: true })
    writeFileSync(join(current, 'shotlister.db'), 'current')

    migrateLegacyUserData(current)

    expect(readFileSync(join(current, 'shotlister.db'), 'utf8')).toBe('current')
    // The old copy stays where it is rather than being dropped on the floor.
    expect(readFileSync(join(legacy, 'obs-queuer.db'), 'utf8')).toBe('old')
  })

  it('renames a database left under the old name in the current directory', () => {
    mkdirSync(current, { recursive: true })
    writeFileSync(join(current, 'obs-queuer.db'), 'shotlists')

    migrateLegacyUserData(current)

    expect(readFileSync(join(current, 'shotlister.db'), 'utf8')).toBe('shotlists')
  })

  it('runs a second time without changing anything', () => {
    writeLegacy('obs-queuer.db', 'shotlists')

    migrateLegacyUserData(current)
    migrateLegacyUserData(current)

    expect(readFileSync(join(current, 'shotlister.db'), 'utf8')).toBe('shotlists')
  })

  it('starts the app anyway when the old data cannot be moved', () => {
    // A profile the operator cannot write to is not a reason to refuse to
    // start: the app comes up on the new directory and says what it could not
    // carry over.
    writeLegacy('obs-queuer.db', 'shotlists')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    chmodSync(legacy, 0o500)

    try {
      expect(() => migrateLegacyUserData(current)).not.toThrow()
      expect(errors).toHaveBeenCalled()
    } finally {
      chmodSync(legacy, 0o700)
    }
  })
})
