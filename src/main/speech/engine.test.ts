/**
 * The Piper side that can be asserted on without spawning Piper: which command
 * line an engine speaks, and what a spawn failure means.
 *
 * The WAV arithmetic this file used to also cover now lives in `wav.test`, and
 * the batch policy in `batch.test`; both moved with the code they prove.
 */

import { describe, expect, it } from 'vitest'
import { defaultPiperCli, piperArgs, spawnFailureMessage } from './engine'

describe('spawnFailureMessage', () => {
  const binary = '/app/resources/piper/piper'

  it('explains the architecture mismatch Node reports as errno -86', () => {
    // macOS EBADARCH. Node surfaces it as "Unknown system error -86", which
    // tells an operator nothing at all.
    const message = spawnFailureMessage({ errno: -86 } as NodeJS.ErrnoException, binary)

    expect(message).toContain('wrong CPU architecture')
    expect(message).toContain(binary)
    expect(message).toContain('softwareupdate --install-rosetta')
  })

  it('recognises EBADARCH by code as well as by errno', () => {
    const message = spawnFailureMessage({ code: 'EBADARCH' } as NodeJS.ErrnoException, binary)
    expect(message).toContain('wrong CPU architecture')
  })

  it('points a missing engine at the fetch script', () => {
    const message = spawnFailureMessage({ code: 'ENOENT' } as NodeJS.ErrnoException, binary)
    expect(message).toContain('yarn fetch:piper')
  })

  it('names a non-executable engine', () => {
    const message = spawnFailureMessage({ code: 'EACCES' } as NodeJS.ErrnoException, binary)
    expect(message).toContain('not executable')
  })

  it('falls back to the underlying message for anything else', () => {
    const message = spawnFailureMessage(
      Object.assign(new Error('boom'), { code: 'EPERM' }) as NodeJS.ErrnoException,
      binary,
    )
    expect(message).toContain('boom')
  })
})

describe('piperArgs', () => {
  const paths = {
    model: '/v/pl.onnx',
    config: '/v/pl.onnx.json',
    binary: '/p/piper',
    outputFile: '/tmp/out.wav',
  }

  it('passes the full CLI everything it needs, including a zero pad', () => {
    const args = piperArgs('full', paths)
    expect(args).toContain('--config')
    expect(args).toContain('--espeak_data')
    expect(args.join(' ')).toContain('--sentence_silence 0')
  })

  it('passes the minimal CLI only the two flags it accepts', () => {
    // The arm64 build rejects anything else outright.
    expect(piperArgs('minimal', paths)).toEqual([
      '--model',
      '/v/pl.onnx',
      '--output_file',
      '/tmp/out.wav',
    ])
  })
})

describe('defaultPiperCli', () => {
  it('assumes the community build on Apple Silicon, which has no upstream one', () => {
    expect(defaultPiperCli('darwin', 'arm64')).toBe('minimal')
  })

  it('assumes the upstream CLI everywhere upstream ships one', () => {
    expect(defaultPiperCli('darwin', 'x64')).toBe('full')
    expect(defaultPiperCli('linux', 'x64')).toBe('full')
    expect(defaultPiperCli('win32', 'x64')).toBe('full')
  })
})
