import React, { useState, useEffect } from 'react'
import { useAppStore } from '../store'
import { BUILTIN_TRANSITIONS } from '../../shared/ipc-contract'
import type {
  OBSConnectionStatus,
  OBSValidateResult,
  TransitionMapping,
} from '../../shared/ipc-contract'
import type { Camera } from '../../shared/types'
import { ps } from './panel-styles'
import { useDraftRow } from './use-draft-row'

const s = {
  ...ps,

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

// ---------------------------------------------------------------------------
// Transition Mappings section
// ---------------------------------------------------------------------------

interface TransitionMappingsSectionProps {
  obsConnected: boolean
}

function TransitionMappingsSection({
  obsConnected,
}: TransitionMappingsSectionProps): React.JSX.Element {
  const [mappings, setMappings] = useState<TransitionMapping[]>([])
  const [obsTransitions, setObsTransitions] = useState<string[]>([])
  const [savingMap, setSavingMap] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)

  // New mapping form state
  const [newLogicalName, setNewLogicalName] = useState('')
  const [newObsName, setNewObsName] = useState('')
  const [addingNew, setAddingNew] = useState(false)

  // Refetched when the connection comes up, not only on mount: while OBS is
  // disconnected `getTransitions` answers with an empty list, and a dropdown that
  // never asks again leaves the operator hand-typing transition names.
  useEffect(() => {
    void fetchAll()
  }, [obsConnected])

  async function fetchAll(): Promise<void> {
    try {
      const [maps, transitions] = await Promise.all([
        window.api.obs.listTransitionMappings(),
        window.api.obs.getTransitions(),
      ])
      setMappings(maps)
      setObsTransitions(transitions)
    } catch {
      /* ignore */
    }
  }

  async function handleObsNameChange(logicalName: string, obsName: string): Promise<void> {
    setSavingMap((prev) => ({ ...prev, [logicalName]: true }))
    setError(null)
    try {
      await window.api.obs.upsertTransitionMapping({ logicalName, obsTransitionName: obsName })
      setMappings((prev) =>
        prev.map((m) => (m.logicalName === logicalName ? { ...m, obsTransitionName: obsName } : m)),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.')
    } finally {
      setSavingMap((prev) => ({ ...prev, [logicalName]: false }))
    }
  }

  async function handleDelete(logicalName: string): Promise<void> {
    setSavingMap((prev) => ({ ...prev, [logicalName]: true }))
    setError(null)
    try {
      await window.api.obs.deleteTransitionMapping({ logicalName })
      setMappings((prev) => prev.filter((m) => m.logicalName !== logicalName))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed.')
    } finally {
      setSavingMap((prev) => ({ ...prev, [logicalName]: false }))
    }
  }

  async function handleAddMapping(): Promise<void> {
    if (!newLogicalName.trim() || !newObsName) return
    setError(null)
    try {
      await window.api.obs.upsertTransitionMapping({
        logicalName: newLogicalName.trim(),
        obsTransitionName: newObsName,
      })
      await fetchAll()
      setNewLogicalName('')
      setNewObsName('')
      setAddingNew(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add mapping.')
    }
  }

  return (
    <div>
      <p style={s.sectionTitle}>Transition Mappings</p>
      {error !== null && <p style={s.errorText}>{error}</p>}
      <table style={s.table}>
        <thead>
          <tr>
            <th style={s.th}>Logical name</th>
            <th style={s.th}>OBS transition</th>
            <th style={s.th} />
          </tr>
        </thead>
        <tbody>
          {mappings.map((m) => {
            const isBuiltin = (BUILTIN_TRANSITIONS as readonly string[]).includes(m.logicalName)
            const isSaving = savingMap[m.logicalName] === true
            return (
              <tr key={m.logicalName}>
                <td style={s.td}>
                  <span style={{ color: isBuiltin ? '#888' : '#ddd' }}>{m.logicalName}</span>
                </td>
                <td style={s.td}>
                  {obsConnected && obsTransitions.length > 0 ? (
                    <select
                      style={s.select}
                      value={m.obsTransitionName}
                      aria-label={`OBS transition for ${m.logicalName}`}
                      disabled={isSaving}
                      onChange={(e) => void handleObsNameChange(m.logicalName, e.target.value)}
                    >
                      {obsTransitions.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                      {!obsTransitions.includes(m.obsTransitionName) && (
                        <option value={m.obsTransitionName}>{m.obsTransitionName}</option>
                      )}
                    </select>
                  ) : (
                    <input
                      style={s.input}
                      type="text"
                      value={m.obsTransitionName}
                      aria-label={`OBS transition for ${m.logicalName}`}
                      disabled={isSaving}
                      onChange={(e) => {
                        const val = e.target.value
                        setMappings((prev) =>
                          prev.map((mp) =>
                            mp.logicalName === m.logicalName
                              ? { ...mp, obsTransitionName: val }
                              : mp,
                          ),
                        )
                      }}
                      onBlur={(e) => void handleObsNameChange(m.logicalName, e.target.value)}
                    />
                  )}
                </td>
                <td style={{ ...s.td, width: '40px' }}>
                  {!isBuiltin && (
                    <button
                      style={s.iconBtn}
                      onClick={() => void handleDelete(m.logicalName)}
                      title="Delete mapping"
                      aria-label={`Delete mapping ${m.logicalName}`}
                      disabled={isSaving}
                    >
                      ✕
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
          {addingNew && (
            <tr>
              <td style={s.td}>
                <input
                  autoFocus
                  style={s.input}
                  type="text"
                  placeholder="Logical name"
                  value={newLogicalName}
                  aria-label="New logical name"
                  onChange={(e) => setNewLogicalName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setAddingNew(false)
                  }}
                />
              </td>
              <td style={s.td}>
                {obsConnected && obsTransitions.length > 0 ? (
                  <select
                    style={s.select}
                    value={newObsName}
                    aria-label="New OBS transition"
                    onChange={(e) => setNewObsName(e.target.value)}
                  >
                    <option value="">— Select —</option>
                    {obsTransitions.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    style={s.input}
                    type="text"
                    placeholder="OBS transition name"
                    value={newObsName}
                    aria-label="New OBS transition"
                    onChange={(e) => setNewObsName(e.target.value)}
                  />
                )}
              </td>
              <td style={{ ...s.td, width: '72px', whiteSpace: 'nowrap' }}>
                <button
                  style={{ ...s.iconBtn, color: '#4a90d9' }}
                  onClick={() => void handleAddMapping()}
                  title="Save mapping"
                  aria-label="Save new mapping"
                >
                  ✓
                </button>
                <button
                  style={s.iconBtn}
                  onClick={() => setAddingNew(false)}
                  title="Cancel"
                  aria-label="Cancel new mapping"
                >
                  ✕
                </button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {!addingNew && (
        <button style={{ ...s.addBtn, marginTop: '8px' }} onClick={() => setAddingNew(true)}>
          + Add mapping
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Camera → OBS scene
//
// The scene is a column of the Camera, so it is edited here but owned by the
// same store the Cameras panel edits. A private copy of the list is what made
// renaming a Camera wipe its scene: the main process rewrites every column on an
// upsert, so the Cameras panel sent the scene it had — from a store nothing had
// told about a scene set here.
// ---------------------------------------------------------------------------

interface CameraSceneRowProps {
  camera: Camera
  scenes: string[]
  connected: boolean
}

function CameraSceneRow({ camera, scenes, connected }: CameraSceneRowProps): React.JSX.Element {
  const upsertCamera = useAppStore((st) => st.upsertCamera)
  const row = useDraftRow<{ obsScene: string }>(
    { obsScene: camera.obsScene ?? '' },
    async (draft) => {
      await upsertCamera({ ...camera, obsScene: draft.obsScene === '' ? null : draft.obsScene })
    },
  )

  return (
    <tr>
      <td style={s.td}>
        CAM{camera.number} — {camera.name}
      </td>
      <td style={s.td}>
        {connected && scenes.length > 0 ? (
          <select
            style={s.select}
            value={row.draft.obsScene}
            aria-label={`OBS scene for ${camera.name}`}
            disabled={row.saving}
            onChange={(e) => row.pick({ obsScene: e.target.value })}
          >
            <option value="">— None —</option>
            {scenes.map((scene) => (
              <option key={scene} value={scene}>
                {scene}
              </option>
            ))}
            {row.draft.obsScene !== '' && !scenes.includes(row.draft.obsScene) && (
              <option value={row.draft.obsScene}>{row.draft.obsScene}</option>
            )}
          </select>
        ) : (
          <input
            style={s.input}
            type="text"
            value={row.draft.obsScene}
            placeholder={connected ? 'Scene name' : 'OBS not connected'}
            aria-label={`OBS scene for ${camera.name}`}
            disabled={row.saving}
            onChange={(e) => row.set({ obsScene: e.target.value })}
            onBlur={row.commit}
          />
        )}
        {row.error !== null && <p style={{ ...s.errorText, marginTop: '4px' }}>{row.error}</p>}
      </td>
    </tr>
  )
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
  const cameras = useAppStore((st) => st.cameras)
  const loadCameras = useAppStore((st) => st.loadCameras)
  const [obsScenes, setObsScenes] = useState<string[]>([])

  useEffect(() => {
    window.api.obs
      .getSettings()
      .then((settings) => {
        setUrl(settings.url)
        setPassword(settings.password)
      })
      .catch((err: unknown) => console.error('[OBSSettingsPanel] getSettings:', err))
    window.api.obs
      .getStatus()
      .then((r) => setObsStatus(r.status))
      .catch(() => {})
    window.api.obs
      .getEnabled()
      .then(setObsEnabled)
      .catch(() => {})
    // Returned so the listener goes when the panel does: `subscribe` hands back
    // its own disposer, and dropping it leaks one listener per open.
    return window.api.obs.onValidationResult((result) => setValidationResult(result))
  }, [setObsStatus])

  // Reloaded rather than assumed fresh: the store loads cameras when the active
  // project changes, which can be long before this panel is opened.
  useEffect(() => {
    if (activeProjectId) {
      loadCameras(activeProjectId).catch((err: unknown) =>
        console.error('[OBSSettingsPanel] loadCameras:', err),
      )
    }
  }, [activeProjectId, loadCameras])

  useEffect(() => {
    if (obsStatus === 'connected') {
      window.api.obs
        .getScenes()
        .then(setObsScenes)
        .catch(() => {})
    }
  }, [obsStatus])

  async function handleToggle(enabled: boolean): Promise<void> {
    setError(null)
    setValidationResult(null)
    try {
      // Written before the toggle moves: showing "on" for a setting that was
      // never persisted sends the operator into a show believing OBS is live.
      await window.api.obs.setEnabled(enabled)
      setObsEnabled(enabled)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the OBS setting.')
    }
  }

  async function handleSaveSettings(): Promise<void> {
    setError(null)
    try {
      await window.api.obs.saveSettings({ url, password })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.')
    }
  }

  async function handleConnect(): Promise<void> {
    if (obsStatus === 'connecting') {
      window.api.obs.disconnect().catch((err: unknown) => {
        console.error('[obs] disconnect before reconnect failed:', err)
      })
      setObsStatus('disconnected')
    }
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
    window.api.obs.disconnect().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Disconnect failed.')
    })
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

  return (
    <div style={s.overlay} role="dialog" aria-modal="true">
      <div style={s.panel({ width: '560px', maxHeight: '85vh', gap: '20px' })}>
        <div style={s.header}>
          <h2 style={s.title}>OBS Settings</h2>
          <button style={s.closeBtn} onClick={onClose} aria-label="Close">
            x
          </button>
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
          {obsEnabled && obsStatus !== 'connected' && (
            <div style={{ marginTop: '8px' }}>
              <button style={s.refreshBtn} onClick={() => void handleSaveSettings()}>
                Save settings
              </button>
            </div>
          )}

          <div style={{ ...s.statusRow, marginTop: '12px' }}>
            <div style={s.dot(obsStatus)} />
            <span style={{ color: '#ccc' }}>
              {obsStatus === 'connected'
                ? 'Connected'
                : obsStatus === 'connecting'
                  ? 'Connecting...'
                  : 'Disconnected'}
            </span>
            {obsStatus === 'connected' ? (
              <button style={s.connectBtn(obsStatus)} onClick={handleDisconnect} disabled={loading}>
                Disconnect
              </button>
            ) : (
              <button
                style={s.connectBtn(obsStatus)}
                onClick={() => void handleConnect()}
                disabled={loading || !obsEnabled}
              >
                {loading ? 'Connecting...' : obsStatus === 'connecting' ? 'Reconnect' : 'Connect'}
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
                {validationResult.studioModeEnabled ? (
                  <span style={s.okText}>Studio mode enabled</span>
                ) : (
                  <span style={s.errorText}>Studio mode not enabled</span>
                )}
              </div>
              <div>
                {validationResult.missingScenes.length === 0 ? (
                  <span style={s.okText}>All scenes mapped</span>
                ) : (
                  <span style={s.errorText}>
                    Missing scenes: {validationResult.missingScenes.join(', ')}
                  </span>
                )}
              </div>
              <div>
                {validationResult.missingTransitions.length === 0 ? (
                  <span style={s.okText}>All transitions found</span>
                ) : (
                  <span style={s.errorText}>
                    Missing transitions: {validationResult.missingTransitions.join(', ')}
                  </span>
                )}
              </div>
              <button style={s.refreshBtn} onClick={() => void handleRefreshValidation()}>
                Refresh
              </button>
            </div>
          </div>
        )}

        {/* Section B2: Transition Mappings */}
        <TransitionMappingsSection obsConnected={obsStatus === 'connected'} />

        {/* Section C: Camera → OBS Scene mappings */}
        {activeProjectId !== null && (
          <div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '10px',
              }}
            >
              <p style={{ ...s.sectionTitle, margin: 0 }}>Camera → OBS Scene</p>
              <button
                style={s.refreshBtn}
                onClick={() => void handleRefreshScenes()}
                title="Refresh OBS scenes"
              >
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
                  <CameraSceneRow
                    key={cam.id}
                    camera={cam}
                    scenes={obsScenes}
                    connected={obsStatus === 'connected'}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
