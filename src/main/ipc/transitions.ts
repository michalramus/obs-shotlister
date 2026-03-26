import type Database from 'better-sqlite3'

export const BUILTIN_TRANSITIONS = ['cut', 'fade', 'stinger'] as const

export type TransitionMapping = { logicalName: string; obsTransitionName: string }

export function listTransitionMappings(db: Database.Database): TransitionMapping[] {
  const rows = db
    .prepare('SELECT logical_name, obs_transition_name FROM transition_mappings')
    .all() as Array<{ logical_name: string; obs_transition_name: string }>
  return rows.map((r) => ({
    logicalName: r.logical_name,
    obsTransitionName: r.obs_transition_name,
  }))
}

export function upsertTransitionMapping(
  db: Database.Database,
  logicalName: string,
  obsName: string,
  constLengthMs: number | null = null,
): void {
  db.prepare(
    'INSERT OR REPLACE INTO transition_mappings (logical_name, obs_transition_name, const_length_ms) VALUES (?, ?, ?)',
  ).run(logicalName, obsName, constLengthMs)
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

export function resolveTransitionFull(
  db: Database.Database,
  logicalName: string,
): { obsName: string; constLengthMs: number | null } {
  const row = db
    .prepare(
      'SELECT obs_transition_name, const_length_ms FROM transition_mappings WHERE logical_name = ?',
    )
    .get(logicalName) as { obs_transition_name: string; const_length_ms: number | null } | undefined
  return {
    obsName: row ? row.obs_transition_name : logicalName,
    constLengthMs: row?.const_length_ms ?? null,
  }
}
