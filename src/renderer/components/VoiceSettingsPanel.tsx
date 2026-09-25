import React, { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '../store'
import type {
  GlobalVoiceSettings,
  PartRenderState,
  PhrasePlacement,
  ProjectVoiceSettings,
  RenderState,
} from '../../shared/ipc-contract'
import { NUMBER_CLIP_MAX, NUMBER_CLIP_MIN } from '../../shared/number-words'
import { TRANSMISSION_DELAY_MAX_MS, TRANSMISSION_DELAY_MIN_MS } from '../../shared/announcement'

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
 * Reads a path delay the operator typed.
 *
 * Rejects rather than repairs, like the countdown field: a silently corrected
 * delay would mis-time every Announcement without ever saying so.
 */
export function parseDelayInput(raw: string): DelayParse {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, delayMs: 0 }

  const ms = Number(trimmed)
  if (!Number.isFinite(ms)) {
    return { ok: false, error: `"${trimmed}" is not a number of milliseconds.` }
  }
  if (ms < TRANSMISSION_DELAY_MIN_MS || ms > TRANSMISSION_DELAY_MAX_MS) {
    return {
      ok: false,
      error: `Keep it between ${TRANSMISSION_DELAY_MIN_MS} and ${TRANSMISSION_DELAY_MAX_MS} ms.`,
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
  onChange: (sinkId: string | null) => void
}

function OutputDeviceSelect({
  id,
  title,
  hint,
  devices,
  selectedId,
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

/**
 * How long the Announcement path takes to reach the band.
 *
 * Lives with the output devices rather than with the Voice settings because it
 * describes the same thing they do — this machine's route to Mumble — and not
 * the show being run over it.
 */
function TransmissionDelayField({
  onError,
}: {
  onError: (message: string | null) => void
}): React.JSX.Element {
  const voiceSettings = useAppStore((st) => st.voiceSettings)
  const saveVoiceSettings = useAppStore((st) => st.saveVoiceSettings)

  const stored = voiceSettings?.transmissionDelayMs ?? 0
  const [draft, setDraft] = useState(String(stored))
  const [problem, setProblem] = useState<string | null>(null)

  // Follow the stored value when it changes underneath us, but never while the
  // operator is mid-edit with something invalid in the box.
  useEffect(() => {
    if (problem === null) setDraft(String(stored))
  }, [stored, problem])

  function commit(): void {
    const parsed = parseDelayInput(draft)
    if (!parsed.ok) {
      setProblem(parsed.error)
      return
    }
    setProblem(null)
    onError(null)
    if (voiceSettings === null || parsed.delayMs === stored) return
    saveVoiceSettings({ ...voiceSettings, transmissionDelayMs: parsed.delayMs }).catch(
      (err: unknown) => onError(err instanceof Error ? err.message : 'Could not save the delay.'),
    )
  }

  return (
    <div style={{ marginTop: '8px' }}>
      <label style={s.label} htmlFor="voice-transmission-delay">
        Announcement delay (ms)
      </label>
      <input
        id="voice-transmission-delay"
        style={s.input}
        value={draft}
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
      <p style={s.hint}>
        How long Mumble takes to reach the band. The whole announcement plays this much earlier, so
        they hear it on the beat. Measure it once and leave it.
      </p>
      {problem !== null && <p style={s.errorText}>{problem}</p>}
    </div>
  )
}

function OutputDevicesSection(): React.JSX.Element {
  const audioDevices = useAppStore((st) => st.audioDevices)
  const saveAudioDevices = useAppStore((st) => st.saveAudioDevices)

  const [devices, setDevices] = useState<OutputDevice[]>([])
  const [error, setError] = useState<string | null>(null)
  const [labelsHidden, setLabelsHidden] = useState(false)

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

  useEffect(() => {
    void refresh()
    // A cable plugged in while the panel is open should appear without reopening it.
    const onDeviceChange = (): void => void refresh()
    const media = navigator.mediaDevices as MediaDevices | undefined
    media?.addEventListener('devicechange', onDeviceChange)
    return () => media?.removeEventListener('devicechange', onDeviceChange)
  }, [refresh])

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

  function save(patch: { cueSinkId?: string | null; announcementSinkId?: string | null }): void {
    saveAudioDevices({ ...audioDevices, ...patch }).catch((err: unknown) =>
      setError(err instanceof Error ? err.message : 'Could not save the device.'),
    )
  }

  return (
    <div>
      <div style={{ ...s.summaryRow, marginBottom: '4px' }}>
        <p style={{ ...s.sectionTitle, margin: 0 }}>Output devices</p>
        <button style={s.smallBtn} onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      <OutputDeviceSelect
        id="voice-cue-sink"
        title="Countdown cues"
        hint="Where the operator hears their own countdown cues."
        devices={devices}
        selectedId={audioDevices.cueSinkId}
        onChange={(sinkId) => save({ cueSinkId: sinkId })}
      />

      <OutputDeviceSelect
        id="voice-announcement-sink"
        title="Announcements"
        hint="Where the band hears the part names - a virtual cable feeding Mumble, typically."
        devices={devices}
        selectedId={audioDevices.announcementSinkId}
        onChange={(sinkId) => save({ announcementSinkId: sinkId })}
      />

      <TransmissionDelayField onError={setError} />

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
  progress: { completed: number; total: number } | undefined,
): string {
  if (progress === undefined || progress.total === 0) return 'Rendering...'
  return `Rendering ${progress.completed}/${progress.total}...`
}

function RenderStateSection({ projectId }: RenderStateSectionProps): React.JSX.Element {
  const renderSummary = useAppStore((st) => st.renderSummary)
  const renderMissing = useAppStore((st) => st.renderMissing)
  const cleanOrphanClips = useAppStore((st) => st.cleanOrphanClips)
  const deleteProjectClips = useAppStore((st) => st.deleteProjectClips)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const parts = renderSummary?.parts ?? []
  const summary = summarizeRenderStates(parts)
  const rendering = renderSummary?.rendering === true

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

  function handleDeleteAll(): void {
    const confirmed = window.confirm(
      "Delete this project's recordings?\n\n" +
        'Recordings shared with another project are kept. Parts are not touched — ' +
        'they will read as missing until you render again.',
    )
    if (!confirmed) return
    runCacheAction(
      () => deleteProjectClips(projectId),
      (removed) =>
        removed === 0
          ? 'Nothing deleted — this project had no recordings of its own.'
          : `Deleted ${removed} recording${removed === 1 ? '' : 's'}.`,
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
          onClick={handleDeleteAll}
          disabled={locked}
          title="Delete this project's recordings — for an archived project that no longer needs them"
        >
          Delete this project's recordings
        </button>
      </div>
      {error !== null && <p style={s.errorText}>{error}</p>}
      {note !== null && <p style={s.noteText}>{note}</p>}

      {parts.length > 0 && (
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Part</th>
              <th style={s.th}>Audio</th>
            </tr>
          </thead>
          <tbody>
            {parts.map((part) => (
              <tr key={part.partId}>
                <td style={s.td}>{part.name}</td>
                <td style={s.td}>
                  <span style={s.stateBadge(part.state)}>{RENDER_STATE_LABEL[part.state]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
                voiceSettings?.autoRender === true ? 'Disable auto-render' : 'Enable auto-render'
              }
            >
              <span style={s.toggleThumb(voiceSettings?.autoRender === true)} />
            </button>
            <span>Render on change</span>
          </div>
          <p style={s.hint}>
            On, edits are synthesised in the background shortly after you make them. Off, nothing is
            synthesised until you ask - which is what a slow machine wants while you are editing.
          </p>
        </div>

        {/* Render status */}
        {activeProjectId !== null && <RenderStateSection projectId={activeProjectId} />}

        {/* Output devices */}
        <OutputDevicesSection />
      </div>
    </div>
  )
}
