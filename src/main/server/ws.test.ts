import { describe, it, expect, afterEach } from 'vitest'
import { createServer } from 'http'
import WebSocket from 'ws'
import { attachWebSocketServer } from './ws'

describe('attachWebSocketServer', () => {
  const closeables: Array<{ close: () => void }> = []

  afterEach(() => {
    for (const s of closeables) {
      s.close()
    }
    closeables.length = 0
  })

  it('returns a WebSocketServer', () => {
    const httpServer = createServer()
    const wss = attachWebSocketServer(httpServer)
    closeables.push(httpServer, wss)
    expect(wss).toBeDefined()
    expect(typeof wss.on).toBe('function')
  })

  it('sends initial state message on client connect', async () => {
    const httpServer = createServer()
    const wss = attachWebSocketServer(httpServer)
    closeables.push(httpServer, wss)

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', resolve)
    })

    const addr = httpServer.address()
    if (!addr || typeof addr === 'string') throw new Error('unexpected address')

    const received = await new Promise<string>((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${addr.port}`)
      client.once('message', (data) => {
        client.close()
        resolve(data.toString())
      })
      client.once('error', reject)
    })

    const message = JSON.parse(received) as unknown
    expect(message).toEqual({ type: 'state', payload: {} })
  })
})
