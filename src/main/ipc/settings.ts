import Database from 'better-sqlite3'
import { DEFAULT_COUNTDOWN } from '../../shared/announcement'
import {
  OUTPUT_DELAY_MAX_MS,
  OUTPUT_DELAY_MIN_MS,
  defaultAudioOutputs,
} from '../../shared/audio/outputs'
import { NUMBER_CLIP_MAX, NUMBER_CLIP_MIN } from '../../shared/number-text'
import type {
  AudioDeviceSettings,
  AudioOutput,
  EffectiveVoiceSettings,
  GlobalVoiceSettings,
  OutputCarries,
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
export const DEFAULT_VOICE = 'pl_PL-mc_speech-medium'
export const DEFAULT_CONNECTOR = 'za'

// Re-exported so the settings tests read one name, but owned by the Output whose
// delay they bound.
export {
  OUTPUT_DELAY_MIN_MS as MIN_OUTPUT_DELAY_MS,
  OUTPUT_DELAY_MAX_MS as MAX_OUTPUT_DELAY_MS,
} from '../../shared/audio/outputs'

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
 * A stored Output delay, or zero. Like the countdown, a corrupt value reads as
 * unset rather than throwing: a bad setting must not stop a show from starting.
 * Bounded because a delay longer than a Call would simply mute every
 * Announcement, which is never what the operator meant to type.
 */
function parseDelay(raw: string | undefined): number {
  const ms = Number(raw)
  if (!Number.isFinite(ms)) return 0
  return Math.min(Math.max(Math.round(ms), OUTPUT_DELAY_MIN_MS), OUTPUT_DELAY_MAX_MS)
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
  }
}

export function saveGlobalVoiceSettings(db: Database.Database, value: GlobalVoiceSettings): void {
  writeSetting(db, 'voice_voice', value.voice)
  writeSetting(db, 'voice_countdown', value.countdown.join(','))
  writeSetting(db, 'voice_placement', value.placement)
  writeSetting(db, 'voice_auto_render', value.autoRender ? 'true' : 'false')
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
  }
}

// ---------------------------------------------------------------------------
// Outputs
//
// Two Outputs, each with a device, a delay and what it carries (ADR 0010).
// Stored one key per field rather than as JSON, like every other setting here, so
// a corrupt value costs one field instead of both Outputs.
// ---------------------------------------------------------------------------

const OUTPUT_KEY_PREFIXES = ['audio_output1', 'audio_output2'] as const

function parseCarries(raw: string | undefined): OutputCarries | null {
  return raw === 'voice' || raw === 'cues' || raw === 'both' ? raw : null
}

/**
 * What the two Outputs are, for a machine that has never been configured or one
 * whose settings predate them.
 *
 * Read-only: the fallback to the old keys happens here rather than by writing,
 * so reading the settings during a Live session cannot touch the database
 * (CLAUDE.md). {@link migrateAudioDevices} is what makes the new keys real, and
 * this returns the same answer whether it has run or not.
 */
export function getAudioDevices(db: Database.Database): AudioDeviceSettings {
  const stored = OUTPUT_KEY_PREFIXES.map((prefix, index) => {
    const carries = parseCarries(readSetting(db, `${prefix}_carries`))
    // The carries key is written on every save, so its absence is what says this
    // Output has never been stored — a sink id cannot say it, because `null` is a
    // device the operator can deliberately choose.
    if (carries === null) return null
    return {
      // Output 1 is always on; only Output 2 stores a switch.
      enabled: index === 0 || readSetting(db, `${prefix}_enabled`) === 'true',
      sinkId: readSetting(db, `${prefix}_sink`) ?? null,
      delayMs: parseDelay(readSetting(db, `${prefix}_delay`)),
      carries,
    } satisfies AudioOutput
  })

  if (stored[0] !== null && stored[1] !== null) {
    return { outputs: [stored[0], stored[1]] }
  }

  return { outputs: migratedAudioOutputs(db) ?? defaultAudioOutputs() }
}

export function saveAudioDevices(db: Database.Database, value: AudioDeviceSettings): void {
  OUTPUT_KEY_PREFIXES.forEach((prefix, index) => {
    const output = value.outputs[index]
    if (output.sinkId === null) clearSetting(db, `${prefix}_sink`)
    else writeSetting(db, `${prefix}_sink`, output.sinkId)
    writeSetting(db, `${prefix}_delay`, String(Math.round(output.delayMs)))
    writeSetting(db, `${prefix}_carries`, output.carries)
    // Off has to survive a restart as deliberately as on does, so it is written
    // rather than left absent. Output 1 is always on and stores nothing.
    if (index > 0) writeSetting(db, `${prefix}_enabled`, output.enabled ? 'true' : 'false')
  })
}

/** The keys the fixed cue/announcement/intercom destinations were stored under. */
const LEGACY_AUDIO_KEYS = [
  'audio_cue_sink',
  'audio_announcement_sink',
  'audio_intercom_enabled',
  'audio_intercom_sink',
  'voice_transmission_delay',
] as const

/**
 * The two Outputs an older install's settings mean, or `null` when it has none.
 *
 * The old model had three destinations — a Cue device, an Announcement device and
 * an Intercom output taking a copy of both — plus one global path delay, and
 * three destinations do not fit two Outputs. So this migrates by *intent* rather
 * than by count:
 *
 * - Output 1 keeps the Cue device, at no delay: it was always the operator's own.
 * - Output 2 takes the Announcement device and the old path delay, which is the
 *   pair that existed to reach the band.
 * - The Intercom output does not survive as its own concept. A loopback device is
 *   now simply what an Output points at, so an operator who used one re-points an
 *   Output at it — and the migration log says so, because nothing else would.
 *
 * Output 2 is switched on only when the old settings actually asked for a second
 * destination: a delay to compensate, or an Announcement device that was not
 * already the Cue device. When they did not, one Output carrying both is exactly
 * what the old settings did, and leaving Output 1 on `cues` there would have
 * silenced every Announcement.
 */
function migratedAudioOutputs(db: Database.Database): [AudioOutput, AudioOutput] | null {
  const present = LEGACY_AUDIO_KEYS.some((key) => readSetting(db, key) !== undefined)
  if (!present) return null

  const cueSinkId = readSetting(db, 'audio_cue_sink') ?? null
  const announcementSinkId = readSetting(db, 'audio_announcement_sink') ?? null
  const delayMs = parseDelay(readSetting(db, 'voice_transmission_delay'))
  const wantsSecond = delayMs !== 0 || announcementSinkId !== cueSinkId

  return [
    {
      enabled: true,
      sinkId: cueSinkId,
      delayMs: 0,
      carries: wantsSecond ? 'cues' : 'both',
    },
    {
      enabled: wantsSecond,
      sinkId: announcementSinkId,
      delayMs,
      carries: 'voice',
    },
  ]
}

/**
 * Writes the two Outputs an older install's settings meant, once.
 *
 * Called at app start, before any Live session can exist: the read path above
 * answers the same way without it, so this only stops the old keys being
 * reinterpreted forever and gives the operator one line in the log saying what
 * became of their Intercom output.
 */
export function migrateAudioDevices(db: Database.Database): void {
  if (readSetting(db, 'audio_output1_carries') !== undefined) return
  const outputs = migratedAudioOutputs(db)
  if (outputs === null) return

  const hadIntercom = readSetting(db, 'audio_intercom_enabled') === 'true'
  saveAudioDevices(db, { outputs })
  for (const key of LEGACY_AUDIO_KEYS) clearSetting(db, key)

  console.log(
    '[settings] migrated audio settings to two outputs:',
    `output 1 ${outputs[0].carries} on ${outputs[0].sinkId ?? 'the system default'},`,
    outputs[1].enabled
      ? `output 2 ${outputs[1].carries} on ${outputs[1].sinkId ?? 'the system default'} at ${outputs[1].delayMs}ms`
      : 'output 2 off',
    hadIntercom
      ? '- the intercom output is gone; point an output at the loopback device to feed it again'
      : '',
  )
}
