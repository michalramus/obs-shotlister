import type Database from 'better-sqlite3'

export const BUILTIN_TRANSITIONS = ['cut', 'fade', 'stinger'] as const

export type TransitionMapping = { logicalName: string; obsTransitionName: string }

export function listTransitionMappings(db: Database.Database): TransitionMapping[] {
  const rows = db
    .prepare('SELECT logical_name, obs_transition_name FROM transition_mappings')
    .all() as Array<{ logical_name: string; obs_transition_name: string }>
  return rows.map((r) => ({ logicalName: r.logical_name, obsTransitionName: r.obs_transition_name }))
}

export function upsertTransitionMapping(
  db: Database.Database,
  logicalName: string,
  obsName: string,
): void {
  db.prepare(
    'INSERT OR REPLACE INTO transition_mappings (logical_name, obs_transition_name) VALUES (?, ?)',
  ).run(logicalName, obsName)
}

export function deleteTransitionMapping(db: Database.Database, logicalName: string): void {
  if ((BUILTIN_TRANSITIONS as readonly string[]).includes(logicalName)) {
    throw new Error(`Cannot delete built-in transition mapping: ${logicalName}`)
  }
  db.prepare('DELETE FROM transition_mappings WHERE logical_name = ?').run(logicalName)
}

export function resolveTransition(db: Database.Database, logicalName: string): string {
  const row = db
    .prepare('SELECT obs_transition_name FROM transition_mappings WHERE logical_name = ?')
    .get(logicalName) as { obs_transition_name: string } | undefined
  return row ? row.obs_transition_name : logicalName
}
