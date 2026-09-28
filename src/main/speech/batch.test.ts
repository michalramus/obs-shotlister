/**
 * The batch policy, with nothing spawned.
 *
 * What is worth proving here is what happens when rendering goes wrong: an
 * engine that cannot run has to stop the batch after one item, and a single bad
 * clip must not take the other sixty with it. Both used to be unreachable
 * without a Piper binary, which is why the regression this file's first case
 * guards shipped once already.
 */

import { describe, expect, it, vi } from 'vitest'
import { ENGINE_ID, clipHash } from '../../shared/render-plan'
import type { RenderPlanItem } from '../../shared/render-plan'
import { EngineUnusableError, isEngineUnusable, renderAll, renderFailure } from './batch'
import { createMemoryClipStore, createFakeSynthesiser } from './clip-store.fixture'

const VOICE = 'pl_PL-mc_speech-medium'

/** A plan of `count` items, named `clip 1`, `clip 2`, … */
function plan(count: number): RenderPlanItem[] {
  return Array.from({ length: count }, (_, i) => {
    const text = `clip ${i + 1}`
    return { hash: clipHash(text, VOICE, ENGINE_ID), text, voice: VOICE, engine: ENGINE_ID }
  })
}

describe('renderAll', () => {
  it('stops after one item when the engine cannot run, not after sixty-one', async () => {
    const clips = createMemoryClipStore()
    const fake = createFakeSynthesiser(clips, () => new EngineUnusableError('wrong CPU'))

    const result = await renderAll(plan(61), fake.synthesise)

    expect(fake.asked).toHaveLength(1)
    expect(result.engineFailure).toContain('wrong CPU')
    expect(result.failed).toHaveLength(1)
  })

  it('carries on past a clip that merely failed', async () => {
    const clips = createMemoryClipStore()
    const fake = createFakeSynthesiser(clips, (item) =>
      item.text === 'clip 2' ? new Error('piper exited with code 1') : 400,
    )

    const result = await renderAll(plan(3), fake.synthesise)

    expect(fake.asked).toHaveLength(3)
    expect(result.engineFailure).toBeUndefined()
    expect(result.rendered.map((c) => c.durationMs)).toEqual([400, 400])
    expect(result.failed.map((f) => f.item.text)).toEqual(['clip 2'])
  })

  it('reports each clip as it lands, so a duration is never lost to an interruption', async () => {
    const clips = createMemoryClipStore()
    const fake = createFakeSynthesiser(clips, () => 250)
    const seen: (string | undefined)[] = []

    await renderAll(plan(3), fake.synthesise, (step) => seen.push(step.clip?.hash))

    expect(seen).toEqual(plan(3).map((item) => item.hash))
  })

  it('counts failures towards progress, so the bar reaches its total', async () => {
    const clips = createMemoryClipStore()
    const fake = createFakeSynthesiser(clips, (item) =>
      item.text === 'clip 1' ? new Error('nope') : 400,
    )
    const steps: { completed: number; total: number }[] = []

    await renderAll(plan(3), fake.synthesise, ({ completed, total }) =>
      steps.push({ completed, total }),
    )

    expect(steps).toEqual([
      { completed: 1, total: 3 },
      { completed: 2, total: 3 },
      { completed: 3, total: 3 },
    ])
  })

  it('stops between items once the caller aborts', async () => {
    const clips = createMemoryClipStore()
    const controller = new AbortController()
    const fake = createFakeSynthesiser(clips, (item) => {
      if (item.text === 'clip 2') controller.abort()
      return 400
    })

    const result = await renderAll(plan(5), fake.synthesise, undefined, {
      signal: controller.signal,
    })

    expect(fake.asked).toHaveLength(2)
    expect(result.aborted).toBe(true)
  })

  it('hands the synthesiser the batch’s signal, so the clip in flight stops too', async () => {
    // Stopping between items is not enough: a clip is about five seconds on
    // Apple Silicon, and a Live session must not wait that long for the child
    // process the operator's machine is already running (ADR 0005).
    const clips = createMemoryClipStore()
    const controller = new AbortController()
    const fake = createFakeSynthesiser(clips, () => 400)
    const signals: (AbortSignal | undefined)[] = []

    await renderAll(
      plan(1),
      (item, signal) => {
        signals.push(signal)
        return fake.synthesise(item, signal)
      },
      undefined,
      { signal: controller.signal },
    )

    expect(signals).toEqual([controller.signal])
  })

  it('reports a clip the cancellation killed as cancelled, not as a failure', async () => {
    const clips = createMemoryClipStore()
    const controller = new AbortController()
    const fake = createFakeSynthesiser(clips, (item) => {
      if (item.text !== 'clip 2') return 400
      // What a killed Piper reports: the signal is already set by the time the
      // child dies, because it is what killed it.
      controller.abort()
      return new Error('piper was cancelled')
    })

    const result = await renderAll(plan(5), fake.synthesise, undefined, {
      signal: controller.signal,
    })

    // A render failure in the log sends the operator looking for a broken Part,
    // and nothing here is broken — the app stopped it on purpose.
    expect(result.failed).toEqual([])
    expect(result.rendered).toHaveLength(1)
    expect(result.aborted).toBe(true)
  })

  it('renders nothing, and reports nothing wrong, for an empty plan', async () => {
    const clips = createMemoryClipStore()
    const fake = createFakeSynthesiser(clips)

    expect(await renderAll([], fake.synthesise)).toEqual({
      rendered: [],
      failed: [],
      aborted: false,
      engineFailure: undefined,
    })
  })

  it('finishes the batch even when the progress listener throws', async () => {
    // A listener that throws is the caller's bug; abandoning the remaining
    // clips over it would turn a logging mistake into missing audio.
    const clips = createMemoryClipStore()
    const fake = createFakeSynthesiser(clips)
    const onProgress = vi.fn(() => {
      throw new Error('listener bug')
    })

    const result = await renderAll(plan(3), fake.synthesise, onProgress)

    expect(result.rendered).toHaveLength(3)
    expect(onProgress).toHaveBeenCalledTimes(3)
  })
})

describe('renderFailure', () => {
  const item = { text: 'gitara za', voice: 'pl_PL-mc_speech-medium' }

  it('names the clip that failed', () => {
    const failure = renderFailure(item, new Error('boom'))
    expect(failure.message).toContain('gitara za')
    expect(failure.message).toContain('pl_PL-mc_speech-medium')
    expect(failure.message).toContain('boom')
  })

  it('keeps an unusable engine unusable, so the batch stops', () => {
    // The regression this guards: wrapping with a plain Error downgraded every
    // spawn failure, and renderAll carried on to all sixty remaining clips.
    const failure = renderFailure(item, new EngineUnusableError('wrong CPU architecture'))
    expect(isEngineUnusable(failure)).toBe(true)
    expect(failure.message).toContain('wrong CPU architecture')
  })

  it('leaves an ordinary clip failure ordinary, so the batch carries on', () => {
    expect(isEngineUnusable(renderFailure(item, new Error('piper exited with code 1')))).toBe(false)
  })

  it('handles a thrown non-Error', () => {
    expect(renderFailure(item, 'just a string').message).toContain('just a string')
  })
})
