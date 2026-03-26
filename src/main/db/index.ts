import Database from 'better-sqlite3'
import { join } from 'path'
import { app } from 'electron'

let db: Database.Database | null = null

/**
 * Applies all schema migrations to the given database.
 * Uses CREATE TABLE IF NOT EXISTS so this is safe to call multiple times
 * (idempotent). Called automatically by getDatabase() on first open.
 *
 * Exported separately so it can be tested without an Electron context by
 * passing an in-memory database.
 */
export function applyMigrations(database: Database.Database): void {
  // Enable foreign key enforcement for the connection receiving migrations.
  database.pragma('foreign_keys = ON')

  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cameras (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      number        INTEGER NOT NULL,
      name          TEXT NOT NULL,
      color         TEXT NOT NULL,
      resolve_color TEXT,
      UNIQUE(project_id, number)
    );

    CREATE TABLE IF NOT EXISTS rundowns (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shots (
      id           TEXT PRIMARY KEY,
      rundown_id   TEXT NOT NULL REFERENCES rundowns(id) ON DELETE CASCADE,
      camera_id    TEXT NOT NULL REFERENCES cameras(id),
      duration_ms  INTEGER NOT NULL,
      label        TEXT,
      order_index  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS live_state (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      rundown_id   TEXT,
      live_shot_id TEXT,
      started_at   INTEGER,
      running      INTEGER NOT NULL DEFAULT 0,
      skipped_ids  TEXT NOT NULL DEFAULT '[]'
    );

    -- Ensure singleton row exists
    INSERT OR IGNORE INTO live_state (id, running, skipped_ids) VALUES (1, 0, '[]');
  `)

  // Idempotent column additions (ALTER TABLE is not in CREATE TABLE IF NOT EXISTS)
  try { database.exec('ALTER TABLE cameras ADD COLUMN obs_scene TEXT') } catch (_) { /* column exists */ }
  try { database.exec('ALTER TABLE live_state ADD COLUMN project_id TEXT') } catch (_) { /* column exists */ }
  try { database.exec('ALTER TABLE shots ADD COLUMN transition_name TEXT') } catch (_) { /* column exists */ }
  try { database.exec('ALTER TABLE shots ADD COLUMN transition_ms INTEGER NOT NULL DEFAULT 0') } catch (_) { /* column exists */ }
  try { database.exec('ALTER TABLE rundowns ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0') } catch (_) { /* column exists */ }
  try { database.exec('ALTER TABLE rundowns ADD COLUMN folder TEXT') } catch (_) { /* column exists */ }
  database.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transition_mappings (
      logical_name        TEXT PRIMARY KEY,
      obs_transition_name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS markers (
      id          TEXT PRIMARY KEY,
      rundown_id  TEXT NOT NULL REFERENCES rundowns(id) ON DELETE CASCADE,
      position_ms INTEGER NOT NULL,
      label       TEXT
    );

    INSERT OR IGNORE INTO transition_mappings (logical_name, obs_transition_name) VALUES
      ('cut', 'Cut'),
      ('fade', 'Fade'),
      ('stinger', 'Stinger');
  `)
}

export function getDatabase(): Database.Database {
  if (db) return db

  const dbPath = join(app.getPath('userData'), 'obs-queuer.db')
  db = new Database(dbPath)

  // WAL mode for better concurrency
  db.pragma('journal_mode = WAL')

  applyMigrations(db)

  return db
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
