import { describe, it, expect } from 'vitest'
import { applyLivePosition, shotHeldThroughTransition, startedAtFromElapsed } from './live-view'
import type { Shot } from './types'

function shot(id: string, opts: { hidden?: boolean; transitionMs?: number } = {}): Shot {
  return {
    id,
    rundownId: 'r1',
    cameraId: 'c1',
    durationMs: 5000,
    label: null,
    orderIndex: 0,
    hidden: opts.hidden ?? false,
    transitionName: opts.transitionMs ? 'fade' : null,
    transitionMs: opts.transitionMs ?? 0,
  }
}

const hiddenIds = (shots: Shot[]): string[] => shots.filter((s) => s.hidden).map((s) => s.id)

describe('shotHeldThroughTransition', () => {
  it('holds the outgoing shot when the incoming one has a transition', () => {
    const shots = [shot('a'), shot('b', { transitionMs: 1000 }), shot('c')]
    expect(shotHeldThroughTransition(shots, 1)).toBe('a')
  })

  it('holds nothing when the incoming shot is a cut', () => {
    const shots = [shot('a'), shot('b'), shot('c')]
    expect(shotHeldThroughTransition(shots, 1)).toBeNull()
  })

  it('skips over already-hidden shots to find the outgoing one', () => {
    const shots = [shot('a'), shot('b', { hidden: true }), shot('c', { transitionMs: 500 })]
    expect(shotHeldThroughTransition(shots, 2)).toBe('a')
  })

  it('holds nothing on the first shot', () => {
    expect(shotHeldThroughTransition([shot('a', { transitionMs: 1000 })], 0)).toBeNull()
  })

  it('holds nothing when idle', () => {
    expect(shotHeldThroughTransition([shot('a')], null)).toBeNull()
  })
})

describe('applyLivePosition', () => {
  it('hides every shot before the live one', () => {
    const shots = [shot('a'), shot('b'), shot('c'), shot('d')]
    expect(hiddenIds(applyLivePosition(shots, 2))).toEqual(['a', 'b'])
  })

  it('leaves the live shot and everything after it visible', () => {
    const shots = [shot('a'), shot('b'), shot('c')]
    const result = applyLivePosition(shots, 1)
    expect(result[1].hidden).toBe(false)
    expect(result[2].hidden).toBe(false)
  })

  it('keeps the outgoing shot visible through a transition', () => {
    const shots = [shot('a'), shot('b'), shot('c', { transitionMs: 800 })]
    // 'b' is transitioning out and stays visible; 'a' does not.
    expect(hiddenIds(applyLivePosition(shots, 2))).toEqual(['a'])
  })

  it('hides the outgoing shot when the incoming one is a cut', () => {
    const shots = [shot('a'), shot('b'), shot('c')]
    expect(hiddenIds(applyLivePosition(shots, 2))).toEqual(['a', 'b'])
  })

  it('changes nothing when idle', () => {
    const shots = [shot('a'), shot('b')]
    expect(applyLivePosition(shots, null)).toBe(shots)
  })

  it('returns the same array when nothing needs hiding', () => {
    const shots = [shot('a'), shot('b')]
    expect(applyLivePosition(shots, 0)).toBe(shots)
  })

  it('is idempotent', () => {
    const shots = [shot('a'), shot('b'), shot('c')]
    const once = applyLivePosition(shots, 2)
    expect(applyLivePosition(once, 2)).toBe(once)
  })

  it('does not mutate the input', () => {
    const shots = [shot('a'), shot('b')]
    applyLivePosition(shots, 1)
    expect(shots[0].hidden).toBe(false)
  })
})

describe('startedAtFromElapsed', () => {
  it('anchors elapsed time against the local clock', () => {
    expect(startedAtFromElapsed(3000, 10_000)).toBe(7000)
  })

  it('passes null through when nothing is live', () => {
    expect(startedAtFromElapsed(null, 10_000)).toBeNull()
  })

  it('handles a shot that just went live', () => {
    expect(startedAtFromElapsed(0, 10_000)).toBe(10_000)
  })
})
