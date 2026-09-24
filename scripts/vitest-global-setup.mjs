/**
 * Ensures better-sqlite3 is built for Node before any test file loads it.
 *
 * Without this, running vitest directly after the app had been built for
 * Electron fails every database test with a bindings error that looks nothing
 * like an ABI mismatch. Tests should not require remembering which runtime the
 * repo was last built for.
 *
 * The work is done in-process rather than in a child. Spawning it with
 * inherited stdio deadlocked against vitest's own output capture: the suite
 * printed its banner and then hung forever, before collecting a single file —
 * which looked exactly like a hanging test and was nothing of the sort.
 */

import { prepareNative } from './prepare-native.mjs'

export default function setup() {
  const result = prepareNative('node')
  if (!result.changed) return

  console.info(`[native] better-sqlite3 → node (${result.built ? 'built' : 'cached'})`)

  // One binary, two ABIs. Taking it back from Electron leaves any running
  // `yarn dev` with a module it can no longer load, and the next reload fails
  // with a bindings error that says nothing about tests having run.
  if (result.from === 'electron') {
    console.warn(
      '[native] this swapped better-sqlite3 away from Electron.\n' +
        '[native] a running `yarn dev` will fail to reload — restart it, which rebuilds automatically.',
    )
  }
}
