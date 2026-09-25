import Database from 'better-sqlite3'
import {
  DEFAULT_COUNTDOWN,
  TRANSMISSION_DELAY_MAX_MS,
  TRANSMISSION_DELAY_MIN_MS,
} from '../../shared/announcement'
import { NUMBER_CLIP_MAX, NUMBER_CLIP_MIN } from '../../shared/number-words'
import type {
  AudioDeviceSettings,
  EffectiveVoiceSettings,
  GlobalVoiceSettings,
  PhrasePlacement,
  ProjectVoiceSettings,
} from '../../shared/ipc-contract'

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

// ---------------------------------------------------------------------------
// Voice-over settings
//
// Voice, countdown and placement are global with a per-Project override, so the
// operator sets them once and only overrides where it matters. The connector
// word is per-Project only: it is a property of the band's language, not of the
// machine, and a Polish band and an English one can share neither.
//
// Project overrides are stored under a key prefix rather than in their own
// table. They are a handful of scalars read once per Project, and a table would
// buy nothing a prefix does not.
// ---------------------------------------------------------------------------

/** What a Project falls back to when it overrides nothing. */
export const DEFAULT_VOICE = 'pl_PL-bass-high'
export const DEFAULT_CONNECTOR = 'za'

// Re-exported so the settings tests read one name, but owned by the scheduler
// that actually honours them.
export {
  TRANSMISSION_DELAY_MIN_MS as MIN_TRANSMISSION_DELAY_MS,
  TRANSMISSION_DELAY_MAX_MS as MAX_TRANSMISSION_DELAY_MS,
} from '../../shared/announcement'

function readSetting(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value
}

function writeSetting(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}

function clearSetting(db: Database.Database, key: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key)
}

/**
 * Parses a stored countdown. A malformed value reads as "not set" rather than
 * throwing: a corrupt setting must not be able to stop a show from starting.
 */
function parseCountdown(raw: string | undefined): number[] | null {
  if (!raw) return null
  const numbers = raw
    .split(',')
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isInteger(n) && n >= NUMBER_CLIP_MIN && n <= NUMBER_CLIP_MAX)
  return numbers.length > 0 ? numbers : null
}

/**
 * A stored path delay, or zero. Like the countdown, a corrupt value reads as
 * unset rather than throwing: a bad setting must not stop a show from starting.
 * Bounded because a delay longer than a Call would simply mute every
 * Announcement, which is never what the operator meant to type.
 */
function parseDelay(raw: string | undefined): number {
  const ms = Number(raw)
  if (!Number.isFinite(ms)) return 0
  return Math.min(Math.max(Math.round(ms), TRANSMISSION_DELAY_MIN_MS), TRANSMISSION_DELAY_MAX_MS)
}

function parsePlacement(raw: string | undefined): PhrasePlacement | null {
  return raw === 'flush' || raw === 'immediate' ? raw : null
}

export function getGlobalVoiceSettings(db: Database.Database): GlobalVoiceSettings {
  return {
    voice: readSetting(db, 'voice_voice') ?? DEFAULT_VOICE,
    countdown: parseCountdown(readSetting(db, 'voice_countdown')) ?? [...DEFAULT_COUNTDOWN],
    // Flush is the default so name and countdown arrive as one continuous
    // sentence rather than with an awkward gap between them.
    placement: parsePlacement(readSetting(db, 'voice_placement')) ?? 'flush',
    // Manual by default: a slow machine must not start synthesising while the
    // operator is still editing.
    autoRender: readSetting(db, 'voice_auto_render') === 'true',
    transmissionDelayMs: parseDelay(readSetting(db, 'voice_transmission_delay')),
  }
}

export function saveGlobalVoiceSettings(db: Database.Database, value: GlobalVoiceSettings): void {
  writeSetting(db, 'voice_voice', value.voice)
  writeSetting(db, 'voice_countdown', value.countdown.join(','))
  writeSetting(db, 'voice_placement', value.placement)
  writeSetting(db, 'voice_auto_render', value.autoRender ? 'true' : 'false')
  writeSetting(db, 'voice_transmission_delay', String(Math.round(value.transmissionDelayMs)))
}

export function getProjectVoiceSettings(
  db: Database.Database,
  projectId: string,
): ProjectVoiceSettings {
  return {
    voice: readSetting(db, `project:${projectId}:voice`) ?? null,
    countdown: parseCountdown(readSetting(db, `project:${projectId}:countdown`)),
    placement: parsePlacement(readSetting(db, `project:${projectId}:placement`)),
    connector: readSetting(db, `project:${projectId}:connector`) ?? DEFAULT_CONNECTOR,
  }
}

export function saveProjectVoiceSettings(
  db: Database.Database,
  projectId: string,
  value: ProjectVoiceSettings,
): void {
  const set = (suffix: string, v: string | null): void =>
    v === null
      ? clearSetting(db, `project:${projectId}:${suffix}`)
      : writeSetting(db, `project:${projectId}:${suffix}`, v)

  set('voice', value.voice)
  set('countdown', value.countdown === null ? null : value.countdown.join(','))
  set('placement', value.placement)
  set('connector', value.connector)
}

/**
 * The settings a Project actually runs with.
 *
 * The scheduler and the render planner consume only this, so neither has to
 * know whether a value came from the Project, the global setting or a default.
 */
export function getEffectiveVoiceSettings(
  db: Database.Database,
  projectId: string | null,
): EffectiveVoiceSettings {
  const global = getGlobalVoiceSettings(db)
  if (projectId === null) {
    return { ...global, connector: DEFAULT_CONNECTOR }
  }

  const project = getProjectVoiceSettings(db, projectId)
  return {
    voice: project.voice ?? global.voice,
    countdown: project.countdown ?? global.countdown,
    placement: project.placement ?? global.placement,
    connector: project.connector,
    // Not overridable: it is a property of this machine's audio path.
    transmissionDelayMs: global.transmissionDelayMs,
  }
}

/**
 * Which output device each sound plays on.
 *
 * Two independent selectors, because Announcements are piped into a virtual
 * cable feeding Mumble while the operator keeps their own countdown Cues on
 * their own speakers. `null` means the system default.
 */
export function getAudioDevices(db: Database.Database): AudioDeviceSettings {
  return {
    cueSinkId: readSetting(db, 'audio_cue_sink') ?? null,
    announcementSinkId: readSetting(db, 'audio_announcement_sink') ?? null,
  }
}

export function saveAudioDevices(db: Database.Database, value: AudioDeviceSettings): void {
  const set = (key: string, v: string | null): void =>
    v === null ? clearSetting(db, key) : writeSetting(db, key, v)

  set('audio_cue_sink', value.cueSinkId)
  set('audio_announcement_sink', value.announcementSinkId)
}
