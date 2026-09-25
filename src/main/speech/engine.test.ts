/**
 * The WAV header parser only. Nothing here spawns Piper, touches the cache
 * directory or opens an audio device — but the duration it reads decides where
 * every Announcement lands in time, so it is worth proving against hand-built
 * headers rather than against whatever Piper happened to write.
 */

import { describe, expect, it } from 'vitest'
import {
  audibleDurationMs,
  defaultPiperCli,
  piperArgs,
  spawnFailureMessage,
  wavDurationMs,
} from './engine'

interface Chunk {
  id: string
  body: Buffer
  /** Overrides the declared size, for the truncated and zero-size cases. */
  declaredSize?: number
}

function chunk({ id, body, declaredSize }: Chunk): Buffer {
  const header = Buffer.alloc(8)
  header.write(id, 0, 'ascii')
  header.writeUInt32LE(declaredSize ?? body.length, 4)
  // Chunks are word-aligned: an odd-sized body is followed by a pad byte.
  const pad = body.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)
  return Buffer.concat([header, body, pad])
}

function fmtChunk(options: {
  channels?: number
  sampleRate?: number
  bitsPerSample?: number
  byteRate?: number
}): Buffer {
  const channels = options.channels ?? 1
  const sampleRate = options.sampleRate ?? 22050
  const bitsPerSample = options.bitsPerSample ?? 16
  const blockAlign = (channels * bitsPerSample) / 8
  const body = Buffer.alloc(16)
  body.writeUInt16LE(1, 0) // PCM
  body.writeUInt16LE(channels, 2)
  body.writeUInt32LE(sampleRate, 4)
  body.writeUInt32LE(options.byteRate ?? sampleRate * blockAlign, 8)
  body.writeUInt16LE(blockAlign, 12)
  body.writeUInt16LE(bitsPerSample, 14)
  return chunk({ id: 'fmt ', body })
}

function riff(chunks: Buffer[]): Buffer {
  const payload = Buffer.concat(chunks)
  const header = Buffer.alloc(12)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(payload.length + 4, 4)
  header.write('WAVE', 8, 'ascii')
  return Buffer.concat([header, payload])
}

/** One second of 22050Hz mono 16-bit audio. */
const ONE_SECOND_BYTES = 22050 * 2

describe('wavDurationMs', () => {
  it('reads the duration of a plain PCM file', () => {
    const wav = riff([fmtChunk({}), chunk({ id: 'data', body: Buffer.alloc(ONE_SECOND_BYTES) })])
    expect(wavDurationMs(wav)).toBe(1000)
  })

  it('accounts for channels and sample width', () => {
    const wav = riff([
      fmtChunk({ channels: 2, sampleRate: 44100, bitsPerSample: 16 }),
      chunk({ id: 'data', body: Buffer.alloc(44100 * 4) }),
    ])
    expect(wavDurationMs(wav)).toBe(1000)
  })

  it('rounds to the nearest millisecond', () => {
    const wav = riff([fmtChunk({}), chunk({ id: 'data', body: Buffer.alloc(441) })])
    // 441 bytes / 44100 bytes per second = 10.0ms
    expect(wavDurationMs(wav)).toBe(10)
  })

  it('walks past chunks that sit between fmt and data', () => {
    const wav = riff([
      fmtChunk({}),
      // Odd-sized, so the pad byte has to be accounted for or the next chunk
      // header is read one byte out of alignment.
      chunk({ id: 'LIST', body: Buffer.from('INFOhello', 'ascii') }),
      chunk({ id: 'data', body: Buffer.alloc(ONE_SECOND_BYTES) }),
    ])
    expect(wavDurationMs(wav)).toBe(1000)
  })

  it('finds fmt when it follows data', () => {
    const wav = riff([chunk({ id: 'data', body: Buffer.alloc(ONE_SECOND_BYTES) }), fmtChunk({})])
    expect(wavDurationMs(wav)).toBe(1000)
  })

  it('trusts the bytes on disk over a data size that overruns the file', () => {
    const wav = riff([
      fmtChunk({}),
      chunk({ id: 'data', body: Buffer.alloc(ONE_SECOND_BYTES), declaredSize: 0xffffffff }),
    ])
    expect(wavDurationMs(wav)).toBe(1000)
  })

  it('trusts the bytes on disk over a data size left at zero', () => {
    const wav = riff([
      fmtChunk({}),
      chunk({ id: 'data', body: Buffer.alloc(ONE_SECOND_BYTES), declaredSize: 0 }),
    ])
    expect(wavDurationMs(wav)).toBe(1000)
  })

  it('recomputes a byte rate the header left at zero', () => {
    const wav = riff([
      fmtChunk({ byteRate: 0 }),
      chunk({ id: 'data', body: Buffer.alloc(ONE_SECOND_BYTES) }),
    ])
    expect(wavDurationMs(wav)).toBe(1000)
  })

  it('rejects a file that is not a WAV', () => {
    expect(() => wavDurationMs(Buffer.from('this is not audio at all', 'ascii'))).toThrow(
      /not a WAV/,
    )
  })

  it('rejects a buffer too short to hold a header', () => {
    expect(() => wavDurationMs(Buffer.from('RIFF', 'ascii'))).toThrow(/not a WAV/)
  })

  it('rejects a file with no fmt chunk', () => {
    const wav = riff([chunk({ id: 'data', body: Buffer.alloc(ONE_SECOND_BYTES) })])
    expect(() => wavDurationMs(wav)).toThrow(/no usable fmt chunk/)
  })

  it('rejects a file with no data chunk', () => {
    expect(() => wavDurationMs(riff([fmtChunk({})]))).toThrow(/no data chunk/)
  })

  it('rejects a truncated fmt chunk', () => {
    const wav = riff([chunk({ id: 'fmt ', body: Buffer.alloc(8) })])
    expect(() => wavDurationMs(wav)).toThrow(/truncated fmt/)
  })

  it('rejects a clip with no audio in it', () => {
    const wav = riff([fmtChunk({}), chunk({ id: 'data', body: Buffer.alloc(0) })])
    expect(() => wavDurationMs(wav)).toThrow(/no audio/)
  })
})

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

/** A 16-bit mono WAV whose samples are supplied by `sample(i)`. */
function makeWav(sampleRate: number, samples: number, sample: (i: number) => number): Buffer {
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
  for (let i = 0; i < samples; i++) buf.writeInt16LE(sample(i), 44 + i * 2)
  return buf
}

describe('audibleDurationMs', () => {
  it('ignores the pad Piper leaves at the end of every clip', () => {
    const wav = makeWav(1000, 1500, (i) => (i < 1000 ? 8000 : 0))
    expect(wavDurationMs(wav)).toBe(1500)
    expect(audibleDurationMs(wav)).toBe(1000)
  })

  it('keeps silence that sits between words', () => {
    // The gap is speech timing, not padding.
    const wav = makeWav(1000, 1000, (i) => (i < 300 || i >= 700 ? 8000 : 0))
    expect(audibleDurationMs(wav)).toBe(1000)
  })

  it('treats near-silence as padding, not as a quiet ending', () => {
    const wav = makeWav(1000, 1000, (i) => (i < 500 ? 8000 : 5))
    expect(audibleDurationMs(wav)).toBe(500)
  })

  it('returns the full duration for a clip with nothing audible in it', () => {
    // A silent clip is a synthesis failure; reporting 0 would schedule it as
    // though it were instantaneous.
    const wav = makeWav(1000, 800, () => 0)
    expect(audibleDurationMs(wav)).toBe(800)
  })

  it('handles a clip that is audible to its final sample', () => {
    const wav = makeWav(2000, 500, () => -9000)
    expect(audibleDurationMs(wav)).toBe(250)
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
