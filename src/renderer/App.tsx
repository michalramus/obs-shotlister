import React, { useEffect, useRef, useState } from 'react'
import { useAppStore } from './store'
import { ProjectSelector } from './components/ProjectSelector'
import { CameraConfigPanel } from './components/CameraConfigPanel'
import { RundownSidebar } from './components/RundownSidebar'
import { ShotListPanel } from './components/ShotListPanel'
import { LiveControls } from './components/LiveControls'
import { ShotlistWidget } from '../shared/components/ShotlistWidget'
import { isInTransition } from '../shared/timing'
import { ResolveImportDialog } from './components/ResolveImportDialog'
import { OBSSettingsPanel } from './components/OBSSettingsPanel'
import { OSCSettingsPanel } from './components/OSCSettingsPanel'
import { TimelineEditor } from './components/TimelineEditor'

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100vh',
    background: '#121212',
    color: '#fff',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  } satisfies React.CSSProperties,

  header: {
    display: 'flex',
    alignItems: 'center',
    padding: '10px 16px',
    background: '#1a1a1a',
    borderBottom: '1px solid #333',
    gap: '12px',
    flexShrink: 0,
  } satisfies React.CSSProperties,

  appName: {
    fontSize: '15px',
    fontWeight: 700,
    color: '#fff',
    marginRight: '12px',
    whiteSpace: 'nowrap' as const,
  } satisfies React.CSSProperties,

  headerActions: {
    marginLeft: 'auto',
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
  } satisfies React.CSSProperties,

  importBtn: {
    padding: '5px 12px',
    background: 'none',
    border: '1px solid #444',
    borderRadius: '4px',
    color: '#888',
    fontSize: '12px',
    cursor: 'pointer',
  } satisfies React.CSSProperties,

  obsBtn: {
    padding: '5px 12px',
    background: 'none',
    border: '1px solid #444',
    borderRadius: '4px',
    color: '#888',
    fontSize: '12px',
    cursor: 'pointer',
  } satisfies React.CSSProperties,

  dropdownWrapper: {
    position: 'relative' as const,
  } satisfies React.CSSProperties,

  dropdownMenu: {
    position: 'absolute' as const,
    right: 0,
    top: '100%',
    marginTop: '4px',
    background: '#2a2a2a',
    border: '1px solid #444',
    borderRadius: '4px',
    zIndex: 100,
    minWidth: '160px',
    overflow: 'hidden',
  } satisfies React.CSSProperties,

  dropdownItem: {
    display: 'block',
    width: '100%',
    padding: '7px 14px',
    background: 'none',
    border: 'none',
    color: '#ccc',
    fontSize: '12px',
    cursor: 'pointer',
    textAlign: 'left' as const,
    whiteSpace: 'nowrap' as const,
  } satisfies React.CSSProperties,

  obsDot: (status: string): React.CSSProperties => ({
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    display: 'inline-block',
    background: status === 'connected' ? '#27ae60' : status === 'connecting' ? '#f39c12' : '#555',
    marginRight: '4px',
  }),

  body: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
  } satisfies React.CSSProperties,

  center: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
  } satisfies React.CSSProperties,

  right: {
    width: '340px',
    flexShrink: 0,
    borderLeft: '1px solid #2a2a2a',
    overflowY: 'auto' as const,
    padding: '12px',
  } satisfies React.CSSProperties,

  emptyState: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    gap: '12px',
    color: '#555',
  } satisfies React.CSSProperties,

  warningBanner: {
    background: '#e67e22',
    color: '#fff',
    fontSize: '12px',
    padding: '6px 16px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    cursor: 'pointer',
    flexShrink: 0,
  } satisfies React.CSSProperties,
}

export default function App(): React.JSX.Element {
  const loadProjects = useAppStore((s) => s.loadProjects)
  const loadCameras = useAppStore((s) => s.loadCameras)
  const loadRundowns = useAppStore((s) => s.loadRundowns)
  const loadLiveState = useAppStore((s) => s.loadLiveState)
  const activeProjectId = useAppStore((s) => s.activeProjectId)
  const activeRundownId = useAppStore((s) => s.activeRundownId)
  const projects = useAppStore((s) => s.projects)
  const shots = useAppStore((s) => s.shots)
  const cameras = useAppStore((s) => s.cameras)
  const rundowns = useAppStore((s) => s.rundowns)
  const liveIndex = useAppStore((s) => s.liveIndex)
  const startedAt = useAppStore((s) => s.startedAt)
  const running = useAppStore((s) => s.running)
  const liveNext = useAppStore((s) => s.liveNext)
  const liveStart = useAppStore((s) => s.liveStart)
  const liveSkipNext = useAppStore((s) => s.liveSkipNext)
  const editShot = useAppStore((s) => s.editShot)
  const splitShot = useAppStore((s) => s.splitShot)
  const removeShot = useAppStore((s) => s.removeShot)
  const obsStatus = useAppStore((s) => s.obsStatus)
  const setObsStatus = useAppStore((s) => s.setObsStatus)
  const obsValidationResult = useAppStore((s) => s.obsValidationResult)
  const setObsValidationResult = useAppStore((s) => s.setObsValidationResult)
  const uiMode = useAppStore((s) => s.uiMode)
  const markers = useAppStore((s) => s.markers)
  const addMarker = useAppStore((s) => s.addMarker)
  const updateMarker = useAppStore((s) => s.updateMarker)
  const removeMarker = useAppStore((s) => s.removeMarker)
  const rundownMedia = useAppStore((s) => s.rundownMedia)
  const saveRundownMedia = useAppStore((s) => s.saveRundownMedia)
  const clearRundownMedia = useAppStore((s) => s.clearRundownMedia)

  const [selectedShotId, setSelectedShotId] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [muteCount, setMuteCount] = useState(() => localStorage.getItem('obs-queuer-mute-count') === 'true')
  const [muteBeep, setMuteBeep] = useState(() => localStorage.getItem('obs-queuer-mute-beep') === 'true')
  const [audioBaseUrl, setAudioBaseUrl] = useState<string | undefined>()

  const [showCameraConfig, setShowCameraConfig] = useState(false)
  const [showResolveImport, setShowResolveImport] = useState(false)
  const [showObsPanel, setShowObsPanel] = useState(false)
  const [showOscPanel, setShowOscPanel] = useState(false)
  const [showExportMenu, setShowExportMenu] = useState(false)
  const [showImportMenu, setShowImportMenu] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [headerFlash, setHeaderFlash] = useState(false)
  const isFirstLiveIndexRef = useRef(true)

  useEffect(() => {
    if (isFirstLiveIndexRef.current) {
      isFirstLiveIndexRef.current = false
      return
    }
    if (liveIndex === null) return
    setHeaderFlash(true)
    const t = setTimeout(() => setHeaderFlash(false), 350)
    return () => clearTimeout(t)
  }, [liveIndex])

  // Load projects + live state on mount
  useEffect(() => {
    Promise.all([loadProjects(), loadLiveState()]).catch((err: unknown) => {
      setLoadError(err instanceof Error ? err.message : 'Failed to load.')
    })
    window.api.obs.getStatus().then((r) => setObsStatus(r.status)).catch(() => {})
    window.api.obs.onStatusChange(setObsStatus)
    window.api.obs.onValidationResult(setObsValidationResult)
    window.api.assets.getAudioDir().then((dir) => {
      setAudioBaseUrl(`media://localhost${dir}`)
    }).catch((err: unknown) => console.error('[App] getAudioDir:', err))
  }, [loadProjects, loadLiveState, setObsStatus, setObsValidationResult])

  // Keyboard shortcuts
  useEffect(() => {
    function handleKey(e: KeyboardEvent): void {
      const tag = (document.activeElement as HTMLElement)?.tagName
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return
      if (e.code === 'Space') {
        e.preventDefault()
        if (running) {
          if (!isInTransition(running, liveIndex, startedAt, shots, Date.now())) {
            liveNext().catch((err: unknown) => console.error('[App] liveNext:', err))
          }
        } else if (uiMode === 'live' && shots.length > 0 && activeRundownId) {
          liveStart(activeRundownId).catch((err: unknown) => console.error('[App] liveStart:', err))
        }
        // If uiMode === 'edit', do nothing — TimelineEditor handles Space
      }
      if (e.code === 'ArrowRight' && running) {
        e.preventDefault()
        if (!isInTransition(running, liveIndex, startedAt, shots, Date.now())) {
          liveSkipNext().catch((err: unknown) => console.error('[App] liveSkipNext:', err))
        }
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [running, shots, activeRundownId, liveNext, liveStart, liveSkipNext, uiMode, liveIndex, startedAt])

  // When the active project changes, load its cameras + rundowns
  useEffect(() => {
    if (activeProjectId !== null) {
      loadCameras(activeProjectId).catch((err: unknown) => {
        console.error('[App] Failed to load cameras:', err)
      })
      loadRundowns(activeProjectId).catch((err: unknown) => {
        console.error('[App] Failed to load rundowns:', err)
      })
    }
  }, [activeProjectId, loadCameras, loadRundowns])

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null
  const activeRundown = rundowns.find((r) => r.id === activeRundownId) ?? null

  const VIDEO_EXTS = ['.mp4', '.mov', '.webm', '.avi', '.mkv']
  function isVideoFile(path: string): boolean {
    return VIDEO_EXTS.some((ext) => path.toLowerCase().endsWith(ext))
  }

  async function handleImportMedia(): Promise<void> {
    const result = await window.api.rundownMedia.openDialog()
    if (!result.canceled && result.filePaths.length > 0 && activeRundownId) {
      await saveRundownMedia(activeRundownId, result.filePaths[0], 0)
    }
  }

  const hasVideo = uiMode === 'edit' && rundownMedia !== null && isVideoFile(rundownMedia.filePath)

  async function handleExportProject(): Promise<void> {
    if (!activeProjectId) return
    setShowExportMenu(false)
    await window.api.exportImport.exportProject({ projectId: activeProjectId })
  }

  async function handleExportRundown(): Promise<void> {
    if (!activeRundownId) return
    setShowExportMenu(false)
    await window.api.exportImport.exportRundown({ rundownId: activeRundownId })
  }

  async function handleExportDatabase(): Promise<void> {
    setShowExportMenu(false)
    await window.api.exportImport.exportDatabase()
  }

  async function handleImportProject(): Promise<void> {
    setShowImportMenu(false)
    await window.api.exportImport.importProject()
    await loadProjects()
  }

  async function handleImportRundown(): Promise<void> {
    if (!activeProjectId) return
    setShowImportMenu(false)
    const newRundownId = await window.api.exportImport.importRundown({ projectId: activeProjectId })
    if (newRundownId) {
      await loadProjects()
    }
  }

  async function handleImportDatabase(): Promise<void> {
    const confirmed = window.confirm('This will replace ALL data. Are you sure?')
    if (!confirmed) return
    setShowImportMenu(false)
    const ok = await window.api.exportImport.importDatabase()
    if (ok) {
      await loadProjects()
    }
  }

  return (
    <div style={styles.root}>
      <header style={{ ...styles.header, background: headerFlash ? '#888' : '#1a1a1a', transition: 'background 0.35s ease-out' }}>
        <span style={styles.appName}>OBS Queuer</span>
        <ProjectSelector onOpenCameraConfig={() => setShowCameraConfig(true)} />
        <div style={styles.headerActions}>
          <button
            onClick={() => { const v = !muteCount; setMuteCount(v); localStorage.setItem('obs-queuer-mute-count', String(v)) }}
            style={{ ...styles.importBtn, color: muteCount ? '#555' : '#888' }}
            title={muteCount ? 'Unmute countdown' : 'Mute countdown'}
          >
            {muteCount ? '🔇 Count' : '🔊 Count'}
          </button>
          <button
            onClick={() => { const v = !muteBeep; setMuteBeep(v); localStorage.setItem('obs-queuer-mute-beep', String(v)) }}
            style={{ ...styles.importBtn, color: muteBeep ? '#555' : '#888' }}
            title={muteBeep ? 'Unmute beep' : 'Mute beep'}
          >
            {muteBeep ? '🔇 Beep' : '🔊 Beep'}
          </button>
          {activeRundownId && (
            <button
              style={styles.importBtn}
              onClick={() => setShowResolveImport(true)}
              title="Import from DaVinci Resolve CSV"
            >
              Import from Resolve
            </button>
          )}

          {/* Export dropdown */}
          <div style={styles.dropdownWrapper}>
            <button
              style={styles.obsBtn}
              onClick={() => { setShowExportMenu((v) => !v); setShowImportMenu(false) }}
            >
              Export
            </button>
            {showExportMenu && (
              <>
                <div
                  style={{ position: 'fixed', inset: 0, zIndex: 99 }}
                  onClick={() => setShowExportMenu(false)}
                />
                <div style={styles.dropdownMenu}>
                  {activeRundownId !== null && (
                    <button
                      style={styles.dropdownItem}
                      onClick={() => { handleExportRundown().catch((err: unknown) => console.error('[App] exportRundown:', err)) }}
                    >
                      Export rundown
                    </button>
                  )}
                  {activeProjectId !== null && (
                    <button
                      style={styles.dropdownItem}
                      onClick={() => { handleExportProject().catch((err: unknown) => console.error('[App] exportProject:', err)) }}
                    >
                      Export project
                    </button>
                  )}
                  <button
                    style={styles.dropdownItem}
                    onClick={() => { handleExportDatabase().catch((err: unknown) => console.error('[App] exportDatabase:', err)) }}
                  >
                    Export DB
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Import dropdown */}
          <div style={styles.dropdownWrapper}>
            <button
              style={styles.obsBtn}
              onClick={() => { setShowImportMenu((v) => !v); setShowExportMenu(false) }}
            >
              Import
            </button>
            {showImportMenu && (
              <>
                <div
                  style={{ position: 'fixed', inset: 0, zIndex: 99 }}
                  onClick={() => setShowImportMenu(false)}
                />
                <div style={styles.dropdownMenu}>
                  <button
                    style={styles.dropdownItem}
                    onClick={() => { handleImportProject().catch((err: unknown) => console.error('[App] importProject:', err)) }}
                  >
                    Import project
                  </button>
                  {activeProjectId !== null && (
                    <button
                      style={styles.dropdownItem}
                      onClick={() => { handleImportRundown().catch((err: unknown) => console.error('[App] importRundown:', err)) }}
                    >
                      Import rundown
                    </button>
                  )}
                  <button
                    style={styles.dropdownItem}
                    onClick={() => { handleImportDatabase().catch((err: unknown) => console.error('[App] importDatabase:', err)) }}
                  >
                    Import DB
                  </button>
                </div>
              </>
            )}
          </div>

          <button
            style={styles.obsBtn}
            onClick={() => setShowObsPanel(true)}
            title="OBS Connection"
          >
            <span style={styles.obsDot(obsStatus)} />
            OBS
          </button>
          <button
            style={styles.obsBtn}
            onClick={() => setShowOscPanel(true)}
            title="OSC Server"
          >
            OSC
          </button>
        </div>
      </header>

      {obsStatus === 'connected' && obsValidationResult !== null && (
        !obsValidationResult.studioModeEnabled ||
        obsValidationResult.missingScenes.length > 0 ||
        obsValidationResult.missingTransitions.length > 0
      ) && (
        <div
          style={styles.warningBanner}
          onClick={() => setShowObsPanel(true)}
          role="button"
          aria-label="OBS misconfigured — click to open settings"
        >
          <span>OBS:</span>
          {!obsValidationResult.studioModeEnabled && <span>studio mode off</span>}
          {obsValidationResult.missingScenes.length > 0 && (
            <span>missing scenes: {obsValidationResult.missingScenes.join(', ')}</span>
          )}
          {obsValidationResult.missingTransitions.length > 0 && (
            <span>missing transitions: {obsValidationResult.missingTransitions.join(', ')}</span>
          )}
        </div>
      )}

      <div style={styles.body}>
        {loadError !== null && (
          <div style={{ padding: '16px', color: '#e74c3c' }}>Error: {loadError}</div>
        )}

        {activeProject === null ? (
          <div style={styles.emptyState}>
            <p>No project selected.</p>
            <p>Create a project to get started.</p>
          </div>
        ) : uiMode === 'edit' ? (
          <>
            <RundownSidebar />

            {hasVideo ? (
              <>
                <div style={styles.center}>
                  {activeRundownId !== null && <LiveControls />}
                  <div style={{ flex: 1, overflow: 'hidden', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <video
                      ref={videoRef}
                      src={`media://localhost${rundownMedia!.filePath}`}
                      style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
                    />
                  </div>
                  <TimelineEditor
                    shots={shots}
                    cameras={cameras}
                    liveIndex={liveIndex}
                    running={running}
                    startedAt={startedAt}
                    markers={markers}
                    onShotClick={(id) => setSelectedShotId(id)}
                    onSplitShot={(shotId, atMs, newCameraId) => {
                      if (atMs <= 0) {
                        editShot({ id: shotId, cameraId: newCameraId }).catch((err: unknown) => console.error('[App] editShot:', err))
                      } else {
                        splitShot(shotId, atMs, newCameraId).catch((err: unknown) => console.error('[App] splitShot:', err))
                      }
                    }}
                    onResizeShots={(idA, durA, idB, durB) => {
                      Promise.all([
                        editShot({ id: idA, durationMs: Math.round(durA) }),
                        editShot({ id: idB, durationMs: Math.round(durB) }),
                      ]).catch((err: unknown) => console.error('[App] resizeShots:', err))
                    }}
                    onExtendLastShot={(id, dur) => {
                      editShot({ id, durationMs: Math.round(dur) }).catch((err: unknown) => console.error('[App] extendLastShot:', err))
                    }}
                    onDeleteShot={(id) => {
                      removeShot(id).catch((err: unknown) => console.error('[App] deleteShot:', err))
                    }}
                    onChangeShotCamera={(id, camId) => {
                      editShot({ id, cameraId: camId }).catch((err: unknown) => console.error('[App] changeShotCamera:', err))
                    }}
                    mediaVideoRef={videoRef}
                    rundownMedia={rundownMedia}
                    onAddMarker={(posMs) => {
                      if (activeRundownId) addMarker(activeRundownId, posMs).catch((err: unknown) => console.error('[App] addMarker:', err))
                    }}
                    onUpdateMarker={(id, posMs) => updateMarker(id, posMs).catch((err: unknown) => console.error('[App] updateMarker:', err))}
                    onDeleteMarker={(id) => removeMarker(id).catch((err: unknown) => console.error('[App] deleteMarker:', err))}
                    onImportMedia={() => { handleImportMedia().catch((err: unknown) => console.error('[App] importMedia:', err)) }}
                    onUpdateMediaOffset={(offsetMs) => {
                      if (rundownMedia && activeRundownId) {
                        saveRundownMedia(activeRundownId, rundownMedia.filePath, offsetMs).catch((err: unknown) => console.error('[App] updateMediaOffset:', err))
                      }
                    }}
                    onClearMedia={() => {
                      if (activeRundownId) clearRundownMedia(activeRundownId).catch((err: unknown) => console.error('[App] clearMedia:', err))
                    }}
                  />
                </div>

                {activeRundown !== null && (
                  <div style={styles.right}>
                    <ShotListPanel selectedShotId={selectedShotId} />
                  </div>
                )}
              </>
            ) : (
              <>
                <div style={styles.center}>
                  {activeRundownId !== null && <LiveControls />}
                  <ShotListPanel selectedShotId={selectedShotId} />
                  <TimelineEditor
                    shots={shots}
                    cameras={cameras}
                    liveIndex={liveIndex}
                    running={running}
                    startedAt={startedAt}
                    markers={markers}
                    onShotClick={(id) => setSelectedShotId(id)}
                    onSplitShot={(shotId, atMs, newCameraId) => {
                      if (atMs <= 0) {
                        editShot({ id: shotId, cameraId: newCameraId }).catch((err: unknown) => console.error('[App] editShot:', err))
                      } else {
                        splitShot(shotId, atMs, newCameraId).catch((err: unknown) => console.error('[App] splitShot:', err))
                      }
                    }}
                    onResizeShots={(idA, durA, idB, durB) => {
                      Promise.all([
                        editShot({ id: idA, durationMs: Math.round(durA) }),
                        editShot({ id: idB, durationMs: Math.round(durB) }),
                      ]).catch((err: unknown) => console.error('[App] resizeShots:', err))
                    }}
                    onExtendLastShot={(id, dur) => {
                      editShot({ id, durationMs: Math.round(dur) }).catch((err: unknown) => console.error('[App] extendLastShot:', err))
                    }}
                    onDeleteShot={(id) => {
                      removeShot(id).catch((err: unknown) => console.error('[App] deleteShot:', err))
                    }}
                    onChangeShotCamera={(id, camId) => {
                      editShot({ id, cameraId: camId }).catch((err: unknown) => console.error('[App] changeShotCamera:', err))
                    }}
                    mediaVideoRef={videoRef}
                    rundownMedia={rundownMedia}
                    onAddMarker={(posMs) => {
                      if (activeRundownId) addMarker(activeRundownId, posMs).catch((err: unknown) => console.error('[App] addMarker:', err))
                    }}
                    onUpdateMarker={(id, posMs) => updateMarker(id, posMs).catch((err: unknown) => console.error('[App] updateMarker:', err))}
                    onDeleteMarker={(id) => removeMarker(id).catch((err: unknown) => console.error('[App] deleteMarker:', err))}
                    onImportMedia={() => { handleImportMedia().catch((err: unknown) => console.error('[App] importMedia:', err)) }}
                    onUpdateMediaOffset={(offsetMs) => {
                      if (rundownMedia && activeRundownId) {
                        saveRundownMedia(activeRundownId, rundownMedia.filePath, offsetMs).catch((err: unknown) => console.error('[App] updateMediaOffset:', err))
                      }
                    }}
                    onClearMedia={() => {
                      if (activeRundownId) clearRundownMedia(activeRundownId).catch((err: unknown) => console.error('[App] clearMedia:', err))
                    }}
                  />
                </div>

                {activeRundown !== null && (
                  <div style={styles.right}>
                    <ShotlistWidget
                      rundownName={activeRundown.name}
                      shots={shots}
                      cameras={cameras}
                      liveIndex={liveIndex}
                      startedAt={startedAt}
                      running={running}
                      showNextBackground
                      autoScroll

                      audioBaseUrl={audioBaseUrl}
                      muteCount={muteCount}
                      muteBeep={muteBeep}
                    />
                  </div>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <RundownSidebar />

            <div style={styles.center}>
              {activeRundownId !== null && <LiveControls />}
              <div style={{ flex: 1, overflow: 'hidden' }}>
                {activeRundown !== null && (
                  <ShotlistWidget
                    rundownName={activeRundown.name}
                    shots={shots}
                    cameras={cameras}
                    liveIndex={liveIndex}
                    startedAt={startedAt}
                    running={running}
                    showNextBackground
                    autoScroll
                    audioBaseUrl={audioBaseUrl}
                    muteCount={muteCount}
                    muteBeep={muteBeep}
                  />
                )}
              </div>
              <TimelineEditor
                shots={shots}
                cameras={cameras}
                liveIndex={liveIndex}
                running={running}
                startedAt={startedAt}
                markers={markers}
                onShotClick={(id) => setSelectedShotId(id)}
                onSplitShot={(shotId, atMs, newCameraId) => {
                  if (atMs <= 0) {
                    editShot({ id: shotId, cameraId: newCameraId }).catch((err: unknown) => console.error('[App] editShot:', err))
                  } else {
                    splitShot(shotId, atMs, newCameraId).catch((err: unknown) => console.error('[App] splitShot:', err))
                  }
                }}
                onResizeShots={(idA, durA, idB, durB) => {
                  Promise.all([
                    editShot({ id: idA, durationMs: Math.round(durA) }),
                    editShot({ id: idB, durationMs: Math.round(durB) }),
                  ]).catch((err: unknown) => console.error('[App] resizeShots:', err))
                }}
                onExtendLastShot={(id, dur) => {
                  editShot({ id, durationMs: Math.round(dur) }).catch((err: unknown) => console.error('[App] extendLastShot:', err))
                }}
                onDeleteShot={(id) => {
                  removeShot(id).catch((err: unknown) => console.error('[App] deleteShot:', err))
                }}
                onChangeShotCamera={(id, camId) => {
                  editShot({ id, cameraId: camId }).catch((err: unknown) => console.error('[App] changeShotCamera:', err))
                }}
                mediaVideoRef={videoRef}
                rundownMedia={null}
                onAddMarker={(posMs) => {
                  if (activeRundownId) addMarker(activeRundownId, posMs).catch((err: unknown) => console.error('[App] addMarker:', err))
                }}
                onUpdateMarker={(id, posMs) => updateMarker(id, posMs).catch((err: unknown) => console.error('[App] updateMarker:', err))}
                onDeleteMarker={(id) => removeMarker(id).catch((err: unknown) => console.error('[App] deleteMarker:', err))}
                onImportMedia={() => {}}
                onUpdateMediaOffset={() => {}}
                onClearMedia={() => {}}
              />
            </div>
          </>
        )}
      </div>

      {showCameraConfig && <CameraConfigPanel onClose={() => setShowCameraConfig(false)} />}
      {showResolveImport && <ResolveImportDialog onClose={() => setShowResolveImport(false)} />}
      {showObsPanel && <OBSSettingsPanel onClose={() => setShowObsPanel(false)} />}
      {showOscPanel && <OSCSettingsPanel onClose={() => setShowOscPanel(false)} />}
    </div>
  )
}
