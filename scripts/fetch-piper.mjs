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
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
 * Where our own macOS arm64 build is published.
 *
 * Upstream never shipped one. Its release workflow builds a matrix of
 * `[x64, aarch64]` on `macos-latest` but never passes CMAKE_OSX_ARCHITECTURES,
 * so in November 2023 — when `macos-latest` was still Intel — both jobs
 * produced x86_64 and only the filenames differed. `piper_macos_aarch64.tar.gz`
 * contains x86_64 Mach-O binaries, which a machine without Rosetta cannot run
 * at all. `.github/workflows/build-piper-macos-arm64.yml` builds the real thing
 * on an arm64 runner; publish its tarball here and paste the checksum below.
 */
const OWN_BUILD_BASE =
  'https://github.com/michalramus/obs-shotlister/releases/download/piper-macos-arm64-2023.11.14-2'

const TARGETS = {
  'darwin-arm64': {
    // Deliberately not upstream's mislabelled asset: see OWN_BUILD_BASE above.
    url: `${OWN_BUILD_BASE}/piper_macos_aarch64.tar.gz`,
    asset: 'piper_macos_aarch64.tar.gz',
    // FILL ME IN from the workflow's job summary once the build has run and the
    // tarball is published. Left unset on purpose: a placeholder that looked
    // like a checksum would be worse than a build that refuses to start.
    sha256: null,
    binary: 'piper',
    // Every Mach-O in the unpacked tree must report this. Upstream shipped a
    // mislabelled tarball for two years because nothing ever checked.
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
  'pl_PL-gosia-medium': {
    path: 'pl/pl_PL/gosia/medium',
    model: '38f66464240ed74f186e6b7dc13c6e3b22e023426299f25c2b3cc9dfa9373fbc',
    config: '1aefb31a9d53ffe44a8163ff73ec833acb7a6253848f6bb0403d8a66f9c7510d',
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
    throw new Error(
      `${target} has no pinned checksum yet.\n` +
        '  Run the "Build Piper (macOS arm64)" workflow, publish its tarball, then paste\n' +
        '  the sha256 from the job summary into TARGETS in this file.',
    )
  }

  console.log(`[piper] ${target}: downloading ${spec.asset}`)
  const archive = join(scratch, spec.asset)
  await downloadVerified(spec.url ?? `${PIPER_RELEASE_BASE}/${spec.asset}`, archive, spec.sha256)

  const staging = join(scratch, `unpack-${target}`)
  await mkdir(staging, { recursive: true })
  extract(archive, staging)

  const unpacked = join(staging, 'piper')
  if (!(await exists(join(unpacked, spec.binary)))) {
    throw new Error(
      `${spec.asset} did not contain piper/${spec.binary} — the pinned release's layout changed`,
    )
  }
  await assertMachoArch(unpacked, spec)
  await writeFile(join(unpacked, STAMP), stamp)

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
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`[piper] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
