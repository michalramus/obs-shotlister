import React, { useState, useEffect } from 'react'
import { useAppStore } from '../store'
import type { OBSConnectionStatus } from '../electron-api.d'

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
    width: '420px',
    maxWidth: '95vw',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '16px',
  } satisfies React.CSSProperties,

  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
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

  connectBtn: (status: OBSConnectionStatus): React.CSSProperties => ({
    padding: '8px 16px',
    borderRadius: '4px',
    border: 'none',
    fontSize: '14px',
    cursor: 'pointer',
    fontWeight: 600,
    background: status === 'connected' ? '#c0392b' : '#27ae60',
    color: '#fff',
  }),

  statusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '14px',
  } satisfies React.CSSProperties,

  dot: (status: OBSConnectionStatus): React.CSSProperties => ({
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    flexShrink: 0,
    background: status === 'connected' ? '#27ae60' : status === 'connecting' ? '#f39c12' : '#555',
  }),

  scenesResult: {
    fontSize: '13px',
    padding: '8px',
    borderRadius: '4px',
    background: '#1a1a1a',
  } satisfies React.CSSProperties,

  errorText: {
    color: '#e74c3c',
    fontSize: '13px',
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
}

interface OBSSettingsPanelProps {
  onClose: () => void
}

export function OBSSettingsPanel({ onClose }: OBSSettingsPanelProps): React.JSX.Element {
  const obsStatus = useAppStore((st) => st.obsStatus)
  const setObsStatus = useAppStore((st) => st.setObsStatus)

  const [url, setUrl] = useState('ws://localhost:4455')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scenesResult, setScenesResult] = useState<{ allMapped: boolean; missing: string[] } | null>(null)
  const [obsEnabled, setObsEnabled] = useState(false)

  useEffect(() => {
    window.api.obs.getSettings().then((settings) => {
      setUrl(settings.url)
      setPassword(settings.password)
    }).catch((err: unknown) => console.error('[OBSSettingsPanel] getSettings:', err))
    window.api.obs.getStatus().then((r) => setObsStatus(r.status)).catch(() => {})
    window.api.obs.getEnabled().then(setObsEnabled).catch(() => {})
  }, [setObsStatus])

  async function handleToggle(enabled: boolean): Promise<void> {
    setObsEnabled(enabled)
    setError(null)
    setScenesResult(null)
    await window.api.obs.setEnabled(enabled)
  }

  async function handleConnect(): Promise<void> {
    setLoading(true)
    setError(null)
    setScenesResult(null)
    try {
      await window.api.obs.saveSettings({ url, password })
      await window.api.obs.connect()
      setObsStatus('connected')
      const result = await window.api.obs.checkScenes()
      setScenesResult(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed.')
      setObsStatus('disconnected')
    } finally {
      setLoading(false)
    }
  }

  function handleDisconnect(): void {
    window.api.obs.disconnect()
    setObsStatus('disconnected')
    setScenesResult(null)
  }

  return (
    <div style={s.overlay} role="dialog" aria-modal="true">
      <div style={s.panel}>
        <div style={s.header}>
          <h2 style={s.title}>OBS Connection</h2>
          <button style={s.closeBtn} onClick={onClose} aria-label="Close">x</button>
        </div>

        <div style={s.toggleRow}>
          <button
            style={s.toggleTrack(obsEnabled)}
            onClick={() => void handleToggle(!obsEnabled)}
            aria-label={obsEnabled ? 'Disable OBS' : 'Enable OBS'}
          >
            <span style={s.toggleThumb(obsEnabled)} />
          </button>
          <span>OBS enabled</span>
        </div>

        <div>
          <label style={s.label}>WebSocket URL</label>
          <input
            style={s.input}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="ws://localhost:4455"
            disabled={!obsEnabled || obsStatus === 'connected'}
          />
        </div>
        <div>
          <label style={s.label}>Password</label>
          <input
            style={s.input}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={!obsEnabled || obsStatus === 'connected'}
          />
        </div>

        <div style={s.statusRow}>
          <div style={s.dot(obsStatus)} />
          <span style={{ color: '#ccc' }}>
            {obsStatus === 'connected' ? 'Connected' : obsStatus === 'connecting' ? 'Connecting...' : 'Disconnected'}
          </span>
          {obsStatus === 'connected' ? (
            <button style={s.connectBtn(obsStatus)} onClick={handleDisconnect} disabled={loading}>
              Disconnect
            </button>
          ) : (
            <button
              style={s.connectBtn(obsStatus)}
              onClick={() => void handleConnect()}
              disabled={loading || obsStatus === 'connecting'}
            >
              {loading ? 'Connecting...' : 'Connect'}
            </button>
          )}
        </div>

        {error !== null && <p style={s.errorText}>{error}</p>}

        {scenesResult !== null && (
          <div style={s.scenesResult}>
            {scenesResult.allMapped
              ? <span style={{ color: '#27ae60' }}>All cameras mapped to OBS scenes</span>
              : <span style={{ color: '#e74c3c' }}>Missing scenes: {scenesResult.missing.join(', ')}</span>
            }
          </div>
        )}
      </div>
    </div>
  )
}
