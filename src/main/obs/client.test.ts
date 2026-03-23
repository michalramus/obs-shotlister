import { describe, it, expect } from 'vitest'
import { createOBSClient } from './client'

describe('createOBSClient', () => {
  it('starts with disconnected status', () => {
    const client = createOBSClient()
    expect(client.status).toBe('disconnected')
  })

  it('sets status to connecting when connect is called', async () => {
    const client = createOBSClient()
    await client.connect('ws://localhost:4455')
    expect(client.status).toBe('connecting')
  })

  it('resets status to disconnected when disconnect is called', async () => {
    const client = createOBSClient()
    await client.connect('ws://localhost:4455')
    client.disconnect()
    expect(client.status).toBe('disconnected')
  })
})
