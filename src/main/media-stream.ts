/**
 * Serving a local file to the renderer over the `media://` protocol.
 *
 * Node's own `Readable.toWeb` closes its controller from the stream's `end`
 * event without checking whether the consumer already cancelled. The renderer
 * cancels routinely — seeking a video, or navigating away from Reference media
 * mid-load — and the result was a steady drip of
 * `ERR_INVALID_STATE: Controller is already closed` reaching the process-level
 * `uncaughtException` handler. Nothing crashed, but a handler that fires in
 * normal use is a handler nobody reads when something real happens.
 *
 * So the adaptation is done here, where cancelling is an expected outcome
 * rather than an error, and where it can be tested without a filesystem.
 */

import type { Readable } from 'node:stream'

/**
 * Wraps a Node readable as a web `ReadableStream`, exactly once.
 *
 * Backpressure is honoured: the source is paused when the consumer's queue is
 * full and resumed on `pull`, so a large Reference media file is not read into
 * memory faster than it is sent.
 */
export function toWebStream(source: Readable): ReadableStream<Uint8Array> {
  // One latch for all three endings — end, error and cancel. Whichever happens
  // first wins, and the others become no-ops rather than throwing.
  let settled = false
  const settle = (act: () => void): void => {
    if (settled) return
    settled = true
    act()
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      source.on('data', (chunk: Buffer) => {
        if (settled) return
        controller.enqueue(new Uint8Array(chunk))
        // desiredSize goes negative once the consumer is behind.
        if ((controller.desiredSize ?? 1) <= 0) source.pause()
      })
      source.on('end', () => settle(() => controller.close()))
      source.on('error', (error) => settle(() => controller.error(error)))
    },

    pull() {
      if (!settled) source.resume()
    },

    cancel() {
      // Destroying the file handle is the point: without it a cancelled seek
      // leaks a descriptor per request.
      settle(() => undefined)
      source.destroy()
    },
  })
}
