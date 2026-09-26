import { describe, it, expect } from 'vitest'
import { API_SURFACE, isPushLeaf } from '../shared/ipc-contract'
import type {
  IpcChannel,
  IpcPushChannel,
  Request,
  Subscribe,
  SurfaceNode,
} from '../shared/ipc-contract'
import { buildApi } from './build-api'

/**
 * The walk is what replaced a preload that named all ninety-odd channels by hand,
 * and it is the one thing about the exposure the compiler cannot check: `buildApi`
 * asserts its result is an `ElectronApi`, because TypeScript will not verify a
 * recursive walk against a conditional type. So the shape is checked here instead.
 */

interface Made {
  kind: 'request' | 'subscribe'
  channel: string
}

/** What each built function was made from, keyed by the function itself. */
const made = new Map<unknown, Made>()

/**
 * A stand-in leaf. Returned as `unknown` so each factory can name the leaf type it
 * owes the walk: nothing here behaves like a real request or subscription, and the
 * walk only ever moves these functions around.
 */
function stub(kind: Made['kind'], channel: string): unknown {
  const fn = (): undefined => undefined
  made.set(fn, { kind, channel })
  return fn
}

const api = buildApi({
  request: <C extends IpcChannel>(channel: C) => stub('request', channel) as Request<C>,
  subscribe: <C extends IpcPushChannel>(channel: C) => stub('subscribe', channel) as Subscribe<C>,
})

/** Every leaf the surface declares, as a dotted api path. */
function surfaceLeaves(node: SurfaceNode, path: string[], into: Map<string, Made>): void {
  if (typeof node === 'string') {
    into.set(path.join('.'), { kind: 'request', channel: node })
    return
  }
  if (isPushLeaf(node)) {
    into.set(path.join('.'), { kind: 'subscribe', channel: node.push })
    return
  }
  for (const [name, child] of Object.entries(node)) surfaceLeaves(child, [...path, name], into)
}

/** Every leaf the built api actually has, as a dotted path. */
function builtLeaves(value: unknown, path: string[], into: Map<string, Made>): void {
  if (typeof value === 'function') {
    const origin = made.get(value)
    if (origin) into.set(path.join('.'), origin)
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [name, child] of Object.entries(value)) builtLeaves(child, [...path, name], into)
}

describe('buildApi', () => {
  it('builds one leaf per surface entry, from the right channel and factory', () => {
    const expected = new Map<string, Made>()
    surfaceLeaves(API_SURFACE, [], expected)
    const actual = new Map<string, Made>()
    builtLeaves(api, [], actual)
    expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(expected))
  })

  it('nests groups rather than flattening them', () => {
    expect(typeof api.rundowns.deleteFolder).toBe('function')
    expect(made.get(api.rundowns.deleteFolder)?.channel).toBe('rundowns:deleteFolder')
  })

  it('exposes an ungrouped leaf as a function on the root', () => {
    expect(made.get(api.mediaFileExists)?.channel).toBe('media:file-exists')
  })

  it('tells a push leaf from a request channel of the same name', () => {
    expect(made.get(api.obs.getStatus)).toEqual({ kind: 'request', channel: 'obs:status' })
    expect(made.get(api.obs.onStatusChange)).toEqual({ kind: 'subscribe', channel: 'obs:status' })
  })
})
