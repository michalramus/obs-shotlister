/**
 * Getting a Voice model onto disk.
 *
 * No voice ships with the app (ADR 0007). Every one the operator names is
 * obtained at runtime, because a model is 60-110MB, there are hundreds of them,
 * and whichever were bundled would land in every installer for a voice most
 * operators change anyway.
 *
 * This does not weaken ADR 0005. What that decision forbids is a show depending
 * on a network: synthesis never happens during a Live session, and playback
 * reads finished clips off local disk. A download happens where rendering
 * happens — before the show, on a machine that still has a network — and if it
 * fails, it fails then, loudly, with time to do something about it.
 *
 * Nothing here is trusted on faith. The catalogue is pinned to one immutable
 * Hugging Face revision, and every byte is checked against the digest that
 * revision publishes for it before it is allowed near the cache.
 */

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * The catalogue revision every voice is taken from.
 *
 * MUST match `VOICES_REVISION` in scripts/fetch-piper.mjs — a test asserts it,
 * because the two halves of voice installation, build time and runtime, have to
 * agree. Were they to drift, the same voice id would mean different audio
 * depending on how it arrived, and a clip hash says nothing about which.
 *
 * Pinned to a commit rather than `main` for the reason that script gives: the
 * repository is mutable, and a voice that changes under us re-synthesises every
 * clip in every cache.
 */
export const VOICES_REVISION = 'c10ece1aade47bb51c153c893d14e5bf8e5b7117'

const VOICES_REPO = 'rhasspy/piper-voices'
const TREE_API = `https://huggingface.co/api/models/${VOICES_REPO}/tree/${VOICES_REVISION}`
const FILE_BASE = `https://huggingface.co/${VOICES_REPO}/resolve/${VOICES_REVISION}`

/** A Voice id is a filename. Anything else could walk out of the voices directory. */
const VOICE_PATTERN = /^[A-Za-z0-9_-]+$/

/** Long enough for a 100MB model on a venue's wifi, short enough to not hang a render. */
const DOWNLOAD_TIMEOUT_MS = 300_000

export interface VoiceFiles {
  model: string
  config: string
}

/**
 * Where a voice id lives in the catalogue.
 *
 * Ids read `<lang>-<name>-<quality>`, and the repository nests them as
 * `<language>/<lang>/<name>/<quality>` — so `pl_PL-bass-high` is
 * `pl/pl_PL/bass/high`. The name is taken as everything between the first and
 * last dash rather than by splitting on every dash, because names contain
 * underscores and occasionally read like two words (`mc_speech`, `mls_6892`).
 */
export function voiceRepoPath(voice: string): string | null {
  const firstDash = voice.indexOf('-')
  const lastDash = voice.lastIndexOf('-')
  if (firstDash < 1 || lastDash <= firstDash || lastDash === voice.length - 1) return null

  const lang = voice.slice(0, firstDash)
  const name = voice.slice(firstDash + 1, lastDash)
  const quality = voice.slice(lastDash + 1)

  const language = lang.split('_')[0]
  if (!/^[a-z]{2,3}$/.test(language)) return null

  return `${language}/${lang}/${name}/${quality}`
}

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------

/**
 * Hugging Face publishes two different digests, and which one applies depends on
 * how the file is stored.
 *
 * Large files are LFS pointers, and their `lfs.oid` is the SHA-256 of the
 * content — that is the model. Small files are stored as ordinary git blobs,
 * whose `oid` is a SHA-1 over the blob header followed by the content — that is
 * the config. Checking the wrong one would pass on anything, so the entry says
 * which it is.
 */
interface TreeEntry {
  path: string
  size: number
  oid: string
  lfs?: { oid: string; size: number }
}

function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex')
}

/** SHA-1 over `blob <size>` + NUL + content, which is how git names a blob. */
function gitBlobSha1(body: Buffer): string {
  const header = Buffer.concat([Buffer.from(`blob ${body.length}`, 'utf-8'), Buffer.from([0])])
  return createHash('sha1').update(header).update(body).digest('hex')
}

function digestOf(entry: TreeEntry, body: Buffer): { actual: string; expected: string } {
  return entry.lfs
    ? { actual: sha256(body), expected: entry.lfs.oid }
    : { actual: gitBlobSha1(body), expected: entry.oid }
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal, redirect: 'follow' })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`)
  }
  return response.json()
}

/**
 * Downloads one file, verifies it, and only then puts it where it belongs.
 *
 * The bytes are collected as they arrive and the result lands on a temporary
 * name, so a truncated or tampered download is never visible under the real
 * one — the same rule `scripts/fetch-piper.mjs` follows, for the same reason.
 */
async function downloadVerified(
  url: string,
  destination: string,
  entry: TreeEntry,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(url, { signal, redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`)
  }

  const temporary = `${destination}.part`
  const chunks: Buffer[] = []
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  source.on('data', (chunk: Buffer) => chunks.push(chunk))

  try {
    await pipeline(source, createWriteStream(temporary))
    const { actual, expected } = digestOf(entry, Buffer.concat(chunks))
    if (actual !== expected) {
      throw new Error(
        `checksum mismatch for ${entry.path}\n  expected ${expected}\n  actual   ${actual}\n` +
          'The pinned catalogue revision should never change, so this is a corrupt or ' +
          'intercepted download. Nothing was installed.',
      )
    }
    await rename(temporary, destination)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export interface EnsureVoiceOptions {
  /** Where a downloaded voice is kept: `<userData>/piper-voices`. */
  voicesDir: string
  /** Called once, before a download starts, so a slow render can say what it is doing. */
  onDownload?: (voice: string, bytes: number) => void
  signal?: AbortSignal
}

/**
 * Makes sure a voice's model and config are on disk, downloading them if they
 * are not, and returns where they ended up.
 *
 * A voice already present is the fast path and costs two `access` calls — this
 * runs before every render, and the normal answer is "it is already here".
 */
export async function ensureVoice(voice: string, opts: EnsureVoiceOptions): Promise<VoiceFiles> {
  if (!VOICE_PATTERN.test(voice)) throw new Error(`invalid voice id ${JSON.stringify(voice)}`)

  const model = join(opts.voicesDir, `${voice}.onnx`)
  const config = `${model}.json`
  if ((await exists(model)) && (await exists(config))) return { model, config }

  const repoPath = voiceRepoPath(voice)
  if (repoPath === null) {
    throw new Error(
      `"${voice}" is not a voice id. They read <language>-<name>-<quality>, ` +
        'for example pl_PL-gosia-medium.',
    )
  }

  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout

  let listing: unknown
  try {
    listing = await fetchJson(`${TREE_API}/${repoPath}`, signal)
  } catch (error) {
    throw new Error(
      `Could not reach the voice catalogue to install "${voice}": ${
        error instanceof Error ? error.message : String(error)
      }\n  Voices are downloaded once, ahead of a show — this needs a network.`,
    )
  }

  const entries = Array.isArray(listing) ? (listing as TreeEntry[]) : []
  const modelEntry = entries.find((e) => e.path?.endsWith(`${voice}.onnx`))
  const configEntry = entries.find((e) => e.path?.endsWith(`${voice}.onnx.json`))
  if (!modelEntry || !configEntry) {
    throw new Error(
      `There is no voice "${voice}" in the catalogue.\n` +
        `  Looked in ${repoPath} of ${VOICES_REPO} at the pinned revision.\n` +
        '  Check the id — see https://rhasspy.github.io/piper-samples/ for the list.',
    )
  }

  opts.onDownload?.(voice, modelEntry.size + configEntry.size)

  await mkdir(opts.voicesDir, { recursive: true })
  // Config first: it is tiny, so a failure costs nothing, and its absence is
  // what stops a half-installed voice from looking complete to the fast path.
  await downloadVerified(`${FILE_BASE}/${repoPath}/${voice}.onnx.json`, config, configEntry, signal)
  try {
    await downloadVerified(`${FILE_BASE}/${repoPath}/${voice}.onnx`, model, modelEntry, signal)
  } catch (error) {
    // Never leave a config with no model: the pair is what "installed" means.
    await rm(config, { force: true }).catch(() => undefined)
    throw error
  }

  return { model, config }
}
