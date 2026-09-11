import express from 'express'
import { createServer } from 'http'
import { join } from 'path'
import { existsSync } from 'fs'
import routes from './routes'
import { attachSocketServer } from './socket'
import type { Server as SocketServer } from 'socket.io'
import type { Database } from 'better-sqlite3'

const PORT = process.env['PORT'] ? parseInt(process.env['PORT'], 10) : 3000

export function startServer(
  db?: Database,
  audioDir?: string,
  onError?: (message: string) => void,
): SocketServer {
  const app = express()

  app.use(express.json())
  app.use(routes)

  if (audioDir) {
    app.use('/audio', express.static(audioDir))
  }

  // Serve the compiled web UI bundle (out/web/).
  // Run `yarn build:web` once to generate it; the bundle then works in both dev and prod.
  const webDir = join(__dirname, '../web')
  if (existsSync(webDir)) {
    app.use(express.static(webDir))
    // SPA fallback: serve index.html for any route not matched by static files or API
    app.get('*', (_req, res) => {
      res.sendFile(join(webDir, 'index.html'))
    })
  }

  const httpServer = createServer(app)

  const io = attachSocketServer(httpServer, db)

  // listen() reports failures via 'error', not a throw — without this an
  // EADDRINUSE reaches uncaughtException and the app runs with no phone server.
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    const detail =
      err.code === 'EADDRINUSE'
        ? `port ${PORT} is already in use — phone UI unavailable. Set PORT to use another port.`
        : err.message
    // eslint-disable-next-line no-console
    console.error(`[server] ${detail}`, err)
    onError?.(detail)
  })

  httpServer.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.info(`[server] listening on http://localhost:${PORT}`)
  })

  return io
}
