import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { VOICES_REVISION, voiceRepoPath, streamingDigest } from './voices'

describe('voiceRepoPath', () => {
  it('nests a voice the way the catalogue does', () => {
    expect(voiceRepoPath('pl_PL-bass-high')).toBe('pl/pl_PL/bass/high')
    expect(voiceRepoPath('en_US-amy-medium')).toBe('en/en_US/amy/medium')
  })

  it('keeps an underscore in the name rather than splitting on it', () => {
    // Splitting the id on every separator would make this `mc/speech`.
    expect(voiceRepoPath('pl_PL-mc_speech-medium')).toBe('pl/pl_PL/mc_speech/medium')
    expect(voiceRepoPath('pl_PL-mls_6892-low')).toBe('pl/pl_PL/mls_6892/low')
  })

  it('handles a three-letter language code', () => {
    expect(voiceRepoPath('ckb_IQ-someone-medium')).toBe('ckb/ckb_IQ/someone/medium')
  })

  it('takes the name from between the first and last dash', () => {
    expect(voiceRepoPath('en_GB-alan-jones-low')).toBe('en/en_GB/alan-jones/low')
  })

  it('rejects anything that is not a voice id', () => {
    for (const bad of ['', 'gosia', 'pl_PL', 'pl_PL-', '-bass-high', 'pl_PL-bass-']) {
      expect(voiceRepoPath(bad)).toBeNull()
    }
  })

  it('rejects a language that is not a language code', () => {
    expect(voiceRepoPath('PL_PL-bass-high')).toBeNull()
    expect(voiceRepoPath('polish_PL-bass-high')).toBeNull()
  })
})

describe('VOICES_REVISION', () => {
  it('matches the revision the build-time fetcher pins', () => {
    // The two halves of voice installation must agree, or the same voice id
    // means different audio depending on how it arrived — and a clip hash says
    // nothing about which. The script is .mjs and cannot be imported from here,
    // so the constant is read out of its source.
    const script = readFileSync(join(__dirname, '../../../scripts/fetch-piper.mjs'), 'utf-8')
    const match = /const VOICES_REVISION = '([0-9a-f]{40})'/.exec(script)

    expect(match, 'VOICES_REVISION not found in scripts/fetch-piper.mjs').not.toBeNull()
    expect(match?.[1]).toBe(VOICES_REVISION)
  })
})

// ---------------------------------------------------------------------------
// streamingDigest
// ---------------------------------------------------------------------------

describe('streamingDigest', () => {
  const body = Buffer.from('a voice model, in miniature')

  /** How the digests were computed before, over the whole file at once. */
  function wholeBuffer(entry: {
    size: number
    oid: string
    lfs?: { oid: string; size: number }
  }): string {
    if (entry.lfs) return createHash('sha256').update(body).digest('hex')
    const header = Buffer.concat([Buffer.from(`blob ${body.length}`, 'utf-8'), Buffer.from([0])])
    return createHash('sha1').update(header).update(body).digest('hex')
  }

  it('matches the whole-buffer git blob digest, chunk by chunk', () => {
    const entry = { path: 'model.onnx', size: body.length, oid: 'expected-oid' }
    const digest = streamingDigest(entry)
    // Split arbitrarily: the result must not depend on how the bytes arrive.
    digest.update(body.subarray(0, 5))
    digest.update(body.subarray(5, 6))
    digest.update(body.subarray(6))
    const { actual, expected, bytes } = digest.finish()
    expect(actual).toBe(wholeBuffer(entry))
    expect(expected).toBe('expected-oid')
    expect(bytes).toBe(body.length)
  })

  it('matches the whole-buffer sha256 for an LFS entry', () => {
    const entry = {
      path: 'model.onnx',
      size: body.length,
      oid: 'git-oid',
      lfs: { oid: 'lfs-oid', size: body.length },
    }
    const digest = streamingDigest(entry)
    digest.update(body)
    const { actual, expected } = digest.finish()
    expect(actual).toBe(wholeBuffer(entry))
    // An LFS entry is verified against its LFS oid, not its git one.
    expect(expected).toBe('lfs-oid')
  })

  it('reports the byte count, so a truncated download cannot pass as complete', () => {
    const entry = { path: 'model.onnx', size: body.length, oid: 'expected-oid' }
    const digest = streamingDigest(entry)
    digest.update(body.subarray(0, 4))
    expect(digest.finish().bytes).toBe(4)
  })
})
