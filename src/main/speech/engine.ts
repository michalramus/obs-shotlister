/**
 * The Piper side of Announcement rendering: spawn the engine, get a clip and a
 * duration out of it.
 *
 * Everything that decides *what* to speak and *when* lives elsewhere and is
 * pure — `shared/render-plan` decides which clips a Project still needs,
 * `shared/announcement` decides where each one lands in time. This module is
 * the part that cannot be pure: a child process, a WAV file and a rename. It
 * holds no state, reads no database and knows nothing about Parts.
 *
 * Nothing in here may run during a Live session (ADR 0005). The caller enforces
 * that; this module would happily synthesise mid-show if asked, which is
 * exactly why the rule is stated where the calls are made.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { access, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { clipHash, type RenderPlanItem } from '../../shared/render-plan'
import { clipPath, ensureClipsDir } from './cache'
import type { VoiceFiles } from './voices'

export { CLIP_EXTENSION, clipPath, clipsDir, listCachedHashes, sweep } from './cache'

/**
 * Part of every clip hash, so it must never change casually: a different engine
 * id orphans every clip in every cache on the next app start.
 */
// Re-exported so one import of this module serves the whole render path, but
// defined with the hash it is part of — see shared/render-plan.
export { ENGINE_ID } from '../../shared/render-plan'
import { ENGINE_ID } from '../../shared/render-plan'

/** Piper is fast, but a wedged child process must not hold a render batch open. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Enough stderr to explain a failure, not enough to matter if Piper loops. */
const STDERR_LIMIT = 8192

/** A Voice id is a filename. Anything else could walk out of the voices directory. */
const VOICE_PATTERN = /^[A-Za-z0-9_-]+$/

// ---------------------------------------------------------------------------
// Where the bundled engine lives
// ---------------------------------------------------------------------------

/**
 * In a packaged app electron-builder copies only the host platform's engine, to
 * `resources/piper`. In the repo every platform sits side by side under
 * `resources/piper/<platform>-<arch>`, because `yarn fetch:piper all` may have
 * fetched several.
 */
function piperDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'piper')
    : join(app.getAppPath(), 'resources', 'piper', `${process.platform}-${process.arch}`)
}

/**
 * Voices shipped inside the app bundle.
 *
 * Normally empty: nothing is bundled any more (ADR 0007). Kept as the first
 * place looked in, because `scripts/fetch-piper.mjs` can still be pointed at a
 * voice to ship one, and a bundled copy was verified at build time so it should
 * win over anything later written into userData. Read-only in a packaged build,
 * which is why it cannot also be where a downloaded voice lands.
 */
export function bundledVoicesDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'piper-voices')
    : join(app.getAppPath(), 'resources', 'piper-voices')
}

/**
 * Where a voice fetched at runtime is kept.
 *
 * Under userData rather than in the app bundle, for the same reason the clip
 * cache is: a packaged app's resources are read-only, and this is per-operator
 * anyway — one machine's set of voices is not a property of the install.
 */
export function downloadedVoicesDir(userDataDir: string): string {
  return join(userDataDir, 'piper-voices')
}

export function piperBinaryPath(): string {
  return join(piperDir(), process.platform === 'win32' ? 'piper.exe' : 'piper')
}

/**
 * Which command line the installed Piper speaks.
 *
 * - `full`: the upstream C++ CLI — `--config`, `--espeak_data`,
 *   `--sentence_silence` and the rest.
 * - `minimal`: the community arm64 build, which is the Python Piper wrapped by
 *   PyInstaller and takes `--model` and `--output_file` and nothing else.
 *
 * Written beside the binary by `scripts/fetch-piper.mjs`, which already knows
 * which one it installed — cheaper and more certain than probing `--help`.
 * A missing stamp means an engine fetched before this existed, which can only
 * be the upstream build.
 */
export type PiperCli = 'full' | 'minimal'

export function piperCli(): PiperCli {
  try {
    const stamp = readFileSync(join(piperDir(), 'piper-cli.txt'), 'utf-8').trim()
    if (stamp === 'minimal' || stamp === 'full') return stamp
  } catch {
    /* fall through to the platform default */
  }
  return defaultPiperCli(process.platform, process.arch)
}

/**
 * What to assume when the stamp is missing or unreadable.
 *
 * Only Apple Silicon has no upstream build, so only it runs the community
 * binary and its smaller CLI. Guessing `full` everywhere would make a packaging
 * slip show up as every clip failing on exactly one platform — the quietest
 * possible way to break speech.
 */
export function defaultPiperCli(platform: string, arch: string): PiperCli {
  return platform === 'darwin' && arch === 'arm64' ? 'minimal' : 'full'
}

/**
 * The arguments this binary understands.
 *
 * The minimal CLI infers the config from the model path and bundles its own
 * espeak data, so the flags it lacks are ones it does not need — except
 * `--sentence_silence`, whose absence leaves a trailing pad on every clip.
 * That one is handled when the clip is measured; see {@link audibleDurationMs}.
 */
export function piperArgs(
  cli: PiperCli,
  paths: { model: string; config: string; binary: string; outputFile: string },
): string[] {
  if (cli === 'minimal') {
    return ['--model', paths.model, '--output_file', paths.outputFile]
  }
  return [
    '--model',
    paths.model,
    '--config',
    paths.config,
    '--espeak_data',
    join(paths.binary, '..', 'espeak-ng-data'),
    // Piper pads every utterance with 0.2s of silence by default. Flush
    // placement schedules the phrase backwards from the first number using
    // this clip's duration, so padding would open a gap exactly where the
    // sentence is meant to be continuous.
    '--sentence_silence',
    '0',
    '--output_file',
    paths.outputFile,
  ]
}

/**
 * Where a voice's model and config are, if they are anywhere.
 *
 * The bundled directory wins over the downloaded one: a voice that shipped with
 * the app is the one that was verified at build time, and an operator should
 * never end up running a different copy of it because something once wrote into
 * userData.
 *
 * Piper's own convention puts the config beside the model as `<model>.json`, so
 * a directory holding one and not the other is a half-installed voice and does
 * not count.
 */
export function resolveVoice(voice: string, userDataDir: string): VoiceFiles | null {
  if (!VOICE_PATTERN.test(voice)) throw new Error(`invalid voice id ${JSON.stringify(voice)}`)

  for (const dir of [bundledVoicesDir(), downloadedVoicesDir(userDataDir)]) {
    const model = join(dir, `${voice}.onnx`)
    const config = `${model}.json`
    if (existsSync(model) && existsSync(config)) return { model, config }
  }
  return null
}

// ---------------------------------------------------------------------------
// WAV duration
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

export interface SynthesiseOptions {
  /** Electron's `app.getPath('userData')`; the cache hangs off it. */
  userDataDir: string
  /** Defaults to 30s. A clip that takes longer than this is a wedged process. */
  timeoutMs?: number
  /** Cancels the spawn, and stops `renderAll` between items. */
  signal?: AbortSignal
}

export interface SynthesisedClip {
  hash: string
  durationMs: number
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Marks a failure as "the engine cannot run at all", as opposed to "this one
 * clip did not render".
 *
 * The difference matters to a batch: one bad clip is worth skipping past, but
 * an engine that cannot be executed will fail identically for all sixty-one,
 * and logging that sixty-one times buries the one line that explains it.
 */
export class EngineUnusableError extends Error {
  readonly engineUnusable = true
}

export function isEngineUnusable(error: unknown): boolean {
  return error instanceof EngineUnusableError
}

/**
 * Names the clip that failed, without losing whether the engine can run at all.
 *
 * The naming used to be done with a plain `new Error`, which quietly downgraded
 * every spawn failure: `runPiper` reports EBADARCH and EACCES as unusable, the
 * rewrap made them ordinary, and `renderAll` then carried on to the next clip.
 * The mislabelled-arm64 case — the one with a whole paragraph of advice written
 * for it — printed that paragraph sixty-one times.
 */
export function renderFailure(item: { text: string; voice: string }, error: unknown): Error {
  const message = `rendering "${item.text}" (${item.voice}): ${messageOf(error)}`
  return isEngineUnusable(error) ? new EngineUnusableError(message) : new Error(message)
}

/**
 * Turns a spawn failure into something an operator can act on.
 *
 * Node reports a macOS architecture mismatch as `Unknown system error -86`,
 * which says nothing. -86 is EBADARCH: the binary is built for another CPU —
 * which is exactly what upstream's mislabelled `aarch64` Piper does on an
 * Apple Silicon machine with no Rosetta.
 */
export function spawnFailureMessage(error: NodeJS.ErrnoException, binary: string): string {
  if (error.errno === -86 || error.code === 'EBADARCH') {
    return (
      'the bundled Piper is built for the wrong CPU architecture and cannot run.\n' +
      `  ${binary}\n` +
      '  Build one for this machine — see .github/workflows/build-piper-macos-arm64.yml —\n' +
      '  or install Rosetta 2 with: softwareupdate --install-rosetta'
    )
  }
  if (error.code === 'ENOENT') {
    return `Piper is not installed at ${binary}. Run: yarn fetch:piper`
  }
  if (error.code === 'EACCES') {
    return `Piper at ${binary} is not executable.`
  }
  return `piper could not be started: ${error.message}`
}

function engineUnusable(error: NodeJS.ErrnoException): EngineUnusableError {
  return new EngineUnusableError(spawnFailureMessage(error, piperBinaryPath()))
}

/**
 * Missing here is an engine problem, not a clip problem.
 *
 * A binary or a voice that is not on disk will be just as absent for the sixty
 * clips behind this one, so this is raised as unusable: the batch stops after
 * one line instead of repeating the same sentence sixty-one times, which is how
 * a missing voice used to fill a terminal and hide everything above it.
 */
async function assertReadable(path: string, what: string): Promise<void> {
  try {
    await access(path)
  } catch {
    throw new EngineUnusableError(`${what} is missing: ${path} — run \`yarn fetch:piper\``)
  }
}

/**
 * Runs Piper once, with the text on stdin.
 *
 * Every way this can go wrong ends as a rejected promise with a message that
 * names the cause: the binary is not there, the process was killed, it exited
 * non-zero. Nothing is left to an uncaught 'error' event, which in the main
 * process would take the app down.
 */
function runPiper(args: string[], text: string, opts: SynthesiseOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const dir = join(piperBinaryPath(), '..')
    const env = { ...process.env }
    // The Linux build ships its own libonnxruntime and libespeak-ng beside the
    // binary and does not find them on its own. macOS is statically linked and
    // Windows resolves DLLs next to the .exe, so neither needs help.
    if (process.platform === 'linux') {
      env.LD_LIBRARY_PATH = [dir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')
    }

    const child = spawn(piperBinaryPath(), args, { cwd: dir, env })

    let stderr = ''
    let settled = false
    let killedFor: string | null = null

    const finish = (error: Error | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }

    const kill = (reason: string): void => {
      killedFor = reason
      child.kill('SIGKILL')
    }

    const timer = setTimeout(() => kill('timed out'), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const onAbort = (): void => kill('was cancelled')
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.toString('utf-8')
    })

    // A child that dies before reading stdin turns the write into an EPIPE
    // error event; without this listener that event is fatal to the process.
    child.stdin.on('error', () => undefined)
    child.stdin.end(`${text}\n`)

    child.on('error', (error) => finish(engineUnusable(error)))
    child.on('close', (code) => {
      if (killedFor) return finish(new Error(`piper ${killedFor}`))
      if (code === 0) return finish(null)
      const detail = stderr.trim()
      finish(new Error(`piper exited with code ${code}${detail ? `: ${detail}` : ''}`))
    })
  })
}

/**
 * Synthesises one clip into the cache and returns its duration.
 *
 * The WAV is written to a temporary name in the cache directory and renamed
 * into place only once it has parsed, so a crashed or killed Piper can never
 * leave a truncated file sitting at a hash that the render log then calls
 * rendered.
 */
export async function synthesise(
  item: RenderPlanItem,
  opts: SynthesiseOptions,
): Promise<SynthesisedClip> {
  if (item.engine !== ENGINE_ID) {
    throw new Error(`cannot render engine ${JSON.stringify(item.engine)} with ${ENGINE_ID}`)
  }
  // The filename is a claim about the contents. Checking it here means a
  // hand-built item can never poison the cache with a clip that says something
  // other than what its hash promises.
  if (clipHash(item.text, item.voice, item.engine) !== item.hash) {
    throw new Error(`clip hash does not match its text and voice: ${item.hash}`)
  }
  if (item.text.trim().length === 0) throw new Error('nothing to synthesise: empty text')
  // Piper reads one utterance per stdin line, so a newline would silently
  // produce a second clip on top of the first.
  if (/[\r\n]/.test(item.text)) throw new Error('cannot synthesise text containing a newline')

  const binary = piperBinaryPath()
  await assertReadable(binary, 'the Piper binary')

  // Installing it is the caller's job, done once per batch before any of this —
  // downloading a model in here would do it per clip. By now it is either on
  // disk or the batch should already have stopped.
  const voiceFiles = resolveVoice(item.voice, opts.userDataDir)
  if (!voiceFiles) {
    throw new EngineUnusableError(`voice ${item.voice} is not installed, and could not be fetched`)
  }
  const { model, config } = voiceFiles

  const dir = await ensureClipsDir(opts.userDataDir)
  const temporary = join(dir, `.${item.hash}.${randomBytes(6).toString('hex')}.part`)

  try {
    await runPiper(
      piperArgs(piperCli(), { model, config, binary, outputFile: temporary }),
      item.text,
      opts,
    )
    // Trimmed before it is measured, and before it is named: the duration the
    // scheduler stores has to describe the file that will actually be played.
    const wav = trimLeadingSilence(await readFile(temporary))
    await writeFile(temporary, wav)
    const durationMs = audibleDurationMs(wav)
    await rename(temporary, clipPath(opts.userDataDir, item.hash))
    return { hash: item.hash, durationMs }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw renderFailure(item, error)
  }
}

// ---------------------------------------------------------------------------
// Batch rendering
// ---------------------------------------------------------------------------

export interface RenderFailure {
  item: RenderPlanItem
  message: string
}

export interface RenderProgress {
  /** Items attempted so far, successes and failures alike. */
  completed: number
  total: number
  item: RenderPlanItem
  /**
   * The clip, once it is on disk. Reported per item rather than only in the
   * final result so the caller can persist each duration as it lands — a batch
   * of sixty clips takes minutes, and a render interrupted halfway must not
   * leave audio on disk that nothing knows the length of.
   */
  clip?: SynthesisedClip
  /** Present when this item failed. */
  error?: string
}

export interface RenderAllResult {
  rendered: SynthesisedClip[]
  failed: RenderFailure[]
  /** True when the caller cancelled before every item was attempted. */
  aborted: boolean
  /**
   * Set when the batch stopped because the engine itself cannot run, rather
   * than because individual clips failed. The remaining items were not tried.
   */
  engineFailure?: string
}

/**
 * Renders a list of clips one at a time.
 *
 * Sequential on purpose: this runs on the machine that is about to drive a
 * show, and a parallel render of sixty number clips would peg every core of the
 * operator's laptop minutes before doors.
 *
 * One bad item never takes the batch with it. The operator asked to render
 * everything missing; sixty-one clips and one clear failure is a far better
 * outcome than nothing and a stack trace.
 */
export async function renderAll(
  items: readonly RenderPlanItem[],
  opts: SynthesiseOptions,
  onProgress?: (progress: RenderProgress) => void,
): Promise<RenderAllResult> {
  const rendered: SynthesisedClip[] = []
  const failed: RenderFailure[] = []
  let aborted = false
  let engineFailure: string | undefined

  const report = (progress: RenderProgress): void => {
    // A listener that throws is the caller's bug, not a reason to abandon the
    // clips still to render.
    try {
      onProgress?.(progress)
    } catch {
      /* ignored */
    }
  }

  for (const item of items) {
    if (opts.signal?.aborted) {
      aborted = true
      break
    }
    let error: string | undefined
    let fatal = false
    let clip: SynthesisedClip | undefined
    try {
      clip = await synthesise(item, opts)
      rendered.push(clip)
    } catch (caught) {
      error = messageOf(caught)
      fatal = isEngineUnusable(caught)
      failed.push({ item, message: error })
    }
    report({ completed: rendered.length + failed.length, total: items.length, item, clip, error })

    // Nothing else in this batch can succeed, and repeating the same message
    // for every remaining clip hides it rather than emphasising it.
    if (fatal) {
      engineFailure = error
      break
    }
  }

  return { rendered, failed, aborted, engineFailure }
}
