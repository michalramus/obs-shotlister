/**
 * A clip cache in a Map, and a synthesiser that does not spawn anything.
 *
 * For tests only. Not named `*.test.ts` so it is not collected as a suite, and
 * imported by no production module, so it never reaches a bundle.
 *
 * These exist because the interesting half of rendering is the half that refuses
 * to render: the three Live-session refusals ADR 0005 is made of, the debounce
 * queue, the latch on an engine that cannot run. Every one of those decisions
 * used to be unreachable without a Piper binary and a populated cache directory,
 * which is why none of them was covered.
 */

import type { RenderPlanItem } from '../../shared/render-plan'
import type { ClipStore } from './clip-store'
import type { SynthesisedClip, Synthesiser } from './batch'

/** A valid 16-bit mono PCM WAV of `durationMs`, audible to its last sample. */
export function wavOf(durationMs: number, sampleRate = 1000): Buffer {
  const samples = Math.round((durationMs / 1000) * sampleRate)
  const dataBytes = samples * 2
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < samples; i++) buf.writeInt16LE(8000, 44 + i * 2)
  return buf
}

export interface MemoryClipStore extends ClipStore {
  /** Puts a clip there as a populated cache would have, without rendering it. */
  seed: (hash: string, bytes?: Buffer) => void
  /** Hashes that refuse to be deleted, standing in for a locked file. */
  readonly locked: Set<string>
  /** Every hash `remove` was asked to delete, in order. */
  readonly removeAttempts: string[]
}

export function createMemoryClipStore(): MemoryClipStore {
  const clips = new Map<string, Buffer>()
  const locked = new Set<string>()
  const removeAttempts: string[] = []

  return {
    locked,
    removeAttempts,

    seed(hash, bytes = wavOf(400)) {
      clips.set(hash, bytes)
    },

    hashes: () => Promise.resolve([...clips.keys()]),

    put(item, bytes) {
      clips.set(item.hash, bytes)
      return Promise.resolve()
    },

    read(hash) {
      const bytes = clips.get(hash)
      if (!bytes) return Promise.reject(new Error(`no clip ${hash}`))
      return Promise.resolve(bytes)
    },

    remove(hashes, onError) {
      const gone: string[] = []
      for (const hash of hashes) {
        removeAttempts.push(hash)
        // A locked file is left in place and reported, exactly as the real
        // sweep does: its row has to survive or the index would claim a file is
        // gone while it still answers a lookup.
        if (locked.has(hash)) {
          onError?.(hash, new Error('EBUSY'))
          continue
        }
        clips.delete(hash)
        gone.push(hash)
      }
      return Promise.resolve(gone)
    },
  }
}

export interface FakeSynthesiser {
  synthesise: Synthesiser
  /** Every item it was asked for, in order — successes and failures alike. */
  readonly asked: RenderPlanItem[]
}

/**
 * A synthesiser that writes into `clips` without spawning anything.
 *
 * `behaviour` returns the duration to report, or an Error to throw — an
 * `EngineUnusableError` for "the engine cannot run at all", anything else for
 * one clip that did not render.
 */
export function createFakeSynthesiser(
  clips: ClipStore,
  behaviour: (item: RenderPlanItem) => number | Error = () => 400,
): FakeSynthesiser {
  const asked: RenderPlanItem[] = []

  return {
    asked,
    async synthesise(item): Promise<SynthesisedClip> {
      asked.push(item)
      const outcome = behaviour(item)
      if (outcome instanceof Error) throw outcome
      // Stored before it is reported, which is what the real one guarantees: the
      // caller writes the duration to the database the moment it hears about a
      // clip, and a row is a promise that a file exists.
      await clips.put(item, wavOf(outcome))
      return { hash: item.hash, durationMs: outcome }
    },
  }
}
