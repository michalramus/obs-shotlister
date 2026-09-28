import { describe, it, expect } from 'vitest'
import express from 'express'
import request from 'supertest'
import router from './routes'
import { securityHeaders } from './index'

describe('routes', () => {
  const app = express()
  app.use(express.json())
  app.use(router)

  describe('GET /health', () => {
    it('returns { status: "ok" } with HTTP 200', async () => {
      const res = await request(app).get('/health')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ status: 'ok' })
    })
  })

  describe('security headers', () => {
    const guarded = express()
    guarded.use(securityHeaders)
    guarded.use(router)

    it('sends a CSP that confines the phone UI to its own origin', async () => {
      const res = await request(guarded).get('/health')
      const csp = res.headers['content-security-policy'] ?? ''
      expect(csp).toContain("default-src 'self'")
      expect(csp).toContain("object-src 'none'")
      expect(csp).toContain("frame-ancestors 'none'")
      // socket.io upgrades to a websocket, so this one has to be allowed.
      expect(csp).toContain('connect-src')
    })

    it('sends the companion hardening headers', async () => {
      const res = await request(guarded).get('/health')
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['referrer-policy']).toBe('no-referrer')
    })
  })
})
