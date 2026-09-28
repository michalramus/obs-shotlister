import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import { createServer } from 'http'
import { join } from 'path'
import { existsSync } from 'fs'
import routes from './routes'
import { attachSocketServer } from './socket'
import type { Server as SocketServer } from 'socket.io'
import type { Database } from 'better-sqlite3'
import type { LiveSession } from '../live/session'

// A bad PORT used to reach listen() as NaN, which throws synchronously and
// took the whole startup sequence down with it.
function resolvePort(raw: string | undefined): number {
  if (!raw) return 3000
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    console.error(`[server] ignoring invalid PORT ${JSON.stringify(raw)} — using 3000`)
    return 3000
  }
  return parsed
}

const PORT = resolvePort(process.env['PORT'])

/**
 * Security headers for the LAN-facing phone UI.
 *
 * The operator window's CSP is deliberate enough to have its own test
 * (src/renderer/csp.test.ts); this surface had none, though it is the one
 * actually exposed to the network. Everything the phone UI needs is
 * same-origin: its own bundle, its own socket, and audio served from /audio.
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      // The bundle inlines its styles; no external stylesheet is ever loaded.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "media-src 'self'",
      // socket.io negotiates over HTTP, then upgrades to a websocket.
      "connect-src 'self' ws: wss:",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'none'",
    ].join('; '),
  )
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  next()
}

export function startServer(
  db?: Database,
  session?: LiveSession,
  audioDir?: string,
  onError?: (message: string) => void,
): SocketServer {
  const app = express()

  app.use(securityHeaders)
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

  const io = attachSocketServer(httpServer, db, session)

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
