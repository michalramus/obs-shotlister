import { describe, it, expect, vi, beforeEach } from 'vitest'

// Module-level mock listeners store
const _mockListeners: Record<string, Array<() => void>> = {}
const mockConnect = vi.fn().mockResolvedValue(undefined)
const mockDisconnect = vi.fn().mockImplementation(() => {
  _mockListeners['ConnectionClosed']?.forEach((cb) => cb())
})
const mockCall = vi.fn()

vi.mock('obs-websocket-js', () => {
  const MockOBSWebSocket = vi.fn().mockImplementation(() => ({
    on: (event: string, cb: () => void) => {
      _mockListeners[event] = _mockListeners[event] ?? []
      _mockListeners[event].push(cb)
    },
    connect: mockConnect,
    disconnect: mockDisconnect,
    call: mockCall,
  }))
  return { default: MockOBSWebSocket }
})

import { createOBSClient } from './client'

describe('OBSClient', () => {
  beforeEach(() => {
    mockConnect.mockResolvedValue(undefined)
    mockDisconnect.mockImplementation(() => {
      _mockListeners['ConnectionClosed']?.forEach((cb) => cb())
    })
    mockCall.mockReset()
  })

  it('starts disconnected', () => {
    const client = createOBSClient()
    expect(client.status).toBe('disconnected')
  })

  it('transitions to connected after connect()', async () => {
    const client = createOBSClient()
    await client.connect('ws://localhost:4455', '')
    expect(client.status).toBe('connected')
  })

  it('transitions to disconnected after disconnect()', async () => {
    const client = createOBSClient()
    await client.connect('ws://localhost:4455', '')
    client.disconnect()
    expect(client.status).toBe('disconnected')
  })

  it('calls onStatusChange listeners in order: connecting, connected, disconnected', async () => {
    const client = createOBSClient()
    const statuses: string[] = []
    client.onStatusChange((s) => statuses.push(s))
    await client.connect('ws://localhost:4455', '')
    client.disconnect()
    expect(statuses).toEqual(['connecting', 'connected', 'disconnected'])
  })

  it('transitions to disconnected on connect error', async () => {
    mockConnect.mockRejectedValueOnce(new Error('Connection refused'))
    const client = createOBSClient()
    await expect(client.connect('ws://localhost:4455', 'wrong')).rejects.toThrow()
    expect(client.status).toBe('disconnected')
  })
})
