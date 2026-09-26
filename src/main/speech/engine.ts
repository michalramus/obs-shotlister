/**
 * The Piper side of Announcement rendering: find the engine, spawn it, get a
 * clip and a duration out of it.
 *
 * This is the only module in the speech cluster that spawns a process, and the
 * only one that needs Electron to know where the binary is. Everything it used
 * to also hold has moved to where it can be tested: the WAV arithmetic to
 * `speech/wav`, the batch policy to `speech/batch`, the file layout behind
 * `speech/clip-store`. What is left is one function behind the
 * {@link Synthesiser} seam, plus the platform paths that lead to it.
 *
 * Nothing in here may run during a Live session (ADR 0005). The caller enforces
 * that; this module would happily synthesise mid-show if asked, which is
 * exactly why the rule is stated where the calls are made.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
// ENGINE_ID is part of every clip hash, so it must never change casually: a
// different id orphans every clip in every cache on the next app start. It lives
// with the hash it is part of — see shared/render-plan.
import { ENGINE_ID, clipHash, type RenderPlanItem } from '../../shared/render-plan'
import { EngineUnusableError, renderFailure } from './batch'
import type { SynthesisedClip, Synthesiser } from './batch'
import type { ClipStore } from './clip-store'
import { audibleDurationMs, trimLeadingSilence } from './wav'
import type { VoiceFiles } from './voices'

// Nothing is re-exported from here any more. This module used to be the one
// import the whole render path went through, which is how the WAV maths, the
// cache layout and the batch policy all ended up behind Electron's `app` and
// out of reach of a test. Callers now import each of those from the module that
// owns it.

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
// Synthesis
// ---------------------------------------------------------------------------

export interface SynthesiseOptions {
  /** Where the finished clip is put. The engine never learns the layout. */
  clips: ClipStore
  /** Electron's `app.getPath('userData')`; the voices hang off it. */
  userDataDir: string
  /** Defaults to 30s. A clip that takes longer than this is a wedged process. */
  timeoutMs?: number
  /** Cancels the spawn, and stops `renderAll` between items. */
  signal?: AbortSignal
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
 * Synthesises one clip into the store and returns its duration.
 *
 * Piper writes to scratch and the bytes only reach the store once they have
 * parsed, so a crashed or killed Piper can never leave a truncated file sitting
 * at a hash that the render log then calls rendered.
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

  // Piper writes to scratch, and the store publishes. Scratch rather than the
  // cache directory because this module no longer knows the layout — and it does
  // not need to: what has to be atomic is the moment a clip becomes visible at
  // its hash, which is the store's business, not the spawn's.
  const scratch = await mkdtemp(join(tmpdir(), 'shotlister-piper-'))
  const temporary = join(scratch, 'out.wav')

  try {
    await runPiper(
      piperArgs(piperCli(), { model, config, binary, outputFile: temporary }),
      item.text,
      opts,
    )
    // Trimmed before it is measured, and before it is stored: the duration the
    // scheduler stores has to describe the file that will actually be played.
    const wav = trimLeadingSilence(await readFile(temporary))
    const durationMs = audibleDurationMs(wav)
    await opts.clips.put(item, wav)
    return { hash: item.hash, durationMs }
  } catch (error) {
    throw renderFailure(item, error)
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * The real {@link Synthesiser}: Piper, bound to one cache and one userData.
 *
 * What `speech/service` and `renderAll` are handed, so neither has to know that
 * Piper exists. A test hands them something else.
 */
export function createPiperSynthesiser(opts: SynthesiseOptions): Synthesiser {
  return (item) => synthesise(item, opts)
}
