import { describe, it, expect, beforeEach } from 'vitest'
import { useWebStore } from './store'
import type { Camera, Rundown, Shot } from '../shared/types'

/**
 * The phone store had no tests at all, though it is what every camera operator
 * reads during a show and ADR-0003 makes the main process its only source of
 * truth. These cover the two things a phone gets wrong in the room: a live
 * position that no longer matches the list it indexes, and a reconnect.
 */

function shot(id: string, opts: { hidden?: boolean; transitionMs?: number } = {}): Shot {
  return {
    id,
    rundownId: 'r1',
    cameraId: 'c1',
    partId: null,
    durationMs: 5000,
    label: null,
    orderIndex: 0,
    hidden: opts.hidden ?? false,
    transitionName: opts.transitionMs !== undefined ? 'fade' : null,
    transitionMs: opts.transitionMs ?? 0,
  }
}

const rundown = (id: string): Rundown => ({
  id,
  projectId: 'p1',
  name: id,
  createdAt: 1,
  orderIndex: 0,
  folder: null,
  kind: 'camera',
})

const cameras: Camera[] = [
  {
    id: 'c1',
    projectId: 'p1',
    number: 1,
    name: 'Wide',
    color: '#f00',
    resolveColor: null,
    obsScene: null,
  },
]

function reset(): void {
  useWebStore.setState({
    rundown: null,
    shots: [],
    cameras: [],
    parts: [],
    liveIndex: null,
    startedAt: null,
    running: false,
    connected: false,
  })
}

describe('the phone store', () => {
  beforeEach(reset)

  it('applies the live position to the list it was given', () => {
    useWebStore.getState().setRundownState({
      rundown: rundown('r1'),
      shots: [shot('a'), shot('b'), shot('c')],
      cameras,
    })
    useWebStore.getState().setLiveState({ liveIndex: 2, elapsedMs: 0 })

    // Everything before the live Shot is spent, and on a cut nothing is held.
    expect(
      useWebStore
        .getState()
        .shots.filter((s) => s.hidden)
        .map((s) => s.id),
    ).toEqual(['a', 'b'])
  })

  it('anchors the live clock against the receiver own clock, not the operator one', () => {
    const before = Date.now()
    useWebStore.getState().setLiveState({ liveIndex: 0, elapsedMs: 4000 })
    const startedAt = useWebStore.getState().startedAt

    // Phones do not share the operator's clock, so the elapsed time is turned
    // into a local timestamp on arrival.
    expect(startedAt).not.toBeNull()
    expect(startedAt!).toBeLessThanOrEqual(before - 4000 + 50)
    expect(startedAt!).toBeGreaterThanOrEqual(before - 4000 - 50)
  })

  it('clears the live clock when the show stops', () => {
    useWebStore.getState().setLiveState({ liveIndex: 1, elapsedMs: 1000 })
    useWebStore.getState().setLiveState({ liveIndex: null, elapsedMs: null })
    expect(useWebStore.getState().startedAt).toBeNull()
    expect(useWebStore.getState().liveIndex).toBeNull()
  })

  it('hides a Shot the operator skipped', () => {
    useWebStore.getState().setRundownState({
      rundown: rundown('r1'),
      shots: [shot('a'), shot('b'), shot('c')],
      cameras,
    })
    useWebStore.getState().setShotHidden('b')
    expect(useWebStore.getState().shots.find((s) => s.id === 'b')?.hidden).toBe(true)
  })

  it('survives a reconnect: the server resends everything and the phone agrees', () => {
    // The on-connect burst is live, then playback, then rundown — the order
    // src/main/server/socket.ts emits them in.
    useWebStore.getState().setConnected(false)
    useWebStore.getState().setLiveState({ liveIndex: 1, elapsedMs: 2000 })
    useWebStore.getState().setPlayback({ running: true })
    // The server sends the queue's own hidden flags with the rundown
    // (LiveSession.getShotsForPhones), which is what makes the ordering safe:
    // setRundownState does not re-derive the position from liveIndex, so a
    // payload without them would leave a reconnecting phone a Shot behind.
    useWebStore.getState().setRundownState({
      rundown: rundown('r1'),
      shots: [shot('a', { hidden: true }), shot('b'), shot('c')],
      cameras,
    })
    useWebStore.getState().setConnected(true)

    const state = useWebStore.getState()
    expect(state.connected).toBe(true)
    expect(state.running).toBe(true)
    expect(state.liveIndex).toBe(1)
    expect(state.shots.find((s) => s.id === 'a')?.hidden).toBe(true)
    expect(state.shots.find((s) => s.id === 'b')?.hidden).toBe(false)
  })

  it('holds the outgoing Shot when the incoming one has a Transition', () => {
    useWebStore.getState().setRundownState({
      rundown: rundown('r1'),
      shots: [shot('a'), shot('b', { transitionMs: 1000 }), shot('c')],
      cameras,
    })
    useWebStore.getState().setLiveState({ liveIndex: 1, elapsedMs: 0 })

    // ADR-0004: 'a' is still on screen in OBS for the length of b's fade.
    expect(useWebStore.getState().shots.find((s) => s.id === 'a')?.hidden).toBe(false)
  })
})
