import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { IPC_CHANNELS } from './ipc-contract'

/**
 * The contract is only worth anything if the main process actually registers
 * what it declares. `IpcContract` is erased at build time, so these checks read
 * the registration source directly — a channel declared but never registered
 * would otherwise fail only when a user clicked the thing that calls it.
 */

const root = join(__dirname, '..', '..')
const mainSource = readFileSync(join(root, 'src/main/index.ts'), 'utf-8')
const preloadSource = readFileSync(join(root, 'src/preload/index.ts'), 'utf-8')

function registeredChannels(): string[] {
  return [...mainSource.matchAll(/registerIpcHandler\(\s*'([^']+)'/g)].map((m) => m[1])
}

function preloadChannels(): string[] {
  return [...preloadSource.matchAll(/request\('([^']+)'\)/g)].map((m) => m[1])
}

describe('IPC contract', () => {
  it('declares a unique set of channels', () => {
    expect(new Set(IPC_CHANNELS).size).toBe(IPC_CHANNELS.length)
  })

  it('registers a handler for every declared channel', () => {
    const registered = new Set(registeredChannels())
    const missing = IPC_CHANNELS.filter((c) => !registered.has(c))
    expect(missing).toEqual([])
  })

  it('declares every channel the main process registers', () => {
    const declared = new Set<string>(IPC_CHANNELS)
    const undeclared = registeredChannels().filter((c) => !declared.has(c))
    expect(undeclared).toEqual([])
  })

  it('registers each channel exactly once', () => {
    const counts = new Map<string, number>()
    for (const c of registeredChannels()) counts.set(c, (counts.get(c) ?? 0) + 1)
    expect([...counts].filter(([, n]) => n > 1)).toEqual([])
  })

  it('exposes every declared channel through the preload', () => {
    const exposed = new Set(preloadChannels())
    const missing = IPC_CHANNELS.filter((c) => !exposed.has(c))
    expect(missing).toEqual([])
  })

  it('exposes no channel the contract does not declare', () => {
    const declared = new Set<string>(IPC_CHANNELS)
    const extra = preloadChannels().filter((c) => !declared.has(c))
    expect(extra).toEqual([])
  })

  it('leaves no direct ipcMain.handle calls bypassing the typed wrapper', () => {
    expect(mainSource).not.toMatch(/ipcMain\.handle\(/)
  })

  it('leaves no direct webContents.send calls bypassing the typed wrapper', () => {
    expect(mainSource).not.toMatch(/webContents\.send\(/)
  })
})
