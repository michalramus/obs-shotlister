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
  trimLeadingSilence,
  wavDurationMs,
  EngineUnusableError,
  isEngineUnusable,
  renderFailure,
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

describe('trimLeadingSilence', () => {
  /** espeak's pad in front of a bare numeral: quiet, then the word. */
  function padded(sampleRate: number, padSamples: number, speechSamples: number): Buffer {
    return makeWav(sampleRate, padSamples + speechSamples, (i) => (i < padSamples ? 0 : 8000))
  }

  it('cuts the silence espeak puts in front of a digit', () => {
    // 1000Hz makes a sample a millisecond: 260ms of pad, 300ms of speech.
    const wav = padded(1000, 260, 300)
    expect(wavDurationMs(wav)).toBe(560)

    // 10ms of pre-roll is kept on purpose, so 300 + 10.
    expect(wavDurationMs(trimLeadingSilence(wav))).toBe(310)
  })

  it('gives clips with different pads the same onset, which is the whole point', () => {
    // "3", "2" and "1" come back from espeak padded by different amounts. Left
    // alone they are scheduled on exact second marks and heard unevenly.
    const onsets = [120, 260, 310].map((pad) => {
      const trimmed = trimLeadingSilence(padded(1000, pad, 300))
      let first = -1
      for (let i = 44; i < trimmed.length; i += 2) {
        if (Math.abs(trimmed.readInt16LE(i)) > 300) {
          first = (i - 44) / 2
          break
        }
      }
      return first
    })

    expect(onsets).toEqual([10, 10, 10])
  })

  it('makes the clip start speaking when it is played, which is what the scheduler assumes', () => {
    const trimmed = trimLeadingSilence(padded(1000, 260, 300))
    expect(trimmed.readInt16LE(44 + 10 * 2)).toBe(8000)
  })

  it('keeps the audible length intact', () => {
    expect(audibleDurationMs(trimLeadingSilence(padded(1000, 260, 300)))).toBe(310)
  })

  it('leaves a clip that already starts on time alone', () => {
    const wav = makeWav(1000, 300, () => 8000)
    expect(trimLeadingSilence(wav)).toBe(wav)
  })

  it('leaves a clip with less silence than the pre-roll alone', () => {
    const wav = makeWav(1000, 300, (i) => (i < 4 ? 0 : 8000))
    expect(trimLeadingSilence(wav)).toBe(wav)
  })

  it('never slices a silent clip down to nothing', () => {
    // A clip with no audio is a synthesis failure to report, not a buffer to
    // empty — and an empty one would read as a zero-length Announcement.
    const wav = makeWav(1000, 300, () => 0)
    expect(trimLeadingSilence(wav)).toBe(wav)
  })

  it('keeps the trailing pad, which plays harmlessly under the next clip', () => {
    const wav = makeWav(1000, 600, (i) => (i >= 100 && i < 400 ? 8000 : 0))
    const trimmed = trimLeadingSilence(wav)
    // 90 cut from the front, so 600 - 90.
    expect(wavDurationMs(trimmed)).toBe(510)
    expect(audibleDurationMs(trimmed)).toBe(310)
  })

  it('writes a WAV the duration reader still understands', () => {
    const trimmed = trimLeadingSilence(padded(22050, 5000, 6000))
    expect(trimmed.toString('ascii', 0, 4)).toBe('RIFF')
    expect(trimmed.toString('ascii', 8, 12)).toBe('WAVE')
    expect(trimmed.readUInt32LE(24)).toBe(22050)
    expect(trimmed.readUInt32LE(4)).toBe(trimmed.length - 8)
  })

  it('handles stereo without interleaving the channels wrongly', () => {
    const sampleRate = 1000
    const frames = 400
    const buf = Buffer.alloc(44 + frames * 4)
    buf.write('RIFF', 0, 'ascii')
    buf.writeUInt32LE(36 + frames * 4, 4)
    buf.write('WAVE', 8, 'ascii')
    buf.write('fmt ', 12, 'ascii')
    buf.writeUInt32LE(16, 16)
    buf.writeUInt16LE(1, 20)
    buf.writeUInt16LE(2, 22)
    buf.writeUInt32LE(sampleRate, 24)
    buf.writeUInt32LE(sampleRate * 4, 28)
    buf.writeUInt16LE(4, 32)
    buf.writeUInt16LE(16, 34)
    buf.write('data', 36, 'ascii')
    buf.writeUInt32LE(frames * 4, 40)
    for (let i = 0; i < frames; i++) {
      const v = i < 100 ? 0 : 8000
      buf.writeInt16LE(v, 44 + i * 4)
      buf.writeInt16LE(v, 44 + i * 4 + 2)
    }

    const trimmed = trimLeadingSilence(buf)
    expect(trimmed.readUInt16LE(22)).toBe(2)
    // 90 frames cut, both channels, so the body shrinks by 90 * 4 bytes.
    expect(trimmed.length).toBe(buf.length - 90 * 4)
  })

  it('leaves anything that is not 16-bit PCM untouched', () => {
    const wav = riff([
      fmtChunk({ bitsPerSample: 8 }),
      chunk({ id: 'data', body: Buffer.alloc(80) }),
    ])
    expect(trimLeadingSilence(wav)).toBe(wav)
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
