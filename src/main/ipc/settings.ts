import Database from 'better-sqlite3'

export function getObsSettings(db: Database.Database): { url: string; password: string } {
  const urlRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('obs_url') as
    | { value: string }
    | undefined
  const pwRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('obs_password') as
    | { value: string }
    | undefined
  return {
    url: urlRow?.value ?? 'ws://localhost:4455',
    password: pwRow?.value ?? '',
  }
}

export function saveObsSettings(db: Database.Database, url: string, password: string): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('obs_url', url)
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    'obs_password',
    password,
  )
}

export function getObsEnabled(db: Database.Database): boolean {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('obs_enabled') as
    | { value: string }
    | undefined
  return row?.value === 'true'
}

export function setObsEnabled(db: Database.Database, enabled: boolean): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    'obs_enabled',
    enabled ? 'true' : 'false',
  )
}

export function getOscSettings(db: Database.Database): { enabled: boolean; port: number } {
  const enabledRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('osc_enabled') as
    | { value: string }
    | undefined
  const portRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('osc_port') as
    | { value: string }
    | undefined
  return {
    enabled: enabledRow?.value === 'true',
    port: portRow?.value ? parseInt(portRow.value, 10) : 8000,
  }
}

export function saveOscSettings(db: Database.Database, enabled: boolean, port: number): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    'osc_enabled',
    enabled ? 'true' : 'false',
  )
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    'osc_port',
    String(port),
  )
}

export function getPreviewFirst(db: Database.Database): boolean {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('preview_first') as
    | { value: string }
    | undefined
  return row === undefined ? true : row.value === 'true'
}

export function savePreviewFirst(db: Database.Database, value: boolean): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    'preview_first',
    value ? 'true' : 'false',
  )
}
