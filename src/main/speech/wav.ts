/**
 * WAV arithmetic: how long a clip runs, how long it actually speaks, and where
 * its speech starts.
 *
 * Split out of `speech/engine` because none of it is about Piper. It is pure
 * buffer maths — no child process, no filesystem, no Electron — and it is the
 * part of rendering that decides *timing*: flush placement schedules an
 * Announcement backwards from the first countdown number using these numbers,
 * so a wrong one silently mis-times every Announcement in the show. That is why
 * it lives where it can be proved against hand-built headers.
 */

const RIFF_HEADER_BYTES = 12
const CHUNK_HEADER_BYTES = 8

/**
 * How long a WAV runs, in milliseconds, read from its own header.
 *
 * This number is load-bearing: flush placement schedules the phrase backwards
 * from the first countdown number using it, so a wrong duration silently
 * mis-times every Announcement. It is read here rather than asked of an
 * external tool precisely so it can be proved in a unit test.
 *
 * Chunks are walked rather than assumed to be at fixed offsets — Piper writes a
 * plain 44-byte header today, but a `LIST` chunk before `data` is legal WAV and
 * would shift everything.
 */
export function wavDurationMs(wav: Buffer): number {
  if (wav.length < RIFF_HEADER_BYTES) throw new Error('not a WAV file: too short for a header')
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV file: missing RIFF/WAVE header')
  }

  let byteRate = 0
  let audioBytes = -1
  let offset = RIFF_HEADER_BYTES

  while (offset + CHUNK_HEADER_BYTES <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const declared = wav.readUInt32LE(offset + 4)
    const body = offset + CHUNK_HEADER_BYTES

    if (id === 'fmt ') {
      if (declared < 16 || body + 16 > wav.length) throw new Error('malformed WAV: truncated fmt')
      byteRate = wav.readUInt32LE(body + 8)
      if (byteRate === 0) {
        // A zero byte rate is legal-ish in the wild; the three fields it is
        // derived from are mandatory, so recompute rather than give up.
        const channels = wav.readUInt16LE(body + 2)
        const sampleRate = wav.readUInt32LE(body + 4)
        const bitsPerSample = wav.readUInt16LE(body + 14)
        byteRate = sampleRate * channels * Math.ceil(bitsPerSample / 8)
      }
    } else if (id === 'data') {
      // A writer that died before rewinding leaves a size of 0 or 0xFFFFFFFF.
      // What is actually on disk is the honest answer in both cases.
      const available = wav.length - body
      audioBytes = declared === 0 || declared > available ? available : declared
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = body + declared + (declared % 2)
  }

  if (byteRate <= 0) throw new Error('malformed WAV: no usable fmt chunk')
  if (audioBytes < 0) throw new Error('malformed WAV: no data chunk')
  if (audioBytes === 0) throw new Error('malformed WAV: no audio in data chunk')

  return Math.round((audioBytes / byteRate) * 1000)
}

/** Anything quieter than this is padding, not speech. ~1% of full scale. */
const SILENCE_FLOOR = 300

/**
 * How long a clip actually *says* something, ignoring the pad at the end.
 *
 * This is the number flush placement schedules against, and it has to be the
 * audible length rather than the file length: Piper pads every utterance, and
 * a pad counted as speech opens a gap exactly where the phrase is meant to run
 * continuously into the first countdown number. The upstream CLI can be told
 * not to pad; the arm64 build has no such flag, so the pad is measured away
 * here instead and both behave the same.
 *
 * The file keeps its padding — trimming the audio would gain nothing, since
 * clips are scheduled independently and a trailing silence simply plays under
 * the next one.
 *
 * Falls back to the full duration for anything not 16-bit PCM, and for a clip
 * with no audible content at all: a zero-length clip would be a worse answer
 * than an honest one.
 */
export function audibleDurationMs(wav: Buffer): number {
  const full = wavDurationMs(wav)

  const view = pcm16View(wav)
  if (view === null) return full

  const { start, sampleCount, frameBytes, sampleRate } = view
  let lastAudible = -1
  for (let i = 0; i < sampleCount; i++) {
    if (Math.abs(wav.readInt16LE(start + i * frameBytes)) > SILENCE_FLOOR) lastAudible = i
  }
  if (lastAudible < 0) return full

  return Math.min(full, Math.round(((lastAudible + 1) / sampleRate) * 1000))
}

/**
 * How much silence to leave in front of the first audible sample, in ms.
 *
 * Cutting exactly on the threshold crossing would shave the attack off a
 * plosive — the "t" of "trzy" is mostly a transient that never reaches the
 * floor. Ten milliseconds is inaudible against a countdown mark and keeps the
 * consonant. It is a fixed amount, which is the whole point: every clip then
 * starts speaking the same distance into itself.
 */
const ONSET_PREROLL_MS = 10

/**
 * Removes the silence espeak puts in front of an utterance.
 *
 * Numerals get a couple of hundred milliseconds of it where words get none, and
 * — the part that actually shows — *not the same amount each time*. Countdown
 * numbers are scheduled on exact one-second marks, so clips whose speech starts
 * at different offsets inside themselves are heard at uneven intervals: "3 2 1"
 * comes out limping even though the schedule is perfect.
 *
 * Normalising the onset here is what makes the schedule audible. Measuring the
 * offset instead and correcting for it would push that correction through the
 * plan, the database and the renderer; cutting it once, at the point the file is
 * written, leaves every clip with the property the scheduler already assumes —
 * that it starts speaking when you play it.
 *
 * Only the front. The trailing pad is left alone: it is silence that plays
 * harmlessly under the next clip, and `audibleDurationMs` already measures past
 * it.
 *
 * Anything not 16-bit PCM, or already tight, comes back untouched.
 */
export function trimLeadingSilence(wav: Buffer): Buffer {
  const view = pcm16View(wav)
  if (view === null) return wav

  const { start, sampleCount, frameBytes, sampleRate, channels } = view
  let firstAudible = -1
  for (let i = 0; i < sampleCount; i++) {
    if (Math.abs(wav.readInt16LE(start + i * frameBytes)) > SILENCE_FLOOR) {
      firstAudible = i
      break
    }
  }
  // Nothing audible at all is left exactly as it is: a clip of pure silence is
  // a rendering failure to report, not a buffer to slice to nothing.
  if (firstAudible < 0) return wav

  const preroll = Math.round((ONSET_PREROLL_MS / 1000) * sampleRate)
  const cutFrames = Math.max(0, firstAudible - preroll)
  if (cutFrames === 0) return wav

  const body = wav.subarray(start + cutFrames * frameBytes, start + sampleCount * frameBytes)
  return canonicalWav(body, sampleRate, channels)
}

/**
 * A plain 44-byte-header PCM WAV around `body`.
 *
 * The trimmed clip is rebuilt rather than patched: the source may carry extra
 * chunks whose offsets a naive splice would invalidate, and every consumer of
 * these files only ever wants the samples.
 */
function canonicalWav(body: Buffer, sampleRate: number, channels: number): Buffer {
  const bytesPerSample = 2
  const byteRate = sampleRate * channels * bytesPerSample
  const header = Buffer.alloc(44)

  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + body.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(channels * bytesPerSample, 32)
  header.writeUInt16LE(8 * bytesPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(body.length, 40)

  return Buffer.concat([header, body])
}

/** The `data` chunk of a 16-bit PCM WAV, or null when it is anything else. */
function pcm16View(wav: Buffer): {
  start: number
  sampleCount: number
  frameBytes: number
  sampleRate: number
  channels: number
} | null {
  if (wav.length < RIFF_HEADER_BYTES) return null

  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let start = -1
  let length = 0
  let offset = RIFF_HEADER_BYTES

  while (offset + CHUNK_HEADER_BYTES <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const declared = wav.readUInt32LE(offset + 4)
    const body = offset + CHUNK_HEADER_BYTES

    if (id === 'fmt ' && body + 16 <= wav.length) {
      channels = wav.readUInt16LE(body + 2)
      sampleRate = wav.readUInt32LE(body + 4)
      bitsPerSample = wav.readUInt16LE(body + 14)
    } else if (id === 'data') {
      const available = wav.length - body
      start = body
      length = declared === 0 || declared > available ? available : declared
    }
    offset = body + declared + (declared % 2)
  }

  if (bitsPerSample !== 16 || channels < 1 || sampleRate <= 0 || start < 0) return null
  const frameBytes = 2 * channels
  return {
    start,
    sampleCount: Math.floor(length / frameBytes),
    frameBytes,
    sampleRate,
    channels,
  }
}
