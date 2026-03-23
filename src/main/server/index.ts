import express from 'express'
import { createServer } from 'http'
import { join } from 'path'
import routes from './routes'
import { attachWebSocketServer } from './ws'

const PORT = process.env['PORT'] ? parseInt(process.env['PORT'], 10) : 3000

export function startServer(): void {
  const app = express()

  app.use(express.json())
  app.use(routes)

  // Serve the compiled web UI bundle (out/web/) in production.
  // In dev the Vite dev server for src/web/ runs separately on its own port.
  if (process.env['NODE_ENV'] !== 'development') {
    app.use(express.static(join(__dirname, '../../web')))
  } else {
    // In dev, proxy or redirect to the Vite web dev server if needed.
    // For now the web UI Vite dev server runs on its own port (see vite.config.web.ts).
  }

  const httpServer = createServer(app)

  attachWebSocketServer(httpServer)

  httpServer.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.info(`[server] listening on http://localhost:${PORT}`)
  })
}
