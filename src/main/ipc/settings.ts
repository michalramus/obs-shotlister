import Database from 'better-sqlite3'

export function getObsSettings(db: Database.Database): { url: string; password: string } {
  const urlRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('obs_url') as { value: string } | undefined
  const pwRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('obs_password') as { value: string } | undefined
  return {
    url: urlRow?.value ?? 'ws://localhost:4455',
    password: pwRow?.value ?? '',
  }
}

export function saveObsSettings(db: Database.Database, url: string, password: string): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('obs_url', url)
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('obs_password', password)
}
