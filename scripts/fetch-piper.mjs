#!/usr/bin/env node
/**
 * Downloads the bundled Piper engine and its default voices.
 *
 * Announcements are synthesised locally so a venue's network can never take out
 * a show (ADR 0005), which means the engine has to ship inside the app rather
 * than be fetched at runtime. This script is the build-time half of that: it
 * puts a Piper binary and the default voice models on disk, where
 * electron-builder picks them up as extra resources.
 *
 * It is deliberately NOT part of `dev` or `build`. A test run must never need a
 * network, and neither must a working tree that already has the binaries.
 *
 * Every artifact is pinned by release tag (Piper) or commit (Hugging Face) and
 * verified against a SHA-256 recorded below. A build that silently accepts a
 * changed artifact is worse than one that fails, so a mismatch is fatal and
 * nothing is left half-written: downloads land on a temp path and are renamed
 * into place only once they have been verified.
 *
 * Usage:
 *   node scripts/fetch-piper.mjs            # the host platform
 *   node scripts/fetch-piper.mjs all        # every shipped target
 *   node scripts/fetch-piper.mjs linux-x64 win32-x64
 */

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PIPER_DIR = join(ROOT, 'resources', 'piper')
const VOICES_DIR = join(ROOT, 'resources', 'piper-voices')

// ---------------------------------------------------------------------------
// Pinned manifest — the only place a version or a checksum is written down.
//
// Checksums were taken from the artifacts themselves (the Hugging Face ones are
// the LFS object ids, which are the files' SHA-256). Re-pinning means
// re-downloading and re-hashing; never copy a checksum from anywhere but the
// bytes you intend to ship.
// ---------------------------------------------------------------------------

/**
 * rhasspy/piper is the last Piper release to ship standalone CLI binaries; the
 * successor (OHF-Voice/piper1-gpl) publishes Python wheels, which would drag a
 * Python runtime into a desktop app. So the CLI release stays pinned here.
 */
const PIPER_RELEASE = '2023.11.14-2'
const PIPER_RELEASE_BASE = `https://github.com/rhasspy/piper/releases/download/${PIPER_RELEASE}`

/**
 * Apple Silicon does not get an upstream build.
 *
 * Upstream's release workflow builds a matrix of `[x64, aarch64]` on
 * `macos-latest` but never passes CMAKE_OSX_ARCHITECTURES, so in November 2023
 * — when `macos-latest` was still Intel — both jobs produced x86_64 and only
 * the filenames differed. `piper_macos_aarch64.tar.gz` contains x86_64 Mach-O,
 * which a machine without Rosetta cannot run at all.
 *
 * So arm64 comes from a community build instead: a PyInstaller bundle of the
 * current Python Piper, self-contained and genuinely arm64. Verified with
 * `lipo` on every fetch, and pinned by checksum — it is a third-party artifact,
 * so the checksum is the only thing vouching for it.
 *
 * Its CLI is much smaller than the C++ one's: `--model` and `--output_file`,
 * nothing else. See `cli` below.
 */
const ARM64_BUILD =
  'https://github.com/itsabhishekolkha/piper-arm-build/releases/download/v1.2.0/piper.arm64-no.deps.deps'

const TARGETS = {
  'darwin-arm64': {
    // Deliberately not upstream's mislabelled asset: see ARM64_BUILD above.
    url: ARM64_BUILD,
    asset: 'piper.arm64-no.deps.deps',
    sha256: '0b29c479b6633a04293c726312f059af0f2b882fb6852d244feb773c9ef42fec',
    binary: 'piper',
    // A bare executable, not an archive: nothing to extract.
    bare: true,
    // Takes only --model and --output_file, and has no --sentence_silence, so
    // its clips carry the trailing pad the engine trims when measuring them.
    cli: 'minimal',
    // Upstream shipped a mislabelled tarball for two years because nothing
    // ever checked; this is exactly the check that would have caught it.
    machoArch: 'arm64',
  },
  'darwin-x64': {
    asset: 'piper_macos_x64.tar.gz',
    sha256: 'ced85c0a3df13945b1e623b878a48fdc2854d5c485b4b67f62857cf551deaf8b',
    binary: 'piper',
    machoArch: 'x86_64',
  },
  'linux-x64': {
    asset: 'piper_linux_x86_64.tar.gz',
    sha256: 'a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992',
    binary: 'piper',
  },
  'win32-x64': {
    asset: 'piper_windows_amd64.zip',
    sha256: 'f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea',
    binary: 'piper.exe',
  },
}

/**
 * Pinned to a commit rather than `main`: the voices repository is mutable, and
 * a voice that changes under us re-synthesises every clip in every cache.
 */
const VOICES_REVISION = 'c10ece1aade47bb51c153c893d14e5bf8e5b7117'
const VOICES_BASE = `https://huggingface.co/rhasspy/piper-voices/resolve/${VOICES_REVISION}`

const VOICES = {
  // The default Polish voice. `high` rather than `medium`: it is the voice the
  // band actually hears over Mumble, and a 22kHz model survives that path
  // noticeably better than a 16kHz one. It costs 114MB against gosia's 63MB,
  // which is disk on the operator's machine and nothing on show night.
  'pl_PL-bass-high': {
    path: 'pl/pl_PL/bass/high',
    model: '73b8408967c58118700f21eb2413cd8b666c7844c6136cf674bf5dd56bde72c2',
    config: '7bb41aa14fee87a31cc32264119c09e3553335196d3db15b39b1c18790e13c59',
  },
  'en_US-amy-medium': {
    path: 'en/en_US/amy/medium',
    model: 'b3a6e47b57b8c7fbe6a0ce2518161a50f59a9cdd8a50835c02cb02bdd6206c18',
    config: '95a23eb4d42909d38df73bb9ac7f45f597dbfcde2d1bf9526fdeaf5466977d77',
  },
}

// ---------------------------------------------------------------------------
// Download and verification
// ---------------------------------------------------------------------------

function exists(path) {
  return access(path).then(
    () => true,
    () => false,
  )
}

async function sha256OfFile(path) {
  const hash = createHash('sha256')
  hash.update(await readFile(path))
  return hash.digest('hex')
}

/**
 * Streams a URL to a file and returns its SHA-256.
 *
 * The hash is computed from the bytes as they are written rather than by
 * re-reading afterwards, so a file that changes between write and check cannot
 * pass.
 */
async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`)
  }
  const hash = createHash('sha256')
  const source = Readable.fromWeb(response.body)
  source.on('data', (chunk) => hash.update(chunk))
  await pipeline(source, createWriteStream(destination))
  return hash.digest('hex')
}

async function downloadVerified(url, destination, expected) {
  const actual = await download(url, destination)
  if (actual !== expected) {
    await rm(destination, { force: true })
    throw new Error(
      `checksum mismatch for ${url}\n  expected ${expected}\n  actual   ${actual}\n` +
        'Either the pinned artifact was replaced upstream or the download was tampered with. ' +
        'Nothing was written.',
    )
  }
}

// ---------------------------------------------------------------------------
// Archive extraction
// ---------------------------------------------------------------------------

function run(command, args) {
  try {
    execFileSync(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (error) {
    // execFileSync's own message says only "Command failed", which is useless
    // when the real complaint ("tar: unrecognized option") went to stderr.
    const stderr = error?.stderr?.toString().trim()
    throw new Error(`${command} failed${stderr ? `: ${stderr}` : ''}`)
  }
}

/**
 * Unpacks an archive into `into`. Every Piper archive holds a single top-level
 * `piper/` directory, which is what the caller renames into place.
 *
 * `unzip` is tried first for zips because GNU tar — the tar on most Linux
 * machines — cannot read them; bsdtar, which is what macOS and Windows ship,
 * can, and is the fallback.
 */
function extract(archive, into) {
  if (archive.endsWith('.zip')) {
    try {
      run('unzip', ['-q', '-o', archive, '-d', into])
      return
    } catch {
      run('tar', ['-xf', archive, '-C', into])
    }
    return
  }
  run('tar', ['-xzf', archive, '-C', into])
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Records what a target directory was built from, so a second run can tell an
 * up-to-date unpacked tree from a stale one without re-downloading 20MB to
 * re-hash it. The archive's own checksum is verified at download time; this
 * file is how that verification is remembered.
 */
const STAMP = '.piper-release'

/**
 * Which command-line dialect the installed binary speaks: `full` or `minimal`.
 *
 * Deliberately not a dotfile. This one is read at runtime, so it has to survive
 * electron-builder's copy into the package; a hidden file that quietly failed
 * to ship would leave a packaged arm64 build passing flags its Piper rejects.
 */
const CLI_STAMP = 'piper-cli.txt'

async function fetchTarget(target, scratch) {
  const spec = TARGETS[target]
  if (!spec) {
    throw new Error(
      `unknown target "${target}" — expected one of ${Object.keys(TARGETS).join(', ')}`,
    )
  }

  const destination = join(PIPER_DIR, target)
  const stampPath = join(destination, STAMP)
  const stamp = `${PIPER_RELEASE} ${spec.sha256}\n`

  if (await exists(join(destination, spec.binary))) {
    const current = await readFile(stampPath, 'utf-8').catch(() => null)
    if (current === stamp) {
      console.log(`[piper] ${target}: already at ${PIPER_RELEASE}`)
      return
    }
  }

  if (!spec.sha256) {
    throw new Error(`${target} has no pinned checksum — refusing to install it unverified.`)
  }

  console.log(`[piper] ${target}: downloading ${spec.asset}`)
  const archive = join(scratch, spec.asset)
  await downloadVerified(spec.url ?? `${PIPER_RELEASE_BASE}/${spec.asset}`, archive, spec.sha256)

  const staging = join(scratch, `unpack-${target}`)
  await mkdir(staging, { recursive: true })

  const unpacked = join(staging, 'piper')
  if (spec.bare) {
    // A single self-contained executable. The layout below still has to hold,
    // so it is placed rather than extracted.
    await mkdir(unpacked, { recursive: true })
    await copyFile(archive, join(unpacked, spec.binary))
    await chmod(join(unpacked, spec.binary), 0o755)
  } else {
    extract(archive, staging)
  }

  if (!(await exists(join(unpacked, spec.binary)))) {
    throw new Error(
      `${spec.asset} did not contain piper/${spec.binary} — the pinned release's layout changed`,
    )
  }
  await assertMachoArch(unpacked, spec)
  await writeFile(join(unpacked, STAMP), stamp)
  // The engine reads this to know which flags the binary accepts. Written
  // beside it rather than probed at runtime, because the fetch already knows.
  await writeFile(join(unpacked, CLI_STAMP), `${spec.cli ?? 'full'}\n`)

  // Replace the whole directory in one move, so an interrupted run never leaves
  // a half-unpacked engine that looks installed.
  await mkdir(PIPER_DIR, { recursive: true })
  await rm(destination, { recursive: true, force: true })
  await rename(unpacked, destination)
  console.log(`[piper] ${target}: installed ${PIPER_RELEASE}`)
}

/**
 * Refuses a macOS tarball whose binaries are for the wrong architecture.
 *
 * A checksum only proves the bytes are the ones we pinned; it says nothing
 * about what is inside them. Upstream published an `aarch64` tarball full of
 * x86_64 binaries for two years, and the only reason anyone noticed was a
 * machine without Rosetta refusing to run it — on a show night that is far too
 * late. Checked at fetch time, where it costs one `lipo` call.
 *
 * Only runs on a macOS host, since `lipo` is part of the Xcode tools; on other
 * hosts a cross-fetch is left unverified rather than failed.
 */
async function assertMachoArch(unpacked, spec) {
  if (!spec.machoArch || process.platform !== 'darwin') return

  const binary = join(unpacked, spec.binary)
  let archs
  try {
    archs = execFileSync('lipo', ['-archs', binary], { encoding: 'utf-8' }).trim()
  } catch (err) {
    console.warn(`[piper] could not read the architecture of ${spec.binary}: ${err.message}`)
    return
  }

  if (!archs.split(/\s+/).includes(spec.machoArch)) {
    throw new Error(
      `${spec.asset} contains ${archs} binaries, expected ${spec.machoArch}.\n` +
        '  This is exactly the upstream mislabelling this check exists to catch.',
    )
  }
  console.log(`[piper] ${spec.binary}: ${archs}`)
}

async function fetchVoiceFile(url, destination, expected, label, scratch) {
  if ((await exists(destination)) && (await sha256OfFile(destination)) === expected) {
    console.log(`[piper] ${label}: already present`)
    return
  }
  console.log(`[piper] ${label}: downloading`)
  const temporary = join(scratch, `${label}.part`)
  await downloadVerified(url, temporary, expected)
  await mkdir(VOICES_DIR, { recursive: true })
  await rename(temporary, destination)
  console.log(`[piper] ${label}: installed`)
}

async function fetchVoice(voice, scratch) {
  const spec = VOICES[voice]
  await fetchVoiceFile(
    `${VOICES_BASE}/${spec.path}/${voice}.onnx`,
    join(VOICES_DIR, `${voice}.onnx`),
    spec.model,
    `${voice}.onnx`,
    scratch,
  )
  await fetchVoiceFile(
    `${VOICES_BASE}/${spec.path}/${voice}.onnx.json`,
    join(VOICES_DIR, `${voice}.onnx.json`),
    spec.config,
    `${voice}.onnx.json`,
    scratch,
  )
}

/**
 * Deletes voices this manifest no longer pins.
 *
 * electron-builder copies the whole voices directory into the package, so a
 * voice dropped from the manifest would keep shipping — a hundred megabytes of
 * a model nothing selects, in every installer, forever. Re-pinning a voice is
 * the normal reason this runs, and it is exactly when the old one stops being
 * wanted.
 *
 * Only files that look like voice files go; anything else in there was put
 * there by someone who meant it.
 */
async function pruneVoices() {
  let entries
  try {
    entries = await readdir(VOICES_DIR)
  } catch {
    return
  }

  const wanted = new Set(Object.keys(VOICES))
  for (const name of entries) {
    const voice = name.endsWith('.onnx.json')
      ? name.slice(0, -'.onnx.json'.length)
      : name.endsWith('.onnx')
        ? name.slice(0, -'.onnx'.length)
        : null
    if (voice === null || wanted.has(voice)) continue
    await rm(join(VOICES_DIR, name), { force: true })
    console.log(`[piper] ${name}: removed, no longer pinned`)
  }
}

async function main() {
  const requested = process.argv.slice(2)
  const targets = requested.includes('all')
    ? Object.keys(TARGETS)
    : requested.length > 0
      ? requested
      : [`${process.platform}-${process.arch}`]

  const scratch = await mkdtemp(join(tmpdir(), 'shotlister-piper-'))
  try {
    for (const target of targets) await fetchTarget(target, scratch)
    for (const voice of Object.keys(VOICES)) await fetchVoice(voice, scratch)
    await pruneVoices()
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`[piper] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
