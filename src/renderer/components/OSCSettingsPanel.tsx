import React, { useState, useEffect } from 'react'

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
    width: '400px',
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

  closeBtn: {
    background: 'none',
    border: 'none',
    color: '#aaa',
    fontSize: '20px',
    cursor: 'pointer',
    padding: '4px 8px',
  } satisfies React.CSSProperties,

  sectionTitle: {
    margin: '0 0 10px',
    fontSize: '13px',
    fontWeight: 600,
    color: '#888',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
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

  label: {
    fontSize: '12px',
    color: '#888',
    marginBottom: '4px',
    display: 'block',
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

export function OSCSettingsPanel({ onClose }: OSCSettingsPanelProps): React.JSX.Element {
  const [enabled, setEnabled] = useState(false)
  const [port, setPort] = useState(8000)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.api.osc.getSettings().then((settings) => {
      setEnabled(settings.enabled)
      setPort(settings.port)
    }).catch((err: unknown) => console.error('[OSCSettingsPanel] getSettings:', err))
  }, [])

  async function handleSave(): Promise<void> {
    setSaving(true)
    try {
      await window.api.osc.saveSettings({ enabled, port })
    } catch (err) {
      console.error('[OSCSettingsPanel] saveSettings:', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={s.overlay} role="dialog" aria-modal="true">
      <div style={s.panel}>
        <div style={s.header}>
          <h2 style={s.title}>OSC Settings</h2>
          <button style={s.closeBtn} onClick={onClose} aria-label="Close">×</button>
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
            <label style={s.label}>Port</label>
            <input
              style={s.input}
              type="number"
              min={1024}
              max={65535}
              value={port}
              disabled={!enabled}
              onChange={(e) => setPort(parseInt(e.target.value, 10))}
            />
          </div>

          <div style={{ marginTop: '12px' }}>
            {enabled
              ? <span style={s.statusEnabled}>Listening on port {port}</span>
              : <span style={s.statusLine}>Disabled</span>
            }
          </div>
        </div>

        <button
          style={s.saveBtn}
          onClick={() => void handleSave()}
          disabled={saving}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  )
}
