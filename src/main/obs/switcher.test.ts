import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db/index'
import { createOBSSwitcher } from './switcher'
import { createLiveSession, type LiveSession } from '../live/session'
import type { OBSClient } from './client'

/**
 * Every write this switcher can make to OBS, recorded rather than sent.
 *
 * A Voice-over Rundown must not be able to disturb a live video feed, and the
 * only way to prove that is to count the calls: reading the guards proves the
 * guards exist, not that nothing slips past them.
 */
interface RecordingClient extends OBSClient {
  calls: string[]
}

function fakeClient(status: OBSClient['status'] = 'connected'): RecordingClient {
  const calls: string[] = []
  return {
    calls,
    status,
    connect: async () => {},
    disconnect: () => {},
    setCurrentProgramScene: async (scene) => {
      calls.push(`program:${scene}`)
    },
    setCurrentPreviewScene: async (scene) => {
      calls.push(`preview:${scene}`)
    },
    getSceneList: async () => [],
    getTransitionList: async () => [],
    setCurrentSceneTransition: async (name) => {
      calls.push(`transition:${name}`)
    },
    triggerStudioModeTransition: async () => {
      calls.push('trigger')
    },
    getStudioModeEnabled: async () => true,
    onStatusChange: () => {},
    onOBSEvent: () => {},
  }
}

function openMemoryDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  return db
}

/** A Rundown of the given Kind, with every item assigned so it can go live. */
function seed(db: Database.Database, kind: 'camera' | 'voice'): void {
  db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('p1', 'P', 1)
  db.prepare(
    'INSERT INTO cameras (id, project_id, number, name, color, obs_scene) VALUES (?,?,?,?,?,?)',
  ).run('c1', 'p1', 1, 'Wide', '#f00', 'Scene 1')
  db.prepare('INSERT INTO parts (id, project_id, number, name, color) VALUES (?,?,?,?,?)').run(
    'pt1',
    'p1',
    1,
    'gitara',
    '#0f0',
  )
  db.prepare(
    'INSERT INTO rundowns (id, project_id, name, created_at, kind) VALUES (?,?,?,?,?)',
  ).run('rd1', 'p1', 'Song', 1, kind)

  // Both targets filled, as they are after a conversion away and back — so a
  // leftover camera_id is present to tempt the switcher.
  for (let i = 0; i < 2; i++) {
    db.prepare(
      'INSERT INTO shots (id, rundown_id, camera_id, part_id, duration_ms, order_index, transition_ms) VALUES (?,?,?,?,?,?,?)',
    ).run(`s${i}`, 'rd1', 'c1', 'pt1', 5000, i, 0)
  }
}

describe('OBS switcher and Rundown Kind', () => {
  let db: Database.Database
  let session: LiveSession
  let client: RecordingClient

  beforeEach(() => {
    db = openMemoryDb()
    client = fakeClient()
  })

  afterEach(() => {
    db.close()
  })

  function start(kind: 'camera' | 'voice'): ReturnType<typeof createOBSSwitcher> {
    seed(db, kind)
    session = createLiveSession(db)
    const switcher = createOBSSwitcher(db, client, session)
    session.setActiveProject('p1')
    session.start('rd1')
    return switcher
  }

  it('drives OBS through a Camera Rundown', async () => {
    const switcher = start('camera')
    await switcher.takeLiveShot()
    await switcher.cueNextShot()
    await switcher.cueRundownStart('rd1')
    await switcher.startFromPreview()

    // Studio mode: the Shot is cued to preview and transitioned to program,
    // rather than cut straight to program.
    expect(client.calls).toContain('preview:Scene 1')
    expect(client.calls).toContain('trigger')
  })

  it('never contacts OBS in a Voice-over Rundown', async () => {
    const switcher = start('voice')
    await switcher.takeLiveShot()
    await switcher.cueNextShot()
    await switcher.cueRundownStart('rd1')
    await switcher.startFromPreview()

    expect(client.calls).toEqual([])
  })

  it('cues nothing for a voice Rundown that is not even running', async () => {
    seed(db, 'voice')
    session = createLiveSession(db)
    const switcher = createOBSSwitcher(db, client, session)

    // The path taken when the operator merely selects a Rundown.
    await switcher.cueRundownStart('rd1')
    expect(client.calls).toEqual([])
  })

  it('stays off OBS when the Rundown cannot be resolved', async () => {
    seed(db, 'camera')
    session = createLiveSession(db)
    const switcher = createOBSSwitcher(db, client, session)

    await switcher.cueRundownStart('no-such-rundown')
    expect(client.calls).toEqual([])
  })
})
