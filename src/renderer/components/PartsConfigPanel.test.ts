import { describe, it, expect } from 'vitest'
import {
  PART_KEYS,
  partForKey,
  keyForPart,
  partsByNumber,
  filterParts,
  isPartInScope,
  scopeLabel,
  scopeOfPart,
} from './PartsConfigPanel'
import type { Part, Rundown } from '../../shared/types'

function part(number: number, name: string, scope: Partial<Part> = {}): Part {
  return {
    id: `p${number}`,
    projectId: 'proj',
    number,
    name,
    color: '#e74c3c',
    folder: null,
    rundownId: null,
    ...scope,
  }
}

function rundown(id: string, folder: string | null): Rundown {
  return { id, projectId: 'proj', name: id, createdAt: 0, orderIndex: 0, folder, kind: 'voice' }
}

/** Nineteen Parts numbered 1..19, deliberately handed over out of order. */
function nineteenParts(): Part[] {
  const ordered = Array.from({ length: 19 }, (_, i) => part(i + 1, `part ${i + 1}`))
  return [...ordered].reverse()
}

describe('PART_KEYS', () => {
  it('runs 1-9 then the q..p letter row', () => {
    expect(PART_KEYS).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      'q',
      'w',
      'e',
      'r',
      't',
      'y',
      'u',
      'i',
      'o',
      'p',
    ])
  })

  it('covers nineteen parts', () => {
    expect(PART_KEYS).toHaveLength(19)
  })
})

describe('partForKey', () => {
  it('maps every key to its part, in number order', () => {
    const parts = nineteenParts()
    PART_KEYS.forEach((key, i) => {
      expect(partForKey(key, parts)?.number).toBe(i + 1)
    })
  })

  it('orders by number, not by position in the array', () => {
    // The store hands the list over sorted, but a caller filtering to the
    // in-scope union must not be able to change which key a part answers to.
    const parts = [part(3, 'third'), part(1, 'first'), part(2, 'second')]
    expect(partForKey('1', parts)?.name).toBe('first')
    expect(partForKey('2', parts)?.name).toBe('second')
    expect(partForKey('3', parts)?.name).toBe('third')
  })

  it('keys off position in scope, not off the part number itself', () => {
    // Numbers are unique per project, so an in-scope list is routinely sparse;
    // keying off the number would leave most keys dead.
    const parts = [part(4, 'gitara'), part(9, 'refren'), part(12, 'wokal 1')]
    expect(partForKey('1', parts)?.name).toBe('gitara')
    expect(partForKey('2', parts)?.name).toBe('refren')
    expect(partForKey('3', parts)?.name).toBe('wokal 1')
    expect(partForKey('4', parts)).toBeNull()
  })

  it('accepts an uppercase letter key', () => {
    const parts = nineteenParts()
    expect(partForKey('Q', parts)?.number).toBe(10)
  })

  it('returns null past the end of a short list', () => {
    const parts = [part(1, 'gitara'), part(2, 'refren')]
    expect(partForKey('3', parts)).toBeNull()
    expect(partForKey('q', parts)).toBeNull()
  })

  it('returns null for an unmapped key', () => {
    const parts = nineteenParts()
    expect(partForKey('0', parts)).toBeNull()
    expect(partForKey('a', parts)).toBeNull()
    expect(partForKey('Escape', parts)).toBeNull()
    expect(partForKey('', parts)).toBeNull()
  })

  it('ignores a twentieth part, which has no key', () => {
    const parts = [...nineteenParts(), part(20, 'twentieth')]
    expect(partForKey('p', parts)?.number).toBe(19)
  })

  it('returns null for an empty list', () => {
    expect(partForKey('1', [])).toBeNull()
  })
})

describe('keyForPart', () => {
  it('names the key a part answers to', () => {
    const parts = nineteenParts()
    expect(keyForPart(part(10, 'part 10'), parts)).toBe('q')
  })

  it('has no key for a part past the keymap', () => {
    const twentieth = part(20, 'twentieth')
    expect(keyForPart(twentieth, [...nineteenParts(), twentieth])).toBeNull()
  })

  it('has no key for a part that is not in the list', () => {
    expect(keyForPart(part(99, 'elsewhere'), nineteenParts())).toBeNull()
  })
})

describe('partsByNumber', () => {
  it('sorts by number without mutating the input', () => {
    const parts = [part(3, 'c'), part(1, 'a'), part(2, 'b')]
    expect(partsByNumber(parts).map((p) => p.name)).toEqual(['a', 'b', 'c'])
    expect(parts.map((p) => p.name)).toEqual(['c', 'a', 'b'])
  })
})

describe('filterParts', () => {
  const parts = [part(1, 'gitara'), part(2, 'wokal 1'), part(12, 'Refren')]

  it('returns everything in number order for an empty query', () => {
    expect(filterParts(parts, '').map((p) => p.name)).toEqual(['gitara', 'wokal 1', 'Refren'])
  })

  it('ignores surrounding whitespace', () => {
    expect(filterParts(parts, '  ').map((p) => p.name)).toEqual(['gitara', 'wokal 1', 'Refren'])
  })

  it('matches on any part of the name, case-insensitively', () => {
    expect(filterParts(parts, 'REF').map((p) => p.name)).toEqual(['Refren'])
    expect(filterParts(parts, 'kal').map((p) => p.name)).toEqual(['wokal 1'])
  })

  it('matches on the number shown on the button bar', () => {
    expect(filterParts(parts, '12').map((p) => p.name)).toEqual(['Refren'])
  })

  it('keeps results in number order', () => {
    const shuffled = [part(9, 'wokal 2'), part(2, 'wokal 1')]
    expect(filterParts(shuffled, 'wokal').map((p) => p.name)).toEqual(['wokal 1', 'wokal 2'])
  })

  it('returns nothing when nothing matches', () => {
    expect(filterParts(parts, 'zzz')).toEqual([])
  })
})

describe('scopeOfPart', () => {
  it('reads project scope from two empty columns', () => {
    expect(scopeOfPart(part(1, 'gitara'))).toEqual({ kind: 'project' })
  })

  it('reads folder scope', () => {
    expect(scopeOfPart(part(1, 'gitara', { folder: 'Band A' }))).toEqual({
      kind: 'folder',
      folder: 'Band A',
    })
  })

  it('reads rundown scope', () => {
    expect(scopeOfPart(part(1, 'gitara', { rundownId: 'r1' }))).toEqual({
      kind: 'rundown',
      rundownId: 'r1',
    })
  })
})

describe('isPartInScope', () => {
  const r1 = rundown('r1', 'Band A')

  it('always offers a project part', () => {
    expect(isPartInScope(part(1, 'gitara'), r1)).toBe(true)
  })

  it('offers a part from the rundown own folder', () => {
    expect(isPartInScope(part(1, 'gitara', { folder: 'Band A' }), r1)).toBe(true)
  })

  it('does not offer another folder parts', () => {
    expect(isPartInScope(part(1, 'gitara', { folder: 'Band B' }), r1)).toBe(false)
  })

  it('offers the rundown own parts', () => {
    expect(isPartInScope(part(1, 'gitara', { rundownId: 'r1' }), r1)).toBe(true)
  })

  it('does not offer another rundown parts', () => {
    expect(isPartInScope(part(1, 'gitara', { rundownId: 'r2' }), r1)).toBe(false)
  })

  it('offers no foldered part to a loose rundown', () => {
    expect(isPartInScope(part(1, 'gitara', { folder: 'Band A' }), rundown('r3', null))).toBe(false)
  })

  it('still offers project parts with no rundown open', () => {
    expect(isPartInScope(part(1, 'gitara'), null)).toBe(true)
    expect(isPartInScope(part(1, 'gitara', { rundownId: 'r1' }), null)).toBe(false)
  })
})

describe('scopeLabel', () => {
  const rundowns = [rundown('r1', 'Band A')]

  it('names the project scope', () => {
    expect(scopeLabel(part(1, 'gitara'), rundowns)).toBe('Project')
  })

  it('names the folder', () => {
    expect(scopeLabel(part(1, 'gitara', { folder: 'Band A' }), rundowns)).toBe('Folder: Band A')
  })

  it('names the owning rundown', () => {
    expect(scopeLabel(part(1, 'gitara', { rundownId: 'r1' }), rundowns)).toBe('Rundown: r1')
  })

  it('falls back when the owning rundown is not loaded', () => {
    expect(scopeLabel(part(1, 'gitara', { rundownId: 'gone' }), rundowns)).toBe('Rundown')
  })
})
