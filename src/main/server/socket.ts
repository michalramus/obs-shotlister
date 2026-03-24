import { Server } from 'socket.io'
import type { Server as HttpServer } from 'http'
import type { Database } from 'better-sqlite3'
import { getLiveState, getLiveQueue } from '../ipc/live'
import { listShots } from '../ipc/shots'
import { getRundown } from '../ipc/rundowns'
import { listCameras } from '../ipc/projects'
import type { Rundown, Shot, Camera } from '../../shared/types'

export interface RundownStatePayload {
  rundown: Rundown | null
  shots: Shot[]
  cameras: Camera[]
}

function buildRundownState(db: Database, shotsOverride?: Shot[]): RundownStatePayload {
  const liveState = getLiveState(db)
  const rundownId = liveState.rundownId
  if (!rundownId) {
    if (liveState.projectId) {
      const cameras = listCameras(db, liveState.projectId)
      return { rundown: null, shots: [], cameras }
    }
    return { rundown: null, shots: [], cameras: [] }
  }

  const rundown = getRundown(db, rundownId)
  if (!rundown) return { rundown: null, shots: [], cameras: [] }

  const shots = shotsOverride ?? listShots(db, rundownId)
  const cameras = listCameras(db, rundown.projectId)
  return { rundown, shots, cameras }
}

export function attachSocketServer(httpServer: HttpServer, db?: Database): Server {
  const io = new Server(httpServer, {
    cors: { origin: '*' },
  })

  io.on('connection', (socket) => {
    // eslint-disable-next-line no-console
    console.info(`[socket.io] client connected: ${socket.id}`)

    if (db) {
      try {
        const liveState = getLiveState(db)
        socket.emit('state:live', {
          liveIndex: liveState.liveIndex,
          startedAt: liveState.startedAt,
        })
        socket.emit('state:playback', { running: liveState.running })

        let shotsOverride: Shot[] | undefined
        if (getLiveQueue().length > 0 && liveState.rundownId) {
          const hiddenIds = new Set(getLiveQueue().filter((s) => s.hidden).map((s) => s.id))
          shotsOverride = listShots(db, liveState.rundownId).map((s) => ({ ...s, hidden: hiddenIds.has(s.id) }))
        }
        socket.emit('state:rundown', buildRundownState(db, shotsOverride))
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

export function broadcastRundownState(io: Server, db: Database, shotsOverride?: Shot[]): void {
  try {
    io.emit('state:rundown', buildRundownState(db, shotsOverride))
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[socket.io] broadcastRundownState error:', err)
  }
}
