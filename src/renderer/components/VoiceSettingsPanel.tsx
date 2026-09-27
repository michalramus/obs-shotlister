import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../store'
import type {
  AudioDeviceSettings,
  AudioOutput,
  GlobalVoiceSettings,
  OutputCarries,
  PartRenderState,
  PhrasePlacement,
  ProjectClipStats,
  ProjectVoiceSettings,
  RenderState,
  VirtualOutputState,
} from '../../shared/ipc-contract'
import { toMediaUrl } from '../../shared/media-url'
import { NUMBER_CLIP_MAX, NUMBER_CLIP_MIN } from '../../shared/number-text'
import { OUTPUT_DELAY_MAX_MS, OUTPUT_DELAY_MIN_MS } from '../../shared/audio/outputs'

// ---------------------------------------------------------------------------
// Countdown parsing
//
// Numbers are rendered once per Voice over a fixed range (ADR 0005), so a
// countdown asking for something outside that range would simply be silent on
// show night. It is rejected here, in front of the operator, rather than
// dropped quietly on save the way the stored-settings reader has to drop it.
// ---------------------------------------------------------------------------

/** The range rendered per Voice; a number outside it has no clip and no sound. */
// Taken from the render planner rather than restated: these are exactly the
// numbers a Voice has clips for, so a validator with its own bounds would
// either reject a usable number or accept one nothing ever renders.
export const COUNTDOWN_MIN = NUMBER_CLIP_MIN
export const COUNTDOWN_MAX = NUMBER_CLIP_MAX

export type CountdownParse = { ok: true; countdown: number[] } | { ok: false; error: string }

/**
 * Reads a comma-separated countdown.
 *
 * Every rejection names what is wrong with which entry: a silently shortened
 * countdown is a show-night surprise, and the operator has no other way to see
 * that "10, 5, 3, 2, 0" became "10, 5, 3, 2".
 */
export type DelayParse = { ok: true; delayMs: number } | { ok: false; error: string }

/**
 * Reads an Output's delay, as the operator typed it.
 *
 * Rejects rather than repairs, like the countdown field: a silently corrected
 * delay would mis-time everything that Output carries without ever saying so.
 */
export function parseDelayInput(raw: string): DelayParse {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, delayMs: 0 }

  const ms = Number(trimmed)
  if (!Number.isFinite(ms)) {
    return { ok: false, error: `"${trimmed}" is not a number of milliseconds.` }
  }
  if (ms < OUTPUT_DELAY_MIN_MS || ms > OUTPUT_DELAY_MAX_MS) {
    return {
      ok: false,
      error: `Keep it between ${OUTPUT_DELAY_MIN_MS} and ${OUTPUT_DELAY_MAX_MS} ms.`,
    }
  }
  return { ok: true, delayMs: Math.round(ms) }
}

export function parseCountdownInput(raw: string): CountdownParse {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return { ok: false, error: 'Enter at least one number, e.g. 10, 5, 3, 2, 1.' }
  }

  const numbers: number[] = []
  for (const token of trimmed.split(',').map((t) => t.trim())) {
    if (token === '') {
      return { ok: false, error: 'Empty entry — check the commas.' }
    }
    const n = Number(token)
    if (!Number.isInteger(n)) {
      return { ok: false, error: `"${token}" is not a whole number.` }
    }
    if (n < COUNTDOWN_MIN || n > COUNTDOWN_MAX) {
      return {
        ok: false,
        error: `${n} is outside ${COUNTDOWN_MIN}-${COUNTDOWN_MAX}; only those numbers are rendered.`,
      }
    }
    if (numbers.includes(n)) {
      return { ok: false, error: `${n} is listed twice.` }
    }
    numbers.push(n)
  }

  // Stored largest-first so the field reads back the way it is spoken, whatever
  // order it was typed in. The scheduler does not care about order.
  return { ok: true, countdown: [...numbers].sort((a, b) => b - a) }
}

export function formatCountdown(countdown: number[]): string {
  return countdown.join(', ')
}

// ---------------------------------------------------------------------------
// Global setting plus per-Project override
// ---------------------------------------------------------------------------

export interface EffectiveSetting<T> {
  value: T
  /** Where `value` came from, so an override control can say what it replaced. */
  source: 'project' | 'global'
}

/**
 * The value a Project actually runs with. `null` is "no override", never a
 * value: a Project that clears its Voice follows the global one from then on,
 * including when the global one later changes.
 */
export function effectiveSetting<T>(global: T, override: T | null): EffectiveSetting<T> {
  return override === null
    ? { value: global, source: 'global' }
    : { value: override, source: 'project' }
}

// ---------------------------------------------------------------------------
// Render status
// ---------------------------------------------------------------------------

export const RENDER_STATE_LABEL: Record<RenderState, string> = {
  rendered: 'rendered',
  stale: 'stale',
  missing: 'never rendered',
}

export interface RenderSummary {
  total: number
  rendered: number
  stale: number
  missing: number
  /** Stale plus missing — what warns before a show and what one click fixes. */
  unrendered: number
  headline: string
}

export function summarizeRenderStates(parts: PartRenderState[]): RenderSummary {
  const rendered = parts.filter((p) => p.state === 'rendered').length
  const stale = parts.filter((p) => p.state === 'stale').length
  const missing = parts.filter((p) => p.state === 'missing').length
  const total = parts.length
  const unrendered = stale + missing

  let headline: string
  if (total === 0) {
    headline = 'No parts in this project yet.'
  } else if (unrendered === 0) {
    headline = `All ${total} ${total === 1 ? 'part is' : 'parts are'} rendered.`
  } else {
    // Stale and missing are counted apart because they read differently to an
    // operator: stale means the wrong words are on disk, missing means silence.
    headline = `${rendered} of ${total} rendered - ${stale} stale, ${missing} never rendered.`
  }

  return { total, rendered, stale, missing, unrendered, headline }
}

/** How many Parts the collapsed per-Part list shows. */
export const RENDER_ROWS_COLLAPSED = 5

/**
 * The Part rows the per-Part table shows.
 *
 * A Project can hold dozens of Parts, and the whole list pushes the render and
 * cache buttons off the panel — so the list is a footnote until the operator
 * asks for it. The stored order is kept either way: the operator recognises the
 * list by it, and the headline already carries the counts that matter.
 */
export function visibleRenderRows(parts: PartRenderState[], expanded: boolean): PartRenderState[] {
  return expanded ? parts : parts.slice(0, RENDER_ROWS_COLLAPSED)
}

// ---------------------------------------------------------------------------
// Deleting recordings, per Project
//
// Deleting is one-way and the cache is shared, so every number here exists to
// stop the operator guessing: which Projects are picked, how many recordings
// that actually frees, and the fact that a recording two Projects want is freed
// by neither. The counts arrive from the main process already exclusive
// (`ProjectClipStats`); nothing below recomputes one.
// ---------------------------------------------------------------------------

/** Adds or removes one Project from the picker's selection. */
export function toggleProjectSelection(selected: readonly string[], projectId: string): string[] {
  return selected.includes(projectId)
    ? selected.filter((id) => id !== projectId)
    : [...selected, projectId]
}

export interface ClipSelectionSummary {
  /** Projects picked. Rows the stats do not know about are ignored. */
  projects: number
  /** Recordings those Projects would lose between them. */
  clips: number
}

/**
 * What the picked Projects add up to.
 *
 * Sums the exclusive counts, which is safe precisely because they are exclusive:
 * no recording is counted twice, because a recording two Projects share is
 * counted for neither.
 */
export function summarizeClipSelection(
  stats: readonly ProjectClipStats[],
  selected: readonly string[],
): ClipSelectionSummary {
  const picked = stats.filter((row) => selected.includes(row.projectId))
  return {
    projects: picked.length,
    clips: picked.reduce((total, row) => total + row.clipCount, 0),
  }
}

/** The line beside the picker's button, so the scale is visible before the confirm. */
export function describeClipSelection(
  stats: readonly ProjectClipStats[],
  selected: readonly string[],
): string {
  const { projects, clips } = summarizeClipSelection(stats, selected)
  if (projects === 0) return 'No project picked.'
  return `${clips} recording${clips === 1 ? '' : 's'} from ${projects} project${
    projects === 1 ? '' : 's'
  } will be deleted.`
}

/** How many Projects the confirmation names before it falls back to a count. */
export const CONFIRM_NAMED_PROJECTS = 3

/**
 * What the operator has to agree to before anything is deleted.
 *
 * Names the scale first — how many recordings from how many Projects — then the
 * Projects themselves while there are few enough to read, and keeps both
 * standing warnings: shared recordings survive, and the Parts will read as
 * missing until they are rendered again.
 */
export function deleteClipsConfirmation(
  stats: readonly ProjectClipStats[],
  selected: readonly string[],
): string {
  const { projects, clips } = summarizeClipSelection(stats, selected)
  const names = stats.filter((row) => selected.includes(row.projectId)).map((row) => row.name)

  const head = `Delete ${clips} recording${clips === 1 ? '' : 's'} from ${projects} project${
    projects === 1 ? '' : 's'
  }?`
  const who = names.length <= CONFIRM_NAMED_PROJECTS ? `\n\n${names.join(', ')}` : ''
  return (
    `${head}${who}\n\n` +
    'Recordings shared with another project are kept. Parts are not touched — ' +
    'they will read as missing until you render again.'
  )
}

/** What the note line says once the deletions have run. */
export function describeClipDeletion(removed: number, projects: number): string {
  if (removed === 0) {
    return projects === 1
      ? 'Nothing deleted — that project had no recordings of its own.'
      : 'Nothing deleted — those projects had no recordings of their own.'
  }
  return `Deleted ${removed} recording${removed === 1 ? '' : 's'} from ${projects} project${
    projects === 1 ? '' : 's'
  }.`
}

// ---------------------------------------------------------------------------
// Output devices
// ---------------------------------------------------------------------------

export interface OutputDevice {
  deviceId: string
  label: string
}

/** The empty option's value; `null` in storage means the system default. */
export const SYSTEM_DEFAULT_VALUE = ''

/**
 * Chromium reports empty labels until microphone permission is granted, so a
 * raw list is a column of blank rows. The id is not friendly, but it is at
 * least distinguishable and stable enough to pick by.
 */
export function deviceLabel(device: OutputDevice): string {
  const label = device.label.trim()
  if (label !== '') return label
  if (device.deviceId === 'default') return 'System default output'
  if (device.deviceId === 'communications') return 'Communications output'
  return `Unnamed output (${device.deviceId.slice(0, 8)})`
}

/**
 * The options a selector offers, including the system default and — when the
 * saved device is not plugged in — the saved id itself, so an absent device
 * shows as absent instead of the selector silently reading as "default".
 */
export function deviceOptions(devices: OutputDevice[], selectedId: string | null): OutputDevice[] {
  const options: OutputDevice[] = [
    { deviceId: SYSTEM_DEFAULT_VALUE, label: 'System default' },
    ...devices.map((d) => ({ deviceId: d.deviceId, label: deviceLabel(d) })),
  ]
  if (selectedId !== null && !devices.some((d) => d.deviceId === selectedId)) {
    options.push({
      deviceId: selectedId,
      label: `Not connected (${selectedId.slice(0, 8)})`,
    })
  }
  return options
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const STATE_COLOR: Record<RenderState, string> = {
  rendered: '#27ae60',
  stale: '#e67e22',
  missing: '#c0392b',
}

const s = {
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.65)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  } satisfies React.CSSProperties,

  panel: {
    background: '#1e1e1e',
    borderRadius: '10px',
    border: '1px solid #444',
    padding: '28px',
    width: '620px',
    maxWidth: '95vw',
    maxHeight: '85vh',
    overflowY: 'auto' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '20px',
  } satisfies React.CSSProperties,

  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexShrink: 0,
  } satisfies React.CSSProperties,

  title: {
    margin: 0,
    fontSize: '17px',
    fontWeight: 600,
    color: '#fff',
  } satisfies React.CSSProperties,

  sectionTitle: {
    margin: '0 0 10px',
    fontSize: '13px',
    fontWeight: 600,
    color: '#888',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  } satisfies React.CSSProperties,

  closeBtn: {
    background: 'none',
    border: 'none',
    color: '#aaa',
    fontSize: '20px',
    cursor: 'pointer',
    lineHeight: 1,
    padding: '4px 8px',
  } satisfies React.CSSProperties,

  label: {
    fontSize: '12px',
    color: '#888',
    marginBottom: '4px',
    display: 'block',
  } satisfies React.CSSProperties,

  hint: {
    margin: '4px 0 0',
    fontSize: '12px',
    color: '#777',
  } satisfies React.CSSProperties,

  input: {
    padding: '8px',
    fontSize: '14px',
    borderRadius: '4px',
    border: '1px solid #555',
    background: '#2a2a2a',
    color: '#fff',
    width: '100%',
    boxSizing: 'border-box' as const,
  } satisfies React.CSSProperties,

  select: {
    padding: '5px 8px',
    fontSize: '14px',
    borderRadius: '4px',
    border: '1px solid #555',
    background: '#2a2a2a',
    color: '#fff',
    width: '100%',
    boxSizing: 'border-box' as const,
  } satisfies React.CSSProperties,

  fieldRow: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: '8px',
  } satisfies React.CSSProperties,

  grow: {
    flex: 1,
    minWidth: 0,
  } satisfies React.CSSProperties,

  errorText: {
    color: '#e74c3c',
    fontSize: '13px',
    margin: '4px 0 0',
    // A render failure explains itself over several lines — which binary, and
    // what to do about it. Collapsing them runs the fix into the diagnosis.
    whiteSpace: 'pre-line' as const,
  } satisfies React.CSSProperties,

  smallBtn: {
    padding: '7px 10px',
    fontSize: '12px',
    borderRadius: '4px',
    border: '1px solid #555',
    background: '#2a2a2a',
    color: '#aaa',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  } satisfies React.CSSProperties,

  primaryBtn: {
    padding: '8px 16px',
    borderRadius: '4px',
    border: 'none',
    fontSize: '14px',
    fontWeight: 600,
    background: '#27ae60',
    color: '#fff',
    cursor: 'pointer',
  } satisfies React.CSSProperties,

  dangerBtn: {
    padding: '7px 10px',
    fontSize: '12px',
    borderRadius: '4px',
    border: '1px solid #7a3630',
    background: '#2a2a2a',
    color: '#e0796f',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  } satisfies React.CSSProperties,

  noteText: {
    color: '#888',
    fontSize: '12px',
    margin: '6px 0 0',
  } satisfies React.CSSProperties,

  cacheRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginTop: '10px',
    // Three buttons, and the middle one has a long label: wrapping beats
    // squeezing them on a narrow window.
    flexWrap: 'wrap' as const,
  } satisfies React.CSSProperties,

  /** The per-Project delete picker, set apart because everything in it deletes. */
  picker: {
    marginTop: '10px',
    padding: '8px 10px',
    border: '1px solid #7a3630',
    borderRadius: '4px',
    background: '#241d1d',
  } satisfies React.CSSProperties,

  toggleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    fontSize: '14px',
    color: '#ccc',
  } satisfies React.CSSProperties,

  toggleTrack: (on: boolean): React.CSSProperties => ({
    width: '44px',
    height: '24px',
    borderRadius: '12px',
    background: on ? '#27ae60' : '#555',
    border: 'none',
    cursor: 'pointer',
    position: 'relative',
    flexShrink: 0,
    transition: 'background 0.2s',
  }),

  toggleThumb: (on: boolean): React.CSSProperties => ({
    position: 'absolute',
    top: '2px',
    left: on ? '22px' : '2px',
    width: '20px',
    height: '20px',
    borderRadius: '50%',
    background: '#fff',
    transition: 'left 0.15s',
  }),

  summaryRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    fontSize: '14px',
    color: '#ccc',
  } satisfies React.CSSProperties,

  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: '14px',
    marginTop: '12px',
  } satisfies React.CSSProperties,

  th: {
    textAlign: 'left' as const,
    padding: '6px 8px',
    color: '#888',
    fontWeight: 500,
    borderBottom: '1px solid #333',
    fontSize: '12px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  } satisfies React.CSSProperties,

  td: {
    padding: '6px 8px',
    verticalAlign: 'middle' as const,
    borderBottom: '1px solid #2a2a2a',
    color: '#ddd',
  } satisfies React.CSSProperties,

  expandBtn: {
    padding: '4px 0',
    marginTop: '6px',
    border: 'none',
    background: 'none',
    color: '#888',
    fontSize: '12px',
    cursor: 'pointer',
  } satisfies React.CSSProperties,

  stateBadge: (state: RenderState): React.CSSProperties => ({
    color: STATE_COLOR[state],
    fontSize: '12px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  }),
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

const PLACEMENT_HINT: Record<PhrasePlacement, string> = {
  flush:
    'Flush: the name is scheduled backwards from the first number, so name and countdown are one continuous sentence.',
  immediate:
    'Immediate: the name plays the moment the previous call starts, however far the numbers are away.',
}

interface OutputDeviceSelectProps {
  id: string
  title: string
  hint: string
  devices: OutputDevice[]
  selectedId: string | null
  /** True while the Output is switched off: shown, and not changeable. */
  disabled?: boolean
  onChange: (sinkId: string | null) => void
}

function OutputDeviceSelect({
  id,
  title,
  hint,
  devices,
  selectedId,
  disabled = false,
  onChange,
}: OutputDeviceSelectProps): React.JSX.Element {
  return (
    <div style={{ marginTop: '8px' }}>
      <label style={s.label} htmlFor={id}>
        {title}
      </label>
      <select
        id={id}
        style={s.select}
        value={selectedId ?? SYSTEM_DEFAULT_VALUE}
        disabled={disabled}
        aria-label={title}
        onChange={(e) => onChange(e.target.value === SYSTEM_DEFAULT_VALUE ? null : e.target.value)}
      >
        {deviceOptions(devices, selectedId).map((option) => (
          <option key={option.deviceId} value={option.deviceId}>
            {option.label}
          </option>
        ))}
      </select>
      <p style={s.hint}>{hint}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Outputs
//
// Two Outputs, each saying where it plays, how early, and what it carries (ADR
// 0010). There is no Intercom section any more: a loopback device is simply what
// an Output can be pointed at, so the guidance about that device follows whichever
// Output is pointed at one.
// ---------------------------------------------------------------------------

/** Suffix marking a device the platform's loopback names matched. */
export const LOOPBACK_SUFFIX = ' — loopback'

/**
 * Marks the devices whose name says they loop back.
 *
 * Matching on the name is the only option a renderer has: the device list carries
 * no "this is virtual" flag, and the device ids are opaque. It is a hint, not a
 * gate — every device stays selectable on every Output, because a cable somebody
 * named themselves is still a valid route to a voice-chat client.
 */
export function markLoopbackDevices(
  devices: OutputDevice[],
  hints: readonly string[],
): OutputDevice[] {
  return devices.map((device) => {
    const label = device.label.toLowerCase()
    const isLoopback = hints.some((hint) => hint !== '' && label.includes(hint))
    return isLoopback ? { ...device, label: `${device.label}${LOOPBACK_SUFFIX}` } : device
  })
}

/** The first marked device, for the "use this one" shortcut. Null when none is. */
export function suggestLoopbackDevice(marked: OutputDevice[]): OutputDevice | null {
  return marked.find((device) => device.label.endsWith(LOOPBACK_SUFFIX)) ?? null
}

/**
 * What each choice of what an Output carries is called in front of the operator.
 *
 * The stored values are `voice` and `cues`, which are the words the code uses for
 * the two kinds of sound. Neither is what an operator calls them, and an Output
 * labelled "voice" would read as a microphone rather than as the thing that speaks
 * the next Part's name — so the label names the sound, not the field.
 */
export const OUTPUT_CARRIES_LABEL: Record<OutputCarries, string> = {
  both: 'Both',
  voice: 'Announcements',
  cues: 'Countdown and beeps',
}

/** The order the choices are offered in: the widest first, which is the default. */
export const OUTPUT_CARRIES_ORDER: readonly OutputCarries[] = ['both', 'voice', 'cues']

/**
 * What an Output's delay does, in words.
 *
 * Spelled out because the sign is the one thing about a delay an operator can get
 * backwards, and getting it backwards doubles the error: a delay makes a sound
 * play *earlier*, to land on the beat after the route has buffered it. The field
 * is the only place that can say so before a show rather than after one.
 */
export function describeOutputDelay(delayMs: number): string {
  if (delayMs === 0) return 'Played at the moment it is wanted. Right for your own speakers.'
  if (delayMs > 0) {
    return `Everything this output carries plays ${delayMs} ms early, so it is heard on the beat after the route has buffered it.`
  }
  return `Everything this output carries plays ${-delayMs} ms late — only right for a route that somehow runs ahead.`
}

/**
 * The settings with one Output changed.
 *
 * The pair is positional and Output 1 is the operator's own (see
 * {@link AudioDeviceSettings}), so patching one by index — rather than rebuilding
 * the array at each call site — is what keeps a save from quietly swapping them.
 */
export function outputWith(
  settings: AudioDeviceSettings,
  index: 0 | 1,
  patch: Partial<AudioOutput>,
): AudioDeviceSettings {
  const outputs: [AudioOutput, AudioOutput] = [settings.outputs[0], settings.outputs[1]]
  outputs[index] = { ...outputs[index], ...patch }
  return { outputs }
}

/**
 * Which Output the Virtual output's status and guidance belongs under.
 *
 * It follows the loopback device: whichever Output is pointed at one is the Output
 * feeding a voice-chat client, and *“Shotlister Out is running, record Monitor of
 * Shotlister Out”* is a sentence about that route rather than about the app. A
 * disabled Output is not a route, so it does not claim the guidance.
 *
 * When no Output has one, it goes under Output 2: an operator with nothing
 * installed still has to be told what to install (ADR 0008), and Output 2 is where
 * a second listener is set up — it is also where an older install's Intercom
 * output landed.
 */
export function virtualOutputGuidanceIndex(
  outputs: readonly [AudioOutput, AudioOutput],
  marked: OutputDevice[],
): 0 | 1 {
  const isLoopback = (sinkId: string | null): boolean =>
    sinkId !== null &&
    marked.some((d) => d.deviceId === sinkId && d.label.endsWith(LOOPBACK_SUFFIX))
  if (outputs[1].enabled && isLoopback(outputs[1].sinkId)) return 1
  if (outputs[0].enabled && isLoopback(outputs[0].sinkId)) return 0
  return 1
}

/**
 * One Output's delay, in milliseconds.
 *
 * Draft-and-commit like the countdown field: a delay is typed a digit at a time,
 * and saving each keystroke would point the whole show at 4ms on the way to 400.
 */
function OutputDelayField({
  id,
  delayMs,
  disabled,
  onCommit,
  onError,
}: {
  id: string
  delayMs: number
  disabled: boolean
  onCommit: (delayMs: number) => void
  onError: (message: string | null) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(delayMs))
  const [problem, setProblem] = useState<string | null>(null)

  // Follow the stored value when it changes underneath us, but never while the
  // operator is mid-edit with something invalid in the box.
  useEffect(() => {
    if (problem === null) setDraft(String(delayMs))
  }, [delayMs, problem])

  function commit(): void {
    const parsed = parseDelayInput(draft)
    if (!parsed.ok) {
      setProblem(parsed.error)
      return
    }
    setProblem(null)
    onError(null)
    if (parsed.delayMs !== delayMs) onCommit(parsed.delayMs)
  }

  return (
    <div style={{ marginTop: '8px' }}>
      <label style={s.label} htmlFor={id}>
        Delay (ms)
      </label>
      <input
        id={id}
        style={s.input}
        value={draft}
        disabled={disabled}
        onChange={(e) => {
          setDraft(e.target.value)
          setProblem(null)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
        inputMode="numeric"
        placeholder="0"
      />
      <p style={s.hint}>{describeOutputDelay(delayMs)}</p>
      {problem !== null && <p style={s.errorText}>{problem}</p>}
    </div>
  )
}

interface OutputSectionProps {
  index: 0 | 1
  output: AudioOutput
  /** Devices with the loopback ones marked, so either Output can pick one out. */
  marked: OutputDevice[]
  suggestion: OutputDevice | null
  /** The Virtual output's state, shown under the Output that feeds it. */
  virtual: VirtualOutputState | null
  showVirtual: boolean
  creating: boolean
  onCreateVirtual: () => void
  onChange: (patch: Partial<AudioOutput>) => void
  onError: (message: string | null) => void
}

/**
 * One Output: its device, its delay, and what it carries.
 *
 * Output 1 has no switch — the operator's own copy is the one that must always
 * exist — so the toggle is Output 2's alone, and Output 2's controls read as inert
 * while it is off rather than disappearing: an operator who switched it off last
 * week should still see what it was pointed at.
 */
function OutputSection({
  index,
  output,
  marked,
  suggestion,
  virtual,
  showVirtual,
  creating,
  onCreateVirtual,
  onChange,
  onError,
}: OutputSectionProps): React.JSX.Element {
  const number = index + 1
  const off = !output.enabled

  function handleTest(): void {
    const sinkId = output.sinkId
    window.api.assets
      .getAudioDir()
      .then(async (dir) => {
        const audio = new Audio(`${toMediaUrl(dir)}/beep.opus`) as HTMLAudioElement & {
          setSinkId?: (id: string) => Promise<void>
        }
        // Routed before playing, and the failure is reported rather than swallowed:
        // proving the route is the entire point of the button. '' is the API's way
        // of naming the system default.
        if (typeof audio.setSinkId === 'function') await audio.setSinkId(sinkId ?? '')
        await audio.play()
      })
      .catch((err: unknown) =>
        onError(err instanceof Error ? err.message : 'Could not play the test beep.'),
      )
  }

  return (
    <div style={{ marginTop: '16px', borderTop: '1px solid #333', paddingTop: '12px' }}>
      {index === 0 ? (
        <p style={s.sectionTitle}>Output 1 — your own</p>
      ) : (
        <div style={s.toggleRow}>
          <button
            style={s.toggleTrack(output.enabled)}
            onClick={() => onChange({ enabled: !output.enabled })}
            aria-label={output.enabled ? 'Disable output 2' : 'Enable output 2'}
          >
            <span style={s.toggleThumb(output.enabled)} />
          </button>
          <span>Output 2</span>
        </div>
      )}

      {/* Inert rather than gone: what it was pointed at is worth seeing. */}
      <div style={{ opacity: off ? 0.45 : 1 }}>
        <OutputDeviceSelect
          id={`audio-output-${number}-sink`}
          title="Device"
          hint={
            index === 0
              ? 'Where you hear the show. This is the copy your mute button silences, and the only one that falls back to the system default if its device disappears.'
              : 'A second listener — typically the loopback device a voice-chat client sends on to the band. If its device disappears this copy goes silent rather than landing in your ears.'
          }
          devices={marked}
          selectedId={output.sinkId}
          disabled={off}
          onChange={(sinkId) => onChange({ sinkId })}
        />

        <OutputDelayField
          id={`audio-output-${number}-delay`}
          delayMs={output.delayMs}
          disabled={off}
          onCommit={(delayMs) => onChange({ delayMs })}
          onError={onError}
        />

        <div style={{ marginTop: '8px' }}>
          <label style={s.label} htmlFor={`audio-output-${number}-carries`}>
            Carries
          </label>
          <select
            id={`audio-output-${number}-carries`}
            style={s.select}
            value={output.carries}
            disabled={off}
            aria-label={`Output ${number} carries`}
            onChange={(e) => onChange({ carries: e.target.value as OutputCarries })}
          >
            {OUTPUT_CARRIES_ORDER.map((carries) => (
              <option key={carries} value={carries}>
                {OUTPUT_CARRIES_LABEL[carries]}
              </option>
            ))}
          </select>
          <p style={s.hint}>
            Announcements are the spoken part names; countdown and beeps are the cues. An output
            carrying neither is silent, which is a choice and not a fault.
          </p>
        </div>

        {showVirtual && virtual !== null && (
          <p style={s.hint}>
            {virtual.present && virtual.monitorLabel !== null
              ? `${virtual.label} is running. Select “${virtual.monitorLabel}” as the input in your intercom client.`
              : (virtual.guidance ?? '')}
            {virtual.creatable && !virtual.present && (
              <>
                {' '}
                <button
                  style={{ ...s.smallBtn, padding: '2px 6px' }}
                  onClick={onCreateVirtual}
                  disabled={creating}
                >
                  Create Shotlister Out
                </button>
              </>
            )}
          </p>
        )}

        <div style={s.fieldRow}>
          <button
            style={s.smallBtn}
            onClick={handleTest}
            disabled={off}
            title={`Play one beep on output ${number} only`}
          >
            Test
          </button>
          {suggestion !== null && output.sinkId !== suggestion.deviceId && (
            <button
              style={s.smallBtn}
              onClick={() => onChange({ sinkId: suggestion.deviceId })}
              disabled={off}
              title={suggestion.label}
            >
              Use the loopback device
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Both Outputs, and the device list they share.
 *
 * Enumerating devices, revealing their names and finding the loopback ones among
 * them are one machine's business rather than one Output's, so they live here and
 * each Output section is handed the answer.
 */
function OutputsSection(): React.JSX.Element {
  const audioDevices = useAppStore((st) => st.audioDevices)
  const saveAudioDevices = useAppStore((st) => st.saveAudioDevices)

  const [devices, setDevices] = useState<OutputDevice[]>([])
  const [error, setError] = useState<string | null>(null)
  const [labelsHidden, setLabelsHidden] = useState(false)
  const [virtual, setVirtual] = useState<VirtualOutputState | null>(null)
  const [hints, setHints] = useState<string[]>([])
  const [creating, setCreating] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      const outputs = all
        .filter((d) => d.kind === 'audiooutput')
        .map((d) => ({ deviceId: d.deviceId, label: d.label }))
      setDevices(outputs)
      setLabelsHidden(outputs.length > 0 && outputs.every((d) => d.label.trim() === ''))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not list output devices.')
    }
  }, [])

  const readVirtualState = useCallback(async (): Promise<void> => {
    try {
      const [state, loopbackHints] = await Promise.all([
        window.api.audioDevices.virtualState(),
        window.api.audioDevices.loopbackHints(),
      ])
      setVirtual(state)
      setHints(loopbackHints)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the virtual output.')
    }
  }, [])

  useEffect(() => {
    void refresh()
    void readVirtualState()
    // A cable plugged in while the panel is open should appear without reopening it.
    const onDeviceChange = (): void => void refresh()
    const media = navigator.mediaDevices as MediaDevices | undefined
    media?.addEventListener('devicechange', onDeviceChange)
    return () => media?.removeEventListener('devicechange', onDeviceChange)
  }, [refresh, readVirtualState])

  async function handleRevealNames(): Promise<void> {
    try {
      // Chromium withholds device labels until a media permission is granted;
      // the stream is released immediately, nothing is recorded.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      for (const track of stream.getTracks()) track.stop()
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Permission denied.')
    }
  }

  async function handleCreateVirtual(): Promise<void> {
    setCreating(true)
    try {
      setVirtual(await window.api.audioDevices.ensureVirtual())
      // The new sink is not in a device list enumerated before it existed.
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the virtual output.')
    } finally {
      setCreating(false)
    }
  }

  function change(index: 0 | 1, patch: Partial<AudioOutput>): void {
    saveAudioDevices(outputWith(audioDevices, index, patch)).catch((err: unknown) =>
      setError(err instanceof Error ? err.message : 'Could not save the output.'),
    )
  }

  /** Devices whose name says they loop back, marked so they can be picked out. */
  const marked = useMemo(() => markLoopbackDevices(devices, hints), [devices, hints])
  const suggestion = useMemo(() => suggestLoopbackDevice(marked), [marked])
  const guidanceIndex = useMemo(
    () => virtualOutputGuidanceIndex(audioDevices.outputs, marked),
    [audioDevices.outputs, marked],
  )

  return (
    <div>
      <div style={{ ...s.summaryRow, marginBottom: '4px' }}>
        <p style={{ ...s.sectionTitle, margin: 0 }}>Outputs</p>
        <button style={s.smallBtn} onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      <p style={s.hint}>
        Each output plays every sound it carries, on its own device and at its own moment. They
        duplicate rather than divide: nothing is taken away from your own speakers.
      </p>

      {([0, 1] as const).map((index) => (
        <OutputSection
          key={index}
          index={index}
          output={audioDevices.outputs[index]}
          marked={marked}
          suggestion={suggestion}
          virtual={virtual}
          showVirtual={guidanceIndex === index}
          creating={creating}
          onCreateVirtual={() => void handleCreateVirtual()}
          onChange={(patch) => change(index, patch)}
          onError={setError}
        />
      ))}

      {labelsHidden && (
        <p style={s.hint}>
          Device names are hidden until microphone permission is granted.{' '}
          <button
            style={{ ...s.smallBtn, padding: '2px 6px' }}
            onClick={() => void handleRevealNames()}
          >
            Show names
          </button>
        </p>
      )}
      {error !== null && <p style={s.errorText}>{error}</p>}
    </div>
  )
}

interface RenderStateSectionProps {
  projectId: string
}

/**
 * What the headline says while a batch runs.
 *
 * The count matters more than it looks: on Apple Silicon the engine takes about
 * five seconds per clip, so a full countdown set is minutes of work. A bare
 * "Rendering..." for that long is indistinguishable from a hung app, and the
 * operator's next move is to restart — mid-batch, which is the one thing that
 * used to lose work.
 */
export function renderingHeadline(
  progress: { completed: number; total: number; stage?: string } | undefined,
): string {
  // A stage is something other than synthesis — installing a voice — and it
  // outranks the count, which would be a stuck "0/62" for the whole download.
  if (progress?.stage) return `${progress.stage}...`
  if (progress === undefined || progress.total === 0) return 'Rendering...'
  return `Rendering ${progress.completed}/${progress.total}...`
}

function RenderStateSection({ projectId }: RenderStateSectionProps): React.JSX.Element {
  const renderSummary = useAppStore((st) => st.renderSummary)
  const renderMissing = useAppStore((st) => st.renderMissing)
  const cleanOrphanClips = useAppStore((st) => st.cleanOrphanClips)
  const deleteProjectClips = useAppStore((st) => st.deleteProjectClips)
  const loadProjectClipStats = useAppStore((st) => st.loadProjectClipStats)
  const openAppDataDir = useAppStore((st) => st.openAppDataDir)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [partsExpanded, setPartsExpanded] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [clipStats, setClipStats] = useState<ProjectClipStats[] | null>(null)
  // The Project on screen starts picked, which is the deletion the single
  // button used to be. Every other Project has to be ticked on purpose.
  const [selectedProjects, setSelectedProjects] = useState<string[]>([projectId])

  const parts = renderSummary?.parts ?? []
  const summary = summarizeRenderStates(parts)
  const rendering = renderSummary?.rendering === true
  const selection = summarizeClipSelection(clipStats ?? [], selectedProjects)

  /**
   * Counts every Project's recordings again.
   *
   * Asked for when the picker opens and after every deletion: a count is a
   * listing of the cache against every Project's render plan, and it is wrong
   * the moment anything is rendered or deleted.
   */
  const refreshClipStats = useCallback(async (): Promise<void> => {
    setClipStats(await loadProjectClipStats())
  }, [loadProjectClipStats])

  // Recounted when the picker opens and whenever a render stops, which is the
  // other thing that changes what is on disk. Not on every pushed summary: a
  // batch pushes one per clip, and each count is a whole cache listing.
  useEffect(() => {
    if (!pickerOpen) return
    refreshClipStats().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : 'Could not count the recordings.'),
    )
  }, [pickerOpen, rendering, refreshClipStats])

  function handleRenderMissing(): void {
    setError(null)
    setNote(null)
    renderMissing(projectId).catch((err: unknown) =>
      setError(err instanceof Error ? err.message : 'Rendering failed.'),
    )
  }

  /** Both cache actions report the same way: a count, or the reason there is none. */
  function runCacheAction(action: () => Promise<number>, describe: (n: number) => string): void {
    setError(null)
    setNote(null)
    setBusy(true)
    action()
      .then((removed) => setNote(describe(removed)))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Deleting recordings failed.'),
      )
      .finally(() => setBusy(false))
  }

  function handleClean(): void {
    runCacheAction(
      () => cleanOrphanClips(projectId),
      (removed) =>
        removed === 0
          ? 'Nothing to clean — every recording on disk is still in use.'
          : `Deleted ${removed} unused recording${removed === 1 ? '' : 's'}.`,
    )
  }

  function handleDeleteSelected(): void {
    if (clipStats === null || selectedProjects.length === 0) return
    if (!window.confirm(deleteClipsConfirmation(clipStats, selectedProjects))) return

    const picked = [...selectedProjects]
    runCacheAction(
      async () => {
        // One Project at a time, through the same call the single button used:
        // the main process keeps one deletion path, so the rule about shared
        // recordings is applied once and the refusals it makes are per Project
        // rather than half-way through a batch it had to invent.
        let removed = 0
        for (const id of picked) removed += await deleteProjectClips(id)
        await refreshClipStats()
        return removed
      },
      (removed) => describeClipDeletion(removed, picked.length),
    )
  }

  function handleOpenFolder(): void {
    setError(null)
    setNote(null)
    openAppDataDir()
      .then((dir) => setNote(`Opened ${dir}`))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Could not open the app folder.'),
      )
  }

  const locked = rendering || busy

  return (
    <div>
      <p style={s.sectionTitle}>Render status</p>
      <div style={s.summaryRow}>
        <span>{rendering ? renderingHeadline(renderSummary?.progress) : summary.headline}</span>
        <button
          style={{
            ...s.primaryBtn,
            opacity: locked || summary.unrendered === 0 ? 0.5 : 1,
            cursor: locked || summary.unrendered === 0 ? 'default' : 'pointer',
          }}
          onClick={handleRenderMissing}
          disabled={locked || summary.unrendered === 0}
          title="Render every missing or stale part across every rundown in this project"
        >
          Render all missing
        </button>
      </div>
      <div style={s.cacheRow}>
        <button
          style={{
            ...s.smallBtn,
            opacity: locked ? 0.5 : 1,
            cursor: locked ? 'default' : 'pointer',
          }}
          onClick={handleClean}
          disabled={locked}
          title="Delete recordings no project points at any more"
        >
          Clean unused
        </button>
        <button
          style={{
            ...s.dangerBtn,
            opacity: locked ? 0.5 : 1,
            cursor: locked ? 'default' : 'pointer',
          }}
          onClick={() => setPickerOpen((on) => !on)}
          disabled={locked}
          aria-expanded={pickerOpen}
          title="Choose which projects' recordings to delete — for projects that no longer need them"
        >
          {pickerOpen ? '▾' : '▸'} Delete recordings...
        </button>
        {/*
          Never disabled by `locked`: looking at the folder is the one thing that
          stays useful while a render is running, and it changes nothing.
        */}
        <button
          style={s.smallBtn}
          onClick={handleOpenFolder}
          title="Open the app's data folder — the recordings and the database live here"
        >
          Open app folder
        </button>
      </div>
      {pickerOpen && (
        <div style={s.picker}>
          <p style={s.hint}>
            Each count is the recordings only that project uses, so the counts do not add up to the
            size of the cache — a recording two projects share is freed by neither.
          </p>
          {clipStats === null && <p style={s.hint}>Counting recordings...</p>}
          {clipStats !== null && clipStats.length === 0 && (
            <p style={s.hint}>There are no projects yet.</p>
          )}
          {clipStats !== null && clipStats.length > 0 && (
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>Delete</th>
                  <th style={s.th}>Project</th>
                  <th style={s.th}>Recordings</th>
                </tr>
              </thead>
              <tbody>
                {clipStats.map((row) => (
                  <tr key={row.projectId}>
                    <td style={s.td}>
                      <input
                        type="checkbox"
                        checked={selectedProjects.includes(row.projectId)}
                        onChange={() =>
                          setSelectedProjects((picked) =>
                            toggleProjectSelection(picked, row.projectId),
                          )
                        }
                        disabled={locked}
                        aria-label={`Delete the recordings of ${row.name}`}
                      />
                    </td>
                    <td style={s.td}>
                      {row.name}
                      {row.projectId === projectId ? ' (open)' : ''}
                    </td>
                    <td style={s.td}>{row.clipCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div style={s.cacheRow}>
            <button
              style={{
                ...s.dangerBtn,
                opacity: locked || selection.projects === 0 ? 0.5 : 1,
                cursor: locked || selection.projects === 0 ? 'default' : 'pointer',
              }}
              onClick={handleDeleteSelected}
              disabled={locked || selection.projects === 0}
              title="Delete the recordings of every ticked project"
            >
              Delete selected recordings
            </button>
            <span style={s.hint}>{describeClipSelection(clipStats ?? [], selectedProjects)}</span>
          </div>
        </div>
      )}

      {error !== null && <p style={s.errorText}>{error}</p>}
      {note !== null && <p style={s.noteText}>{note}</p>}

      {parts.length > 0 && (
        <>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Part</th>
                <th style={s.th}>Audio</th>
              </tr>
            </thead>
            <tbody>
              {visibleRenderRows(parts, partsExpanded).map((part) => (
                <tr key={part.partId}>
                  <td style={s.td}>{part.name}</td>
                  <td style={s.td}>
                    <span style={s.stateBadge(part.state)}>{RENDER_STATE_LABEL[part.state]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {parts.length > RENDER_ROWS_COLLAPSED && (
            <button
              style={s.expandBtn}
              onClick={() => setPartsExpanded((on) => !on)}
              aria-expanded={partsExpanded}
              aria-label={
                partsExpanded
                  ? `Show only the first ${RENDER_ROWS_COLLAPSED} parts`
                  : `Show all ${parts.length} parts`
              }
            >
              {partsExpanded ? '▾ Show less' : `▸ Show all ${parts.length}`}
            </button>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// VoiceSettingsPanel
// ---------------------------------------------------------------------------

export interface VoiceSettingsPanelProps {
  onClose: () => void
}

export function VoiceSettingsPanel({ onClose }: VoiceSettingsPanelProps): React.JSX.Element {
  const activeProjectId = useAppStore((st) => st.activeProjectId)
  const voiceSettings = useAppStore((st) => st.voiceSettings)
  const projectVoiceSettings = useAppStore((st) => st.projectVoiceSettings)
  const loadVoiceSettings = useAppStore((st) => st.loadVoiceSettings)
  const saveVoiceSettings = useAppStore((st) => st.saveVoiceSettings)
  const saveProjectVoiceSettings = useAppStore((st) => st.saveProjectVoiceSettings)
  const loadRenderSummary = useAppStore((st) => st.loadRenderSummary)
  const loadAudioDevices = useAppStore((st) => st.loadAudioDevices)

  const [error, setError] = useState<string | null>(null)

  // Text fields are edited freely and committed on blur; everything else saves
  // on change. A half-typed voice id or countdown must not reach the store.
  const [globalVoiceDraft, setGlobalVoiceDraft] = useState('')
  const [projectVoiceDraft, setProjectVoiceDraft] = useState('')
  const [connectorDraft, setConnectorDraft] = useState('')
  const [globalCountdownDraft, setGlobalCountdownDraft] = useState('')
  const [projectCountdownDraft, setProjectCountdownDraft] = useState('')
  const [globalCountdownError, setGlobalCountdownError] = useState<string | null>(null)
  const [projectCountdownError, setProjectCountdownError] = useState<string | null>(null)

  useEffect(() => {
    loadVoiceSettings(activeProjectId).catch((err: unknown) =>
      setError(err instanceof Error ? err.message : 'Could not load voice settings.'),
    )
    loadAudioDevices().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : 'Could not load audio devices.'),
    )
    if (activeProjectId !== null) {
      loadRenderSummary(activeProjectId).catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Could not load render status.'),
      )
    }
  }, [activeProjectId, loadVoiceSettings, loadAudioDevices, loadRenderSummary])

  useEffect(() => {
    if (voiceSettings === null) return
    setGlobalVoiceDraft(voiceSettings.voice)
    setGlobalCountdownDraft(formatCountdown(voiceSettings.countdown))
    setGlobalCountdownError(null)
  }, [voiceSettings])

  useEffect(() => {
    if (projectVoiceSettings === null) return
    setProjectVoiceDraft(projectVoiceSettings.voice ?? '')
    setConnectorDraft(projectVoiceSettings.connector)
    setProjectCountdownDraft(
      projectVoiceSettings.countdown === null
        ? ''
        : formatCountdown(projectVoiceSettings.countdown),
    )
    setProjectCountdownError(null)
  }, [projectVoiceSettings])

  function saveGlobal(patch: Partial<GlobalVoiceSettings>): void {
    if (voiceSettings === null) return
    setError(null)
    saveVoiceSettings({ ...voiceSettings, ...patch }).catch((err: unknown) =>
      setError(err instanceof Error ? err.message : 'Could not save the setting.'),
    )
  }

  function saveProject(patch: Partial<ProjectVoiceSettings>): void {
    if (projectVoiceSettings === null || activeProjectId === null) return
    setError(null)
    saveProjectVoiceSettings(activeProjectId, { ...projectVoiceSettings, ...patch }).catch(
      (err: unknown) =>
        setError(err instanceof Error ? err.message : 'Could not save the project override.'),
    )
  }

  const globalCountdown = voiceSettings?.countdown ?? []
  const globalVoice = voiceSettings?.voice ?? ''
  const globalPlacement: PhrasePlacement = voiceSettings?.placement ?? 'flush'
  const effectivePlacement = effectiveSetting(
    globalPlacement,
    projectVoiceSettings?.placement ?? null,
  )

  function commitGlobalCountdown(): void {
    const parsed = parseCountdownInput(globalCountdownDraft)
    if (!parsed.ok) {
      setGlobalCountdownError(parsed.error)
      return
    }
    setGlobalCountdownError(null)
    setGlobalCountdownDraft(formatCountdown(parsed.countdown))
    saveGlobal({ countdown: parsed.countdown })
  }

  function commitProjectCountdown(): void {
    // Empty is not an error here: it is how an override is cleared.
    if (projectCountdownDraft.trim() === '') {
      setProjectCountdownError(null)
      saveProject({ countdown: null })
      return
    }
    const parsed = parseCountdownInput(projectCountdownDraft)
    if (!parsed.ok) {
      setProjectCountdownError(parsed.error)
      return
    }
    setProjectCountdownError(null)
    setProjectCountdownDraft(formatCountdown(parsed.countdown))
    saveProject({ countdown: parsed.countdown })
  }

  const hasProject = activeProjectId !== null && projectVoiceSettings !== null

  return (
    <div style={s.overlay} role="dialog" aria-modal="true" aria-labelledby="voice-settings-title">
      <div style={s.panel}>
        <div style={s.header}>
          <h2 id="voice-settings-title" style={s.title}>
            Voice &amp; Audio Settings
          </h2>
          <button style={s.closeBtn} onClick={onClose} aria-label="Close voice settings">
            ✕
          </button>
        </div>

        {/*
          First, not last. This is the only thing in the panel anyone opens it to
          *do* — everything below is configuration you set once. Rendering is also
          the slow action, so it wants to be started before you go looking for
          anything else, not found after scrolling past six sections of settings.
        */}
        {activeProjectId !== null && <RenderStateSection projectId={activeProjectId} />}

        <p style={s.hint}>
          Every setting here is global, with an optional override for the active project. The
          connector word is per-project only.
        </p>

        {error !== null && <p style={s.errorText}>{error}</p>}

        {/* Voice */}
        <div>
          <p style={s.sectionTitle}>Voice</p>
          <label style={s.label} htmlFor="voice-global">
            Global voice
          </label>
          <input
            id="voice-global"
            style={s.input}
            value={globalVoiceDraft}
            aria-label="Global voice"
            placeholder="pl_PL-gosia-medium"
            onChange={(e) => setGlobalVoiceDraft(e.target.value)}
            onBlur={() => {
              const value = globalVoiceDraft.trim()
              if (value === '' || value === globalVoice) {
                setGlobalVoiceDraft(globalVoice)
                return
              }
              saveGlobal({ voice: value })
            }}
          />
          <p style={s.hint}>The synthetic speaker, by voice id.</p>

          {hasProject && (
            <div style={{ marginTop: '12px' }}>
              <label style={s.label} htmlFor="voice-project">
                This project
              </label>
              <div style={s.fieldRow}>
                <input
                  id="voice-project"
                  style={{ ...s.input, ...s.grow }}
                  value={projectVoiceDraft}
                  aria-label="Project voice override"
                  placeholder={`Using global: ${globalVoice}`}
                  onChange={(e) => setProjectVoiceDraft(e.target.value)}
                  onBlur={() => {
                    const value = projectVoiceDraft.trim()
                    saveProject({ voice: value === '' ? null : value })
                  }}
                />
                <button
                  style={s.smallBtn}
                  onClick={() => {
                    setProjectVoiceDraft('')
                    saveProject({ voice: null })
                  }}
                  disabled={projectVoiceSettings?.voice === null}
                  title="Follow the global voice again"
                >
                  Use global
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Connector — per-Project only */}
        {hasProject && (
          <div>
            <p style={s.sectionTitle}>Connector</p>
            <input
              style={s.input}
              value={connectorDraft}
              aria-label="Connector word"
              placeholder="za"
              onChange={(e) => setConnectorDraft(e.target.value)}
              onBlur={() => {
                const value = connectorDraft.trim()
                if (value === '') {
                  setConnectorDraft(projectVoiceSettings?.connector ?? '')
                  return
                }
                saveProject({ connector: value })
              }}
            />
            <p style={s.hint}>
              Spoken after the part name: &quot;gitara {connectorDraft || 'za'} 10&quot;.
              Per-project only - it follows the band&apos;s language, not the machine.
            </p>
          </div>
        )}

        {/* Countdown */}
        <div>
          <p style={s.sectionTitle}>Countdown numbers</p>
          <label style={s.label} htmlFor="countdown-global">
            Global
          </label>
          <input
            id="countdown-global"
            style={s.input}
            value={globalCountdownDraft}
            aria-label="Global countdown numbers"
            placeholder="10, 5, 3, 2, 1"
            onChange={(e) => setGlobalCountdownDraft(e.target.value)}
            onBlur={commitGlobalCountdown}
          />
          {globalCountdownError !== null && <p style={s.errorText}>{globalCountdownError}</p>}
          <p style={s.hint}>
            Whole numbers from {COUNTDOWN_MIN} to {COUNTDOWN_MAX}, separated by commas. Each is
            spoken that many seconds before the call starts.
          </p>

          {hasProject && (
            <div style={{ marginTop: '12px' }}>
              <label style={s.label} htmlFor="countdown-project">
                This project
              </label>
              <div style={s.fieldRow}>
                <input
                  id="countdown-project"
                  style={{ ...s.input, ...s.grow }}
                  value={projectCountdownDraft}
                  aria-label="Project countdown override"
                  placeholder={`Using global: ${formatCountdown(globalCountdown)}`}
                  onChange={(e) => setProjectCountdownDraft(e.target.value)}
                  onBlur={commitProjectCountdown}
                />
                <button
                  style={s.smallBtn}
                  onClick={() => {
                    setProjectCountdownDraft('')
                    setProjectCountdownError(null)
                    saveProject({ countdown: null })
                  }}
                  disabled={projectVoiceSettings?.countdown === null}
                  title="Follow the global countdown again"
                >
                  Use global
                </button>
              </div>
              {projectCountdownError !== null && <p style={s.errorText}>{projectCountdownError}</p>}
            </div>
          )}
        </div>

        {/* Phrase placement */}
        <div>
          <p style={s.sectionTitle}>Phrase placement</p>
          <label style={s.label} htmlFor="placement-global">
            Global
          </label>
          <select
            id="placement-global"
            style={s.select}
            value={globalPlacement}
            aria-label="Global phrase placement"
            onChange={(e) => saveGlobal({ placement: e.target.value as PhrasePlacement })}
          >
            <option value="flush">Flush (default)</option>
            <option value="immediate">Immediate</option>
          </select>
          <p style={s.hint}>{PLACEMENT_HINT.flush}</p>
          <p style={s.hint}>{PLACEMENT_HINT.immediate}</p>

          {hasProject && (
            <div style={{ marginTop: '12px' }}>
              <label style={s.label} htmlFor="placement-project">
                This project
              </label>
              <select
                id="placement-project"
                style={s.select}
                value={projectVoiceSettings?.placement ?? ''}
                aria-label="Project phrase placement override"
                onChange={(e) =>
                  saveProject({
                    placement: e.target.value === '' ? null : (e.target.value as PhrasePlacement),
                  })
                }
              >
                <option value="">Use global ({globalPlacement})</option>
                <option value="flush">Flush</option>
                <option value="immediate">Immediate</option>
              </select>
              <p style={s.hint}>
                This project speaks {effectivePlacement.value}, from the{' '}
                {effectivePlacement.source === 'global' ? 'global setting' : 'project override'}.
              </p>
            </div>
          )}
        </div>

        {/* Auto-render */}
        <div>
          <p style={s.sectionTitle}>Rendering</p>
          <div style={s.toggleRow}>
            <button
              style={s.toggleTrack(voiceSettings?.autoRender === true)}
              onClick={() => saveGlobal({ autoRender: !(voiceSettings?.autoRender === true) })}
              aria-label={
                voiceSettings?.autoRender === true
                  ? 'Disable auto rendering'
                  : 'Enable auto rendering'
              }
            >
              <span style={s.toggleThumb(voiceSettings?.autoRender === true)} />
            </button>
            <span>Auto rendering</span>
          </div>
          <p style={s.hint}>
            On, anything unrendered is synthesised in the background shortly after it appears —
            after an edit, a voice change, opening a project, or starting the app. Off, nothing is
            synthesised until you ask, which is what a slow machine wants while you are editing.
          </p>
        </div>

        {/* Output devices */}
        <OutputsSection />
      </div>
    </div>
  )
}
