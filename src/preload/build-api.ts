/**
 * Walks `API_SURFACE` into the object the renderer sees.
 *
 * Kept apart from index.ts because that module talks to Electron the moment it
 * loads, and the walk is the one part of the preload that can be wrong on its
 * own: everything else — the method names, the grouping, the channels, the
 * payload and result types — comes from the surface, so a test that exercises
 * this function covers the whole exposure.
 */

import { API_SURFACE, isPushLeaf } from '../shared/ipc-contract'
import type {
  ElectronApi,
  IpcChannel,
  IpcPushChannel,
  Request,
  SurfaceNode,
  Subscribe,
} from '../shared/ipc-contract'

/** Either kind of leaf, seen without its channel's types. */
type Leaf = (...args: never[]) => unknown

type Built = Leaf | { [name: string]: Built }

/**
 * How to make a leaf. Injected rather than imported so the walk stays free of
 * Electron and can be tested with stand-ins.
 */
export interface LeafFactories {
  request: <C extends IpcChannel>(channel: C) => Request<C>
  subscribe: <C extends IpcPushChannel>(channel: C) => Subscribe<C>
}

function buildNode(node: SurfaceNode, factories: LeafFactories): Built {
  if (typeof node === 'string') return factories.request(node)
  if (isPushLeaf(node)) return factories.subscribe(node.push)
  const group: { [name: string]: Built } = {}
  for (const [name, child] of Object.entries(node)) {
    group[name] = buildNode(child, factories)
  }
  return group
}

/**
 * The assertion is unavoidable and deliberately the only one: `ElectronApi` is a
 * conditional type over the surface, and TypeScript cannot check a recursive walk
 * against one. It is safe because both sides read the same value — the walk
 * produces a function per leaf and an object per group, which is exactly what
 * `ApiFor` says a leaf and a group are.
 */
export function buildApi(factories: LeafFactories): ElectronApi {
  return buildNode(API_SURFACE, factories) as ElectronApi
}
