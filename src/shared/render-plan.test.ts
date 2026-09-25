import { describe, it, expect } from 'vitest'
import {
  NUMBER_CLIP_RANGE,
  clipHash,
  computeRenderPlan,
  partPhrase,
  type RenderPlanInput,
} from './render-plan'
import type { Part } from './types'

const VOICE = 'pl_PL-darkman-medium'
const ENGINE = 'piper'
const CONNECTOR = 'za'

function part(id: string, name: string): Part {
  return {
    id,
    projectId: 'p1',
    number: 1,
    name,
    color: '#e74c3c',
    folder: null,
    rundownId: null,
  }
}

/** The Polish words for every number a full 1..60 render needs. */
const NUMBER_WORDS = new Map<number, string>(
  Array.from({ length: NUMBER_CLIP_RANGE.last }, (_, i) => [i + 1, `number-${i + 1}`]),
)

/** Every hash a complete 1..60 render leaves in the cache, for a given voice. */
function numberHashes(voice = VOICE, engine = ENGINE): string[] {
  return [...NUMBER_WORDS.values()].map((word) => clipHash(word, voice, engine))
}

function phraseHash(name: string, connector = CONNECTOR, voice = VOICE, engine = ENGINE): string {
  return clipHash(partPhrase(name, connector), voice, engine)
}

function input(overrides: Partial<RenderPlanInput> = {}): RenderPlanInput {
  return {
    parts: [],
    connector: CONNECTOR,
    voice: VOICE,
    engine: ENGINE,
    cachedHashes: [],
    lastRendered: new Map(),
    countdownNumberWords: NUMBER_WORDS,
    ...overrides,
  }
}

const stateOf = (plan: ReturnType<typeof computeRenderPlan>, partId: string): string | undefined =>
  plan.parts.find((p) => p.partId === partId)?.state

describe('clipHash', () => {
  it('is deterministic', () => {
    expect(clipHash('gitara za', VOICE, ENGINE)).toBe(clipHash('gitara za', VOICE, ENGINE))
  })

  it('returns a 32-char hex digest', () => {
    expect(clipHash('gitara za', VOICE, ENGINE)).toMatch(/^[0-9a-f]{32}$/)
  })

  it('changes with the text', () => {
    expect(clipHash('gitara za', VOICE, ENGINE)).not.toBe(clipHash('wokal za', VOICE, ENGINE))
  })

  it('changes with the voice', () => {
    expect(clipHash('gitara za', VOICE, ENGINE)).not.toBe(
      clipHash('gitara za', 'en_US-amy-medium', ENGINE),
    )
  })

  it('changes with the engine', () => {
    expect(clipHash('gitara za', VOICE, ENGINE)).not.toBe(clipHash('gitara za', VOICE, 'espeak'))
  })

  it('cannot be collided by moving the boundary between fields', () => {
    expect(clipHash('ab', 'c', ENGINE)).not.toBe(clipHash('a', 'bc', ENGINE))
  })
})

describe('partPhrase', () => {
  it('speaks the Part name followed by the connector', () => {
    expect(partPhrase('gitara', 'za')).toBe('gitara za')
  })

  it('speaks the name alone when there is no connector', () => {
    expect(partPhrase('gitara', '')).toBe('gitara')
  })
})

describe('computeRenderPlan — Part state', () => {
  it('reports rendered when the cached clip matches the current phrase', () => {
    const p = part('a', 'gitara')
    const hash = phraseHash('gitara')
    const plan = computeRenderPlan(
      input({
        parts: [p],
        cachedHashes: [hash, ...numberHashes()],
        lastRendered: new Map([['a', hash]]),
      }),
    )
    expect(stateOf(plan, 'a')).toBe('rendered')
    expect(plan.toRender).toEqual([])
  })

  it('reports missing when the Part was never rendered', () => {
    const plan = computeRenderPlan(
      input({ parts: [part('a', 'gitara')], cachedHashes: numberHashes() }),
    )
    expect(stateOf(plan, 'a')).toBe('missing')
    expect(plan.toRender).toEqual([
      { hash: phraseHash('gitara'), text: 'gitara za', voice: VOICE, engine: ENGINE },
    ])
  })

  it('reports missing when the rendered clip was deleted behind our back', () => {
    // A render log entry pointing at a hash the cache no longer holds means
    // nothing would be spoken at all — that reads as missing, not stale.
    const hash = phraseHash('gitara')
    const plan = computeRenderPlan(
      input({
        parts: [part('a', 'gitara')],
        cachedHashes: numberHashes(),
        lastRendered: new Map([['a', hash]]),
      }),
    )
    expect(stateOf(plan, 'a')).toBe('missing')
  })

  it('reports stale after a rename, while the old clip is still cached', () => {
    const oldHash = phraseHash('gitara')
    const plan = computeRenderPlan(
      input({
        parts: [part('a', 'gitara solo')],
        cachedHashes: [oldHash, ...numberHashes()],
        lastRendered: new Map([['a', oldHash]]),
      }),
    )
    expect(stateOf(plan, 'a')).toBe('stale')
    expect(plan.toRender.map((item) => item.text)).toEqual(['gitara solo za'])
  })

  it('reports stale after the connector changes', () => {
    const oldHash = phraseHash('gitara', 'za')
    const plan = computeRenderPlan(
      input({
        parts: [part('a', 'gitara')],
        connector: 'in',
        cachedHashes: [oldHash, ...numberHashes()],
        lastRendered: new Map([['a', oldHash]]),
      }),
    )
    expect(stateOf(plan, 'a')).toBe('stale')
  })

  it('reports stale after the Voice changes', () => {
    const oldHash = phraseHash('gitara', CONNECTOR, 'pl_PL-gosia-medium')
    const plan = computeRenderPlan(
      input({
        parts: [part('a', 'gitara')],
        voice: VOICE,
        cachedHashes: [oldHash, ...numberHashes()],
        lastRendered: new Map([['a', oldHash]]),
      }),
    )
    expect(stateOf(plan, 'a')).toBe('stale')
    // The new Voice needs the phrase re-synthesised, and all 60 numbers with it.
    expect(plan.toRender).toContainEqual({
      hash: phraseHash('gitara'),
      text: 'gitara za',
      voice: VOICE,
      engine: ENGINE,
    })
  })

  it('reports every Part, in the order given', () => {
    const plan = computeRenderPlan(input({ parts: [part('a', 'gitara'), part('b', 'wokal 1')] }))
    expect(plan.parts.map((p) => [p.partId, p.name])).toEqual([
      ['a', 'gitara'],
      ['b', 'wokal 1'],
    ])
  })
})

describe('computeRenderPlan — number clips', () => {
  it('queues all 60 numbers when the cache is empty, whatever the countdown uses', () => {
    const plan = computeRenderPlan(input())
    expect(plan.toRender).toHaveLength(NUMBER_CLIP_RANGE.last)
    expect(plan.toRender.map((item) => item.text)).toContain('number-60')
    expect(plan.toRender.map((item) => item.text)).toContain('number-7')
  })

  it('queues nothing when all 60 are already cached', () => {
    const plan = computeRenderPlan(input({ cachedHashes: numberHashes() }))
    expect(plan.toRender).toEqual([])
  })

  it('queues only the numbers whose clips are absent', () => {
    const cached = numberHashes().filter((hash) => hash !== clipHash('number-3', VOICE, ENGINE))
    const plan = computeRenderPlan(input({ cachedHashes: cached }))
    expect(plan.toRender.map((item) => item.text)).toEqual(['number-3'])
  })

  it('skips a number with no word supplied rather than throwing', () => {
    const words = new Map(NUMBER_WORDS)
    words.delete(42)
    const plan = computeRenderPlan(input({ countdownNumberWords: words }))
    expect(plan.toRender).toHaveLength(NUMBER_CLIP_RANGE.last - 1)
    expect(plan.toRender.map((item) => item.text)).not.toContain('number-42')
  })
})

describe('computeRenderPlan — orphans', () => {
  it('sweeps a renamed Part’s old clip', () => {
    const oldHash = phraseHash('gitara')
    const plan = computeRenderPlan(
      input({
        parts: [part('a', 'gitara solo')],
        cachedHashes: [oldHash, ...numberHashes()],
        lastRendered: new Map([['a', oldHash]]),
      }),
    )
    expect(plan.toSweep).toEqual([oldHash])
  })

  it('sweeps clips rendered with a Voice no longer in use', () => {
    const stray = clipHash('gitara za', 'en_US-amy-medium', ENGINE)
    const plan = computeRenderPlan(
      input({
        parts: [part('a', 'gitara')],
        cachedHashes: [stray, phraseHash('gitara'), ...numberHashes()],
        lastRendered: new Map([['a', phraseHash('gitara')]]),
      }),
    )
    expect(plan.toSweep).toEqual([stray])
  })

  it('never sweeps a number clip, even one the countdown does not use', () => {
    const plan = computeRenderPlan(input({ cachedHashes: numberHashes() }))
    expect(plan.toSweep).toEqual([])
  })

  it('sweeps nothing from an empty cache', () => {
    const plan = computeRenderPlan(input({ parts: [part('a', 'gitara')] }))
    expect(plan.toSweep).toEqual([])
  })
})

describe('computeRenderPlan — duplicates', () => {
  it('queues one clip for two Parts that share a name', () => {
    const plan = computeRenderPlan(
      input({
        parts: [part('a', 'refren'), part('b', 'refren')],
        cachedHashes: numberHashes(),
      }),
    )
    expect(plan.toRender).toEqual([
      { hash: phraseHash('refren'), text: 'refren za', voice: VOICE, engine: ENGINE },
    ])
    expect(plan.parts.map((p) => p.state)).toEqual(['missing', 'missing'])
  })

  it('queues one clip when a Part phrase collides with a number word', () => {
    const words = new Map([[1, 'jeden za']])
    const plan = computeRenderPlan(
      input({ parts: [part('a', 'jeden')], countdownNumberWords: words }),
    )
    expect(plan.toRender).toHaveLength(1)
  })

  it('does not report a hash listed twice in the cache twice in toSweep', () => {
    const stray = clipHash('orphan', VOICE, ENGINE)
    const plan = computeRenderPlan(
      input({ cachedHashes: [stray, stray], countdownNumberWords: new Map() }),
    )
    expect(plan.toSweep).toEqual([stray])
  })
})

describe('computeRenderPlan — the wanted list', () => {
  it('lists a clip the cache already holds, which toRender does not', () => {
    const cached = [phraseHash('gitara')]
    const plan = computeRenderPlan(
      input({
        parts: [part('a', 'gitara')],
        cachedHashes: cached,
        countdownNumberWords: new Map(),
      }),
    )

    expect(plan.toRender).toEqual([])
    expect(plan.wanted).toContainEqual({
      hash: phraseHash('gitara'),
      text: 'gitara za',
      voice: VOICE,
      engine: ENGINE,
    })
  })

  it('covers the Part phrases and every number clip', () => {
    const plan = computeRenderPlan(input({ parts: [part('a', 'gitara')] }))

    expect(plan.wanted).toHaveLength(NUMBER_CLIP_RANGE.last + 1)
  })

  it('lists two Parts sharing a name once', () => {
    const plan = computeRenderPlan(
      input({ parts: [part('a', 'gitara'), part('b', 'gitara')], countdownNumberWords: new Map() }),
    )

    expect(plan.wanted).toHaveLength(1)
  })

  it('is exactly what survives a sweep', () => {
    const cached = [...numberHashes(), phraseHash('gitara'), phraseHash('stara nazwa')]
    const plan = computeRenderPlan(input({ parts: [part('a', 'gitara')], cachedHashes: cached }))

    const kept = cached.filter((hash) => !plan.toSweep.includes(hash))
    expect(kept.sort()).toEqual(plan.wanted.map((item) => item.hash).sort())
  })
})
