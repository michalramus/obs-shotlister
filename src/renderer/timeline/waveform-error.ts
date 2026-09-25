/**
 * Saying why a waveform did not load.
 *
 * The lane used to show "unsupported format?" for every failure — a fetch that
 * 404'd, a file the OS refused to read, and a codec Chromium genuinely cannot
 * decode all produced the same guess. That guess sent at least one operator
 * looking for a problem with their MP3s when the format was never in question.
 *
 * So the reason is derived from the error rather than assumed, and it is phrased
 * for the person looking at the timeline, not for a log.
 */

/** A short, human reason for a failed waveform decode. */
export function describeDecodeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)

  // Chromium throws EncodingError from decodeAudioData when it cannot decode the
  // bytes at all. This is the one case where the format really is the problem.
  if (error instanceof Error && error.name === 'EncodingError') {
    return 'this file is not in a format the app can decode'
  }
  // A cancelled or truncated stream is a read problem, not a format problem.
  if (/aborted|cancel|network|ERR_/i.test(message)) {
    return 'reading the file was interrupted'
  }
  if (message.trim() === '') return 'the decoder failed without saying why'
  return message
}
