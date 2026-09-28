import React, { useState, useEffect } from 'react'
import { ps } from './panel-styles'

// ---------------------------------------------------------------------------
// Port validation
//
// The field is a bare `<input type="number">` outside a form, so its `min` and
// `max` are decoration: nothing consults them, and `parseInt` turned an empty
// box into NaN and 99999 into a port no socket can bind. The main process then
// swallowed `ERR_SOCKET_BAD_PORT` and carried on, leaving the panel claiming to
// listen on a port nothing was listening on.
// ---------------------------------------------------------------------------

/** Below 1024 needs privileges this app does not ask for. */
export const OSC_PORT_MIN = 1024
export const OSC_PORT_MAX = 65535

export type PortParse = { ok: true; port: number } | { ok: false; error: string }

/** Reads the port as the operator typed it, rejecting rather than repairing. */
export function parsePortInput(raw: string): PortParse {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false, error: 'Enter a port number.' }

  const port = Number(trimmed)
  if (!Number.isInteger(port)) {
    return { ok: false, error: `"${trimmed}" is not a whole port number.` }
  }
  if (port < OSC_PORT_MIN || port > OSC_PORT_MAX) {
    return { ok: false, error: `Keep it between ${OSC_PORT_MIN} and ${OSC_PORT_MAX}.` }
  }
  return { ok: true, port }
}

const s = {
  ...ps,

  saveBtn: {
    padding: '8px 16px',
    borderRadius: '4px',
    border: 'none',
    fontSize: '14px',
    cursor: 'pointer',
    fontWeight: 600,
    background: '#27ae60',
    color: '#fff',
    alignSelf: 'flex-start' as const,
  } satisfies React.CSSProperties,

  statusLine: {
    fontSize: '13px',
    color: '#888',
  } satisfies React.CSSProperties,

  statusEnabled: {
    fontSize: '13px',
    color: '#27ae60',
  } satisfies React.CSSProperties,
}

interface OSCSettingsPanelProps {
  onClose: () => void
}

/** What the server was last told to do — never what is only typed. */
interface OscSettings {
  enabled: boolean
  port: number
}

export function OSCSettingsPanel({ onClose }: OSCSettingsPanelProps): React.JSX.Element {
  const [enabled, setEnabled] = useState(false)
  const [portDraft, setPortDraft] = useState('8000')
  // The status line reads from this rather than from the fields: "listening on
  // 99999" while the operator types is a claim about a port nothing bound.
  const [saved, setSaved] = useState<OscSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.api.osc
      .getSettings()
      .then((settings) => {
        setEnabled(settings.enabled)
        setPortDraft(String(settings.port))
        setSaved(settings)
      })
      .catch((err: unknown) => console.error('[OSCSettingsPanel] getSettings:', err))
  }, [])

  async function handleSave(): Promise<void> {
    const parsed = parsePortInput(portDraft)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await window.api.osc.saveSettings({ enabled, port: parsed.port })
      setSaved({ enabled, port: parsed.port })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the OSC settings.')
    } finally {
      setSaving(false)
    }
  }

  const pending = saved === null || saved.enabled !== enabled || String(saved.port) !== portDraft

  return (
    <div style={s.overlay} role="dialog" aria-modal="true">
      <div style={s.panel({ width: '400px', maxHeight: '85vh', gap: '20px' })}>
        <div style={s.header}>
          <h2 style={s.title}>OSC Settings</h2>
          <button style={s.closeBtn} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div>
          <p style={s.sectionTitle}>Server</p>

          <div style={s.toggleRow}>
            <button
              style={s.toggleTrack(enabled)}
              onClick={() => setEnabled((v) => !v)}
              aria-label={enabled ? 'Disable OSC server' : 'Enable OSC server'}
            >
              <span style={s.toggleThumb(enabled)} />
            </button>
            <span>Enable OSC server</span>
          </div>

          <div style={{ marginTop: '12px' }}>
            <label style={s.label} htmlFor="osc-port">
              Port
            </label>
            <input
              id="osc-port"
              style={s.input}
              type="number"
              min={OSC_PORT_MIN}
              max={OSC_PORT_MAX}
              value={portDraft}
              disabled={!enabled}
              aria-label="OSC port"
              onChange={(e) => {
                setPortDraft(e.target.value)
                setError(null)
              }}
            />
          </div>

          {error !== null && <p style={{ ...s.errorText, marginTop: '8px' }}>{error}</p>}

          <div style={{ marginTop: '12px' }}>
            {saved?.enabled === true ? (
              <span style={s.statusEnabled}>Listening on port {saved.port}</span>
            ) : (
              <span style={s.statusLine}>Disabled</span>
            )}
            {pending && (
              <span style={{ ...s.statusLine, marginLeft: '8px' }}>— unsaved changes</span>
            )}
          </div>
        </div>

        <button style={s.saveBtn} onClick={() => void handleSave()} disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  )
}
