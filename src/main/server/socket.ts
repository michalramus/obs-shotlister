import { Server } from 'socket.io'
import type { Server as HttpServer } from 'http'
import type { Database } from 'better-sqlite3'
import { getLiveState } from '../ipc/live'
import { listShots } from '../ipc/shots'
import { getRundown } from '../ipc/rundowns'
import { listCameras } from '../ipc/projects'
import type { Rundown, Shot, Camera } from '../../shared/types'

export interface RundownStatePayload {
  rundown: Rundown | null
  shots: Shot[]
  cameras: Camera[]
}

function buildRundownState(db: Database): RundownStatePayload {
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

  const shots = listShots(db, rundownId)
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
        socket.emit('state:rundown', buildRundownState(db))
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

export function broadcastRundownState(io: Server, db: Database): void {
  try {
    io.emit('state:rundown', buildRundownState(db))
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[socket.io] broadcastRundownState error:', err)
  }
}
