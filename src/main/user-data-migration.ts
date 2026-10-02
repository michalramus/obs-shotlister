import { existsSync, mkdirSync, readdirSync, renameSync } from 'fs'
import { join, dirname } from 'path'

/**
 * The directory and database this app wrote under its old name.
 *
 * Electron derives userData from the package name, so renaming the package to
 * `shotlister` moved every install's data out from under it: the shotlists, the
 * downloaded Piper voices and the rendered clips all sat in `obs-queuer` and the
 * app would have come up empty next to them. Nothing announces that — the app
 * simply starts with no projects — so the rename carries its own migration.
 */
const LEGACY_DIR_NAME = 'obs-queuer'
const LEGACY_DB_NAME = 'obs-queuer.db'
export const DB_NAME = 'shotlister.db'

/**
 * The new name for a file that belongs to the database.
 *
 * `-wal` and `-shm` are matched by prefix rather than listed, because SQLite
 * finds them by appending to the database's own name: moving `obs-queuer.db` to
 * `shotlister.db` and leaving `obs-queuer.db-wal` behind would silently drop
 * every committed transaction that had not been checkpointed yet.
 */
function renameDatabaseFile(entry: string): string {
  if (!entry.startsWith(LEGACY_DB_NAME)) return entry
  return DB_NAME + entry.slice(LEGACY_DB_NAME.length)
}

/**
 * Moves an older install's data into the current userData directory.
 *
 * Entry by entry rather than one directory rename, because Electron may already
 * have created (and written to) the new directory before this runs. Anything
 * already present on the new side wins and the old copy is left alone: a
 * half-merged profile is recoverable by hand, an overwritten one is not. For the
 * same reason the legacy directory itself is never deleted — a release that gets
 * this wrong must stay undoable by copying the files back.
 *
 * Idempotent, and a no-op for a fresh install.
 */
export function migrateLegacyUserData(userDataPath: string): void {
  const legacyPath = join(dirname(userDataPath), LEGACY_DIR_NAME)
  if (legacyPath !== userDataPath && existsSync(legacyPath)) {
    mkdirSync(userDataPath, { recursive: true })
    for (const entry of readdirSync(legacyPath)) {
      // The database is the one entry that changes name on the way across, so
      // that an operator looking in the directory sees one app, not two.
      const target = join(userDataPath, renameDatabaseFile(entry))
      if (existsSync(target)) continue
      try {
        renameSync(join(legacyPath, entry), target)
      } catch (err) {
        // One unmovable file must not cost the operator the other twenty. The
        // rest of the migration still runs, and the app still starts.
        console.error(`[userData] could not migrate ${entry} from the previous install:`, err)
      }
    }
  }

  renameLegacyDatabaseInPlace(userDataPath)
}

/**
 * Renames a database left under the old name in the current directory.
 *
 * Separate from the directory migration because it has to run for an install
 * that never had a legacy directory at all: on Linux the config directory is
 * named after the executable, which some packages already spelled `shotlister`
 * while the database inside it was still `obs-queuer.db`.
 */
export function renameLegacyDatabaseInPlace(userDataPath: string): void {
  const dbPath = join(userDataPath, DB_NAME)
  if (existsSync(dbPath) || !existsSync(join(userDataPath, LEGACY_DB_NAME))) return
  for (const suffix of ['', '-wal', '-shm']) {
    const from = join(userDataPath, LEGACY_DB_NAME + suffix)
    if (!existsSync(from)) continue
    try {
      renameSync(from, join(userDataPath, DB_NAME + suffix))
    } catch (err) {
      console.error('[userData] could not rename the previous database:', err)
    }
  }
}
