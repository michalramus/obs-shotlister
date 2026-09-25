import { describe, it, expect } from 'vitest'
import { describeDecodeFailure } from './waveform-error'

describe('describeDecodeFailure', () => {
  it('blames the format only when the decoder actually rejected the bytes', () => {
    const err = new Error('Unable to decode audio data')
    err.name = 'EncodingError'
    expect(describeDecodeFailure(err)).toBe('this file is not in a format the app can decode')
  })

  it('calls an interrupted read what it is, rather than blaming the format', () => {
    expect(describeDecodeFailure(new Error('Fetch aborted'))).toBe(
      'reading the file was interrupted',
    )
    expect(describeDecodeFailure(new Error('net::ERR_FAILED'))).toBe(
      'reading the file was interrupted',
    )
  })

  it('passes through any other message rather than inventing a cause', () => {
    expect(describeDecodeFailure(new Error('no space left on device'))).toBe(
      'no space left on device',
    )
  })

  it('handles an empty or non-Error throw', () => {
    expect(describeDecodeFailure(new Error(''))).toBe('the decoder failed without saying why')
    expect(describeDecodeFailure('boom')).toBe('boom')
  })
})
