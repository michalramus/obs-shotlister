/**
 * Ensures better-sqlite3 is built for Node before any test file loads it.
 *
 * Without this, running vitest directly after the app had been built for
 * Electron fails every database test with a bindings error that looks nothing
 * like an ABI mismatch. Tests should not require remembering which runtime the
 * repo was last built for.
 */

import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export default function setup() {
  execFileSync(process.execPath, [join(root, 'scripts', 'prepare-native.mjs'), 'node'], {
    cwd: root,
    stdio: 'inherit',
  })
}
