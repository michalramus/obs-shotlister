import { describe, it, expect } from 'vitest'
import express from 'express'
import request from 'supertest'
import router from './routes'

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
})
