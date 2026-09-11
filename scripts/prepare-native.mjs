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
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

function main() {
  const runtime = process.argv[2]
  if (runtime !== 'node' && runtime !== 'electron') {
    console.error('usage: prepare-native.mjs <node|electron>')
    process.exit(1)
  }

  if (!existsSync(MODULE_DIR)) {
    console.error('[native] better-sqlite3 is not installed — run your package manager first')
    process.exit(1)
  }

  const key = cacheKey(runtime)
  const cached = join(CACHE_DIR, key)
  const installed = existsSync(MARKER) ? readFileSync(MARKER, 'utf-8').trim() : null

  if (installed === key && existsSync(BUILT)) return

  mkdirSync(CACHE_DIR, { recursive: true })

  if (existsSync(cached)) {
    copyFileSync(cached, BUILT)
    writeFileSync(MARKER, key)
    console.info(`[native] better-sqlite3 → ${runtime} (cached)`)
    return
  }

  console.info(`[native] building better-sqlite3 for ${runtime}…`)
  rebuild(runtime)

  if (!existsSync(BUILT)) {
    console.error('[native] rebuild finished but produced no binary')
    process.exit(1)
  }

  copyFileSync(BUILT, cached)
  writeFileSync(MARKER, key)
  console.info(`[native] better-sqlite3 → ${runtime} (built and cached)`)
}

main()
