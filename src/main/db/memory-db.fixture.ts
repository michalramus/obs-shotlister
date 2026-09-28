import Database from 'better-sqlite3'
import { applyMigrations } from './index'

/**
 * A throwaway database for a test.
 *
 * Fourteen suites opened one of these with their own copy of this function,
 * and the copies had drifted: some enabled WAL, some did not, and one skipped
 * migrations on purpose. Drift here is quiet but expensive — a suite with
 * foreign keys left off passes writes the real app would refuse.
 *
 * Foreign keys are on because the schema leans on them: several deletes are
 * refused by a constraint rather than by a check in our own code, and a test
 * database without them proves nothing about those paths.
 */
export function openMemoryDb(options: { migrate?: boolean } = {}): Database.Database {
  const db = new Database(':memory:')
  // A no-op for an in-memory database, kept because getDatabase() sets it and
  // a fixture that differs from the real thing is the point of this file.
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // Off only for the suite that tests the migrations themselves, which needs to
  // build a legacy schema by hand first.
  if (options.migrate !== false) applyMigrations(db)
  return db
}
