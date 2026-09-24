import { describe, it, expect } from 'vitest'
import {
  targetsOf,
  targetIdOf,
  isUnassigned,
  targetOf,
  targetsById,
  targetNoun,
} from './rundown-item'
import type { Camera, Part, Shot } from './types'

const camera = (id: string, number: number): Camera => ({
  id,
  projectId: 'p1',
  number,
  name: `Cam ${number}`,
  color: '#f00',
  resolveColor: null,
  obsScene: null,
})

const part = (id: string, number: number): Part => ({
  id,
  projectId: 'p1',
  number,
  name: `part ${number}`,
  color: '#0f0',
  folder: null,
  rundownId: null,
})

const item = (over: Partial<Shot> = {}): Shot => ({
  id: 's1',
  rundownId: 'rd1',
  cameraId: null,
  partId: null,
  durationMs: 1000,
  label: null,
  orderIndex: 0,
  transitionName: null,
  transitionMs: 0,
  ...over,
})

describe('targetsOf', () => {
  it('offers Cameras in a Camera Rundown and Parts in a Voice-over one', () => {
    const cameras = [camera('c1', 1)]
    const parts = [part('pt1', 1)]

    expect(targetsOf('camera', cameras, parts).map((t) => t.id)).toEqual(['c1'])
    expect(targetsOf('voice', cameras, parts).map((t) => t.id)).toEqual(['pt1'])
  })

  it('orders by number, not by array position', () => {
    const parts = [part('pt9', 9), part('pt2', 2), part('pt4', 4)]
    expect(targetsOf('voice', [], parts).map((t) => t.number)).toEqual([2, 4, 9])
  })

  it('badges a Camera as CAM<n> and a Part as its number', () => {
    expect(targetsOf('camera', [camera('c1', 3)], [])[0].badge).toBe('CAM3')
    expect(targetsOf('voice', [], [part('pt1', 3)])[0].badge).toBe('3')
  })

  it('does not mutate the caller’s array while sorting', () => {
    const parts = [part('pt9', 9), part('pt2', 2)]
    targetsOf('voice', [], parts)
    expect(parts.map((p) => p.id)).toEqual(['pt9', 'pt2'])
  })
})

describe('targetIdOf', () => {
  it('reads the column its Kind owns, never the other one', () => {
    // Both are filled, as they are after a conversion away and back.
    const both = item({ cameraId: 'c1', partId: 'pt1' })
    expect(targetIdOf(both, 'camera')).toBe('c1')
    expect(targetIdOf(both, 'voice')).toBe('pt1')
  })
})

describe('isUnassigned', () => {
  it('ignores a target belonging to the other Kind', () => {
    // A Camera Rundown converted to voice: every item has a Camera and no Part.
    const converted = item({ cameraId: 'c1', partId: null })
    expect(isUnassigned(converted, 'camera')).toBe(false)
    expect(isUnassigned(converted, 'voice')).toBe(true)
  })
})

describe('targetOf', () => {
  const targets = targetsById(targetsOf('voice', [], [part('pt1', 1)]))

  it('resolves an assigned item', () => {
    expect(targetOf(item({ partId: 'pt1' }), 'voice', targets)?.name).toBe('part 1')
  })

  it('returns undefined for an unassigned item', () => {
    expect(targetOf(item(), 'voice', targets)).toBeUndefined()
  })

  it('returns undefined for a Part out of scope, which is still assigned', () => {
    // ADR 0006: scope governs the picker, never resolution — so a Call can
    // point at a Part this Rundown cannot offer, and that is not unassigned.
    const outOfScope = item({ partId: 'pt-elsewhere' })
    expect(targetOf(outOfScope, 'voice', targets)).toBeUndefined()
    expect(isUnassigned(outOfScope, 'voice')).toBe(false)
  })
})

describe('targetNoun', () => {
  it('names what each Kind assigns', () => {
    expect(targetNoun('voice')).toBe('Part')
    expect(targetNoun('camera')).toBe('Camera')
  })
})
