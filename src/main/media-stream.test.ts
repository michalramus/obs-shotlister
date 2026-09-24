import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import { toWebStream } from './media-stream'

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += Buffer.from(value).toString('utf-8')
  }
  return out
}

describe('toWebStream', () => {
  it('delivers the whole source', async () => {
    const stream = toWebStream(Readable.from([Buffer.from('abc'), Buffer.from('def')]))
    expect(await drain(stream)).toBe('abcdef')
  })

  it('surfaces a read error to the consumer', async () => {
    const source = new Readable({
      read() {
        this.destroy(new Error('disk gone'))
      },
    })
    await expect(drain(toWebStream(source))).rejects.toThrow('disk gone')
  })

  it('destroys the source when the consumer cancels', async () => {
    const source = Readable.from([Buffer.from('abc'), Buffer.from('def')])
    const reader = toWebStream(source).getReader()
    await reader.read()
    await reader.cancel()
    expect(source.destroyed).toBe(true)
  })

  it('does not throw when the source ends after a cancel', async () => {
    // The crash this module exists to prevent: Node's own adapter closes the
    // controller from `end` without checking whether the consumer cancelled
    // first, which reached the process-level uncaughtException handler.
    const source = new Readable({ read() {} })
    const reader = toWebStream(source).getReader()
    await reader.cancel()

    expect(() => {
      source.push(Buffer.from('late'))
      source.push(null)
    }).not.toThrow()
  })

  it('ignores an error arriving after the stream already ended', async () => {
    const source = Readable.from([Buffer.from('abc')])
    const stream = toWebStream(source)
    expect(await drain(stream)).toBe('abc')
    expect(() => source.emit('error', new Error('too late'))).not.toThrow()
  })
})
