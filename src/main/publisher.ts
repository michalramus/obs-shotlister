/**
 * Tells everyone who needs to know that something changed.
 *
 * Handlers report *what happened*; this module decides who hears about it and in
 * what shape. There are two audiences — phones over socket.io and the operator
 * window over IPC — and which of them cares about a given change is knowledge
 * that belongs here, not at each of the thirty-odd places state is mutated.
 *
 * See docs/adr/0003: pushing resolved state to phones is a correctness concern,
 * so a change that reaches no audience is a bug rather than a missed nicety.
 */

import type { Server as SocketServer } from 'socket.io'
import type Database from 'better-sqlite3'
import type { LiveState } from '../shared/ipc-contract'
import type { LiveSession } from './live/session'
import { broadcastRundownState, broadcastShotHidden } from './server/socket'
import { pushToWindow } from './ipc/register'

export interface ChangePublisher {
  /** The Rundown's content changed: its Shots, its name, or which one is active. */
  rundownChanged: () => void
  /** The Live session moved: started, advanced, restarted or stopped. */
  liveStateChanged: (state: LiveState) => void
  /** A Shot left the Live queue, by going on air or being skipped. */
  shotHidden: (shotId: string) => void
}

export function createChangePublisher(
  db: Database.Database,
  session: LiveSession,
  getIo: () => SocketServer | null,
): ChangePublisher {
  return {
    rundownChanged() {
      const io = getIo()
      if (!io) return
      // Phones see the Rundown as the Live queue sees it, hidden flags applied.
      const shots = session.getQueue().length > 0 ? session.getShotsWithHiddenFlags() : undefined
      broadcastRundownState(io, db, session, shots)
    },

    liveStateChanged(state) {
      const io = getIo()
      if (io) {
        // Phones get elapsed rather than a timestamp: their clocks are not ours.
        io.emit('state:live', {
          liveIndex: state.liveIndex,
          elapsedMs: state.startedAt !== null ? Date.now() - state.startedAt : null,
        })
        io.emit('state:playback', { running: state.running })
      }
      pushToWindow('live:state-push', state)
    },

    shotHidden(shotId) {
      const io = getIo()
      if (io) broadcastShotHidden(io, shotId)
      pushToWindow('live:shot-hidden-push', shotId)
    },
  }
}
