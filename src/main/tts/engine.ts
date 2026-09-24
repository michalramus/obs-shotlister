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
import { access, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { clipHash, type RenderPlanItem } from '../../shared/render-plan'
import { clipPath, ensureClipsDir } from './cache'

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

function voicesDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'piper-voices')
    : join(app.getAppPath(), 'resources', 'piper-voices')
}

export function piperBinaryPath(): string {
  return join(piperDir(), process.platform === 'win32' ? 'piper.exe' : 'piper')
}

export function voiceModelPath(voice: string): string {
  if (!VOICE_PATTERN.test(voice)) throw new Error(`invalid voice id ${JSON.stringify(voice)}`)
  return join(voicesDir(), `${voice}.onnx`)
}

/** Piper's own convention: the config sits beside the model as `<model>.json`. */
export function voiceConfigPath(voice: string): string {
  return `${voiceModelPath(voice)}.json`
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
class EngineUnusableError extends Error {
  readonly engineUnusable = true
}

export function isEngineUnusable(error: unknown): boolean {
  return error instanceof EngineUnusableError
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

async function assertReadable(path: string, what: string): Promise<void> {
  try {
    await access(path)
  } catch {
    throw new Error(`${what} is missing: ${path} — run \`yarn fetch:piper\``)
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
  const model = voiceModelPath(item.voice)
  const config = voiceConfigPath(item.voice)
  await assertReadable(binary, 'the Piper binary')
  await assertReadable(model, `voice ${item.voice}`)
  await assertReadable(config, `the config for voice ${item.voice}`)

  const dir = await ensureClipsDir(opts.userDataDir)
  const temporary = join(dir, `.${item.hash}.${randomBytes(6).toString('hex')}.part`)

  try {
    await runPiper(
      [
        '--model',
        model,
        '--config',
        config,
        '--espeak_data',
        join(binary, '..', 'espeak-ng-data'),
        // Piper pads every utterance with 0.2s of silence by default. Flush
        // placement schedules the phrase backwards from the first number using
        // this clip's duration, so padding would open a gap exactly where the
        // sentence is meant to be continuous.
        '--sentence_silence',
        '0',
        '--output_file',
        temporary,
      ],
      item.text,
      opts,
    )
    const durationMs = wavDurationMs(await readFile(temporary))
    await rename(temporary, clipPath(opts.userDataDir, item.hash))
    return { hash: item.hash, durationMs }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw new Error(`rendering "${item.text}" (${item.voice}): ${messageOf(error)}`)
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
    try {
      rendered.push(await synthesise(item, opts))
    } catch (caught) {
      error = messageOf(caught)
      fatal = isEngineUnusable(caught)
      failed.push({ item, message: error })
    }
    report({ completed: rendered.length + failed.length, total: items.length, item, error })

    // Nothing else in this batch can succeed, and repeating the same message
    // for every remaining clip hides it rather than emphasising it.
    if (fatal) {
      engineFailure = error
      break
    }
  }

  return { rendered, failed, aborted, engineFailure }
}
