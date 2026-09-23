import { Server } from 'socket.io'
import type { Server as HttpServer } from 'http'
import type { Database } from 'better-sqlite3'
import type { LiveSession } from '../live/session'
import { listShots } from '../ipc/shots'
import { getRundown } from '../ipc/rundowns'
import { listCameras } from '../ipc/projects'
import { listParts } from '../ipc/parts'
import type { Rundown, Shot, Camera, Part } from '../../shared/types'

/**
 * Everything a phone needs to draw the Rundown, fully resolved (ADR 0003).
 *
 * `cameras` and `parts` are both carried because the Rundown's `kind` decides
 * which one its items point at: a Camera Rundown is filtered by Camera, and a
 * Voice-over Rundown is shown unfiltered because there is nothing to filter by.
 * The Cue Tray reads the same payload and goes silent on `kind: 'voice'`.
 */
export interface RundownStatePayload {
  rundown: Rundown | null
  shots: Shot[]
  cameras: Camera[]
  parts: Part[]
}

function buildRundownState(
  db: Database,
  session: LiveSession,
  shotsOverride?: Shot[],
): RundownStatePayload {
  const liveState = session.getState()
  const rundownId = liveState.rundownId
  if (!rundownId) {
    if (liveState.projectId) {
      const cameras = listCameras(db, liveState.projectId)
      const parts = listParts(db, liveState.projectId)
      return { rundown: null, shots: [], cameras, parts }
    }
    return { rundown: null, shots: [], cameras: [], parts: [] }
  }

  const rundown = getRundown(db, rundownId)
  if (!rundown) return { rundown: null, shots: [], cameras: [], parts: [] }

  const shots = shotsOverride ?? listShots(db, rundownId)
  const cameras = listCameras(db, rundown.projectId)
  // Every Part the Project owns, not just those in the Rundown's picker scope:
  // a Call's Part is a hard foreign key and may sit outside scope, and a phone
  // that cannot name a Call is worse than one carrying a few unused Parts.
  const parts = listParts(db, rundown.projectId)
  return { rundown, shots, cameras, parts }
}

export function attachSocketServer(
  httpServer: HttpServer,
  db?: Database,
  session?: LiveSession,
): Server {
  const io = new Server(httpServer, {
    cors: { origin: '*' },
  })

  io.on('connection', (socket) => {
    // eslint-disable-next-line no-console
    console.info(`[socket.io] client connected: ${socket.id}`)

    if (db && session) {
      try {
        const liveState = session.getState()
        socket.emit('state:live', {
          liveIndex: liveState.liveIndex,
          elapsedMs: liveState.startedAt !== null ? Date.now() - liveState.startedAt : null,
        })
        socket.emit('state:playback', { running: liveState.running })

        const shotsOverride =
          session.getQueue().length > 0 ? session.getShotsWithHiddenFlags() : undefined
        socket.emit('state:rundown', buildRundownState(db, session, shotsOverride))
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[socket.io] error sending initial state:', err)
      }
    }

    socket.on('disconnect', () => {
      // eslint-disable-next-line no-console
      console.info(`[socket.io] client disconnected: ${socket.id}`)
    })
  })

  return io
}

export function broadcastShotHidden(io: Server, shotId: string): void {
  try {
    io.emit('state:shot:hidden', { shotId })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[socket.io] broadcastShotHidden error:', err)
  }
}

export function broadcastRundownState(
  io: Server,
  db: Database,
  session: LiveSession,
  shotsOverride?: Shot[],
): void {
  try {
    io.emit('state:rundown', buildRundownState(db, session, shotsOverride))
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[socket.io] broadcastRundownState error:', err)
  }
}
