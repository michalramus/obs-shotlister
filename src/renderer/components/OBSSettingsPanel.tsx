import React, { useState, useEffect } from 'react'
import { useAppStore } from '../store'
import type { OBSConnectionStatus, OBSValidateResult } from '../electron-api.d'
import type { Camera } from '../../shared/types'

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
    width: '560px',
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

  validationBox: {
    fontSize: '13px',
    padding: '10px',
    borderRadius: '4px',
    background: '#1a1a1a',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
  } satisfies React.CSSProperties,

  okText: {
    color: '#27ae60',
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

  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: '14px',
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

  refreshBtn: {
    padding: '5px 10px',
    fontSize: '12px',
    borderRadius: '4px',
    border: '1px solid #555',
    background: '#2a2a2a',
    color: '#aaa',
    cursor: 'pointer',
    alignSelf: 'flex-start' as const,
  } satisfies React.CSSProperties,
}

interface OBSSettingsPanelProps {
  onClose: () => void
}

export function OBSSettingsPanel({ onClose }: OBSSettingsPanelProps): React.JSX.Element {
  const obsStatus = useAppStore((st) => st.obsStatus)
  const setObsStatus = useAppStore((st) => st.setObsStatus)
  const activeProjectId = useAppStore((st) => st.activeProjectId)

  const [url, setUrl] = useState('ws://localhost:4455')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [validationResult, setValidationResult] = useState<OBSValidateResult | null>(null)
  const [obsEnabled, setObsEnabled] = useState(false)

  // Section C: Camera → OBS scene mappings
  const [cameras, setCameras] = useState<Camera[]>([])
  const [obsScenes, setObsScenes] = useState<string[]>([])
  const [sceneSaving, setSceneSaving] = useState<Record<string, boolean>>({})

  useEffect(() => {
    window.api.obs.getSettings().then((settings) => {
      setUrl(settings.url)
      setPassword(settings.password)
    }).catch((err: unknown) => console.error('[OBSSettingsPanel] getSettings:', err))
    window.api.obs.getStatus().then((r) => setObsStatus(r.status)).catch(() => {})
    window.api.obs.getEnabled().then(setObsEnabled).catch(() => {})
    // Subscribe to pushed validation results
    window.api.obs.onValidationResult((result) => setValidationResult(result))
  }, [setObsStatus])

  useEffect(() => {
    if (activeProjectId) {
      window.api.cameras.list({ projectId: activeProjectId }).then(setCameras).catch(() => {})
    }
  }, [activeProjectId])

  useEffect(() => {
    if (obsStatus === 'connected') {
      window.api.obs.getScenes().then(setObsScenes).catch(() => {})
    }
  }, [obsStatus])

  async function handleToggle(enabled: boolean): Promise<void> {
    setObsEnabled(enabled)
    setError(null)
    setValidationResult(null)
    await window.api.obs.setEnabled(enabled)
  }

  async function handleConnect(): Promise<void> {
    setLoading(true)
    setError(null)
    setValidationResult(null)
    try {
      await window.api.obs.saveSettings({ url, password })
      await window.api.obs.connect()
      setObsStatus('connected')
      const result = await window.api.obs.validate()
      setValidationResult(result)
      const scenes = await window.api.obs.getScenes()
      setObsScenes(scenes)
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
    setValidationResult(null)
  }

  async function handleRefreshValidation(): Promise<void> {
    try {
      const result = await window.api.obs.validate()
      setValidationResult(result)
    } catch (err) {
      console.error('[OBSSettingsPanel] validate:', err)
    }
  }

  async function handleRefreshScenes(): Promise<void> {
    try {
      const scenes = await window.api.obs.getScenes()
      setObsScenes(scenes)
    } catch {
      /* ignore */
    }
  }

  async function handleSceneChange(camera: Camera, obsScene: string): Promise<void> {
    setSceneSaving((prev) => ({ ...prev, [camera.id]: true }))
    try {
      await window.api.cameras.upsert({
        id: camera.id,
        projectId: camera.projectId,
        number: camera.number,
        name: camera.name,
        color: camera.color,
        resolveColor: camera.resolveColor,
        obsScene: obsScene || null,
      })
      setCameras((prev) =>
        prev.map((c) => (c.id === camera.id ? { ...c, obsScene: obsScene || null } : c)),
      )
    } catch (err) {
      console.error('[OBSSettingsPanel] upsertCamera:', err)
    } finally {
      setSceneSaving((prev) => ({ ...prev, [camera.id]: false }))
    }
  }

  return (
    <div style={s.overlay} role="dialog" aria-modal="true">
      <div style={s.panel}>
        <div style={s.header}>
          <h2 style={s.title}>OBS Settings</h2>
          <button style={s.closeBtn} onClick={onClose} aria-label="Close">x</button>
        </div>

        {/* Section A: Connection */}
        <div>
          <p style={s.sectionTitle}>Connection</p>

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

          <div style={{ marginTop: '12px' }}>
            <label style={s.label}>WebSocket URL</label>
            <input
              style={s.input}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="ws://localhost:4455"
              disabled={!obsEnabled || obsStatus === 'connected'}
            />
          </div>
          <div style={{ marginTop: '8px' }}>
            <label style={s.label}>Password</label>
            <input
              style={s.input}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={!obsEnabled || obsStatus === 'connected'}
            />
          </div>

          <div style={{ ...s.statusRow, marginTop: '12px' }}>
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
                disabled={loading || obsStatus === 'connecting' || !obsEnabled}
              >
                {loading ? 'Connecting...' : 'Connect'}
              </button>
            )}
          </div>

          {error !== null && <p style={{ ...s.errorText, marginTop: '8px' }}>{error}</p>}
        </div>

        {/* Section B: Validation result */}
        {validationResult !== null && (
          <div>
            <p style={s.sectionTitle}>OBS Validation</p>
            <div style={s.validationBox}>
              <div>
                {validationResult.studioModeEnabled
                  ? <span style={s.okText}>Studio mode enabled</span>
                  : <span style={s.errorText}>Studio mode not enabled</span>
                }
              </div>
              <div>
                {validationResult.missingScenes.length === 0
                  ? <span style={s.okText}>All scenes mapped</span>
                  : <span style={s.errorText}>Missing scenes: {validationResult.missingScenes.join(', ')}</span>
                }
              </div>
              <div>
                {validationResult.missingTransitions.length === 0
                  ? <span style={s.okText}>All transitions found</span>
                  : <span style={s.errorText}>Missing transitions: {validationResult.missingTransitions.join(', ')}</span>
                }
              </div>
              <button style={s.refreshBtn} onClick={() => void handleRefreshValidation()}>
                Refresh
              </button>
            </div>
          </div>
        )}

        {/* Section C: Camera → OBS Scene mappings */}
        {activeProjectId !== null && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
              <p style={{ ...s.sectionTitle, margin: 0 }}>Camera → OBS Scene</p>
              <button style={s.refreshBtn} onClick={() => void handleRefreshScenes()} title="Refresh OBS scenes">
                Refresh scenes
              </button>
            </div>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>Camera</th>
                  <th style={s.th}>OBS Scene</th>
                </tr>
              </thead>
              <tbody>
                {cameras.map((cam) => (
                  <tr key={cam.id}>
                    <td style={s.td}>CAM{cam.number} — {cam.name}</td>
                    <td style={s.td}>
                      {obsStatus === 'connected' && obsScenes.length > 0 ? (
                        <select
                          style={s.select}
                          value={cam.obsScene ?? ''}
                          aria-label={`OBS scene for ${cam.name}`}
                          disabled={sceneSaving[cam.id] === true}
                          onChange={(e) => void handleSceneChange(cam, e.target.value)}
                        >
                          <option value="">— None —</option>
                          {obsScenes.map((scene) => (
                            <option key={scene} value={scene}>{scene}</option>
                          ))}
                          {cam.obsScene && !obsScenes.includes(cam.obsScene) && (
                            <option value={cam.obsScene}>{cam.obsScene}</option>
                          )}
                        </select>
                      ) : (
                        <input
                          style={s.input}
                          type="text"
                          value={cam.obsScene ?? ''}
                          placeholder={obsStatus === 'connected' ? 'Scene name' : 'OBS not connected'}
                          aria-label={`OBS scene for ${cam.name}`}
                          onChange={(e) => {
                            const val = e.target.value
                            setCameras((prev) =>
                              prev.map((c) => (c.id === cam.id ? { ...c, obsScene: val || null } : c)),
                            )
                          }}
                          onBlur={(e) => void handleSceneChange(cam, e.target.value)}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
