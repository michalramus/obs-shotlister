import { Server } from 'node-osc'

let oscServer: Server | null = null

export function startOscServer(
  port: number,
  on: { next: () => void; skip: () => void },
): void {
  stopOscServer()
  try {
    oscServer = new Server(port, '0.0.0.0', () => {
      console.info(`[osc] listening on port ${port}`)
    })
    oscServer.on('message', (msg: unknown[]) => {
      const address = msg[0] as string
      if (address === '/next') on.next()
      else if (address === '/skip') on.skip()
    })
  } catch (err) {
    console.error('[osc] failed to start server:', err)
  }
}

export function stopOscServer(): void {
  if (oscServer) {
    try {
      oscServer.close()
    } catch (err) {
      console.error('[osc] close error:', err)
    }
    oscServer = null
  }
}
