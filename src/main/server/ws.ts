import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'http'

export function attachWebSocketServer(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer })

  wss.on('connection', (socket: WebSocket) => {
    const initialState = JSON.stringify({ type: 'state', payload: {} })
    socket.send(initialState)
  })

  return wss
}
