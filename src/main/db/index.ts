import Database from 'better-sqlite3'
import { join } from 'path'
import { app } from 'electron'

// Stub for the SQLite database layer.
// Schema migrations will be added when persistence is implemented.

let db: Database.Database | null = null

export function getDatabase(): Database.Database {
  if (db) return db

  const dbPath = join(app.getPath('userData'), 'obs-queuer.db')
  db = new Database(dbPath)

  // WAL mode for better concurrency
  db.pragma('journal_mode = WAL')

  return db
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
