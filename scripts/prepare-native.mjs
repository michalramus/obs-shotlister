#!/usr/bin/env node
/**
 * Puts the right better-sqlite3 binary in place for the runtime about to load it.
 *
 * better-sqlite3 is a native addon, and Node and Electron use incompatible ABIs.
 * Both `npm rebuild` and `electron-rebuild` write the same
 * build/Release/better_sqlite3.node, so whichever ran last wins and the other
 * runtime fails with "was compiled against a different Node.js version" — or, in
 * vitest's case, a confusing wall of "Could not locate the bindings file".
 *
 * So each build is cached under its own key and swapped in on demand. The first
 * build for a runtime compiles; every switch after that is a file copy.
 *
 * Usage: node scripts/prepare-native.mjs <node|electron>
 */

import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODULE_DIR = join(ROOT, 'node_modules', 'better-sqlite3')
const BUILT = join(MODULE_DIR, 'build', 'Release', 'better_sqlite3.node')
const CACHE_DIR = join(ROOT, 'node_modules', '.cache', 'better-sqlite3')
const MARKER = join(CACHE_DIR, 'current')

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

/**
 * Cache key for a runtime. Includes the addon version so bumping better-sqlite3
 * invalidates both cached builds rather than loading a stale binary.
 */
function cacheKey(runtime) {
  const addonVersion = readJson(join(MODULE_DIR, 'package.json')).version
  const runtimeVersion =
    runtime === 'electron'
      ? readJson(join(ROOT, 'node_modules', 'electron', 'package.json')).version
      : process.versions.modules
  return `${runtime}-${runtimeVersion}-bs3-${addonVersion}.node`
}

function rebuild(runtime) {
  const [cmd, args] =
    runtime === 'electron'
      ? ['npx', ['electron-rebuild', '-f', '-w', 'better-sqlite3']]
      : ['npm', ['rebuild', 'better-sqlite3']]
  // npm and npx are .cmd shims on Windows, which execFileSync cannot spawn
  // directly. Arguments here are fixed literals, so going through the shell is
  // safe. The Windows release job packages through this path.
  execFileSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
}

/** True when the binary already in place is the one this runtime needs. */
export function isPrepared(runtime) {
  if (!existsSync(MODULE_DIR) || !existsSync(BUILT)) return false
  const installed = existsSync(MARKER) ? readFileSync(MARKER, 'utf-8').trim() : null
  return installed === cacheKey(runtime)
}

/**
 * Swaps in the binary for `runtime`, building it the first time.
 *
 * Returns what it had to do, so a caller can say something useful about it —
 * `vitest` needs to warn when it takes the binary away from a running
 * `yarn dev`, and saying nothing at all when no swap happened.
 *
 * Exported rather than only run as a CLI because vitest's global setup calls
 * it in-process: spawning it there with inherited stdio deadlocked against
 * vitest's own output capture, and the suite hung before collecting a thing.
 */
export function prepareNative(runtime) {
  if (runtime !== 'node' && runtime !== 'electron') {
    throw new Error(`prepare-native: expected node or electron, got ${runtime}`)
  }
  if (!existsSync(MODULE_DIR)) {
    throw new Error('better-sqlite3 is not installed — run your package manager first')
  }

  const key = cacheKey(runtime)
  const cached = join(CACHE_DIR, key)
  const installed = existsSync(MARKER) ? readFileSync(MARKER, 'utf-8').trim() : null

  if (installed === key && existsSync(BUILT)) return { changed: false, from: runtime }

  const from = installed === null ? null : installed.split('-')[0]
  mkdirSync(CACHE_DIR, { recursive: true })

  if (existsSync(cached)) {
    swapIn(cached)
    writeFileSync(MARKER, key)
    return { changed: true, from, built: false }
  }

  console.info(`[native] building better-sqlite3 for ${runtime}…`)
  rebuild(runtime)

  if (!existsSync(BUILT)) {
    throw new Error('rebuild finished but produced no binary')
  }

  copyFileSync(BUILT, cached)
  writeFileSync(MARKER, key)
  return { changed: true, from, built: true }
}

/**
 * Puts a cached binary in place without disturbing anyone already using it.
 *
 * Copying over the file in place corrupts the mapping of every process that has
 * it loaded — a running `yarn dev` holds exactly that — and the next process to
 * touch a page of it is killed outright. That is what made `yarn test` die with
 * SIGKILL whenever the app was running, which looked like a flaky test suite
 * and was nothing of the kind.
 *
 * Writing beside it and renaming gives the new binary its own inode. The old
 * one stays mapped and intact for as long as anything still holds it, and is
 * reclaimed when the last one exits.
 */
function swapIn(source) {
  const temporary = `${BUILT}.${process.pid}.tmp`
  copyFileSync(source, temporary)
  renameSync(temporary, BUILT)
}

// Run as a CLI only when invoked directly, so importing this is side-effect free.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const runtime = process.argv[2]
    const result = prepareNative(runtime)
    if (result.changed) {
      console.info(`[native] better-sqlite3 → ${runtime} (${result.built ? 'built' : 'cached'})`)
    }
  } catch (err) {
    console.error(`[native] ${err.message}`)
    process.exit(1)
  }
}
