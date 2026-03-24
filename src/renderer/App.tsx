import React, { useEffect, useRef, useState } from 'react'
import { useAppStore } from './store'
import { ProjectSelector } from './components/ProjectSelector'
import { CameraConfigPanel } from './components/CameraConfigPanel'
import { RundownSidebar } from './components/RundownSidebar'
import { ShotListPanel } from './components/ShotListPanel'
import { LiveControls } from './components/LiveControls'
import { ShotlistWidget } from '../shared/components/ShotlistWidget'
import { ResolveImportDialog } from './components/ResolveImportDialog'
import { OBSSettingsPanel } from './components/OBSSettingsPanel'

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
  const obsStatus = useAppStore((s) => s.obsStatus)
  const setObsStatus = useAppStore((s) => s.setObsStatus)

  const [showCameraConfig, setShowCameraConfig] = useState(false)
  const [showResolveImport, setShowResolveImport] = useState(false)
  const [showObsPanel, setShowObsPanel] = useState(false)
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
  }, [loadProjects, loadLiveState, setObsStatus])

  // Keyboard shortcuts
  useEffect(() => {
    function handleKey(e: KeyboardEvent): void {
      const tag = (document.activeElement as HTMLElement)?.tagName
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return
      if (e.code === 'Space') {
        e.preventDefault()
        if (running) liveNext().catch((err: unknown) => console.error('[App] liveNext:', err))
        else if (shots.length > 0 && activeRundownId) liveStart(activeRundownId).catch((err: unknown) => console.error('[App] liveStart:', err))
      }
      if (e.code === 'ArrowRight' && running) {
        e.preventDefault()
        liveSkipNext().catch((err: unknown) => console.error('[App] liveSkipNext:', err))
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [running, shots, activeRundownId, liveNext, liveStart, liveSkipNext])

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

  return (
    <div style={styles.root}>
      <header style={{ ...styles.header, background: headerFlash ? '#888' : '#1a1a1a', transition: 'background 0.35s ease-out' }}>
        <span style={styles.appName}>OBS Queuer</span>
        <ProjectSelector onOpenCameraConfig={() => setShowCameraConfig(true)} />
        <div style={styles.headerActions}>
          {activeRundownId && (
            <button
              style={styles.importBtn}
              onClick={() => setShowResolveImport(true)}
              title="Import from DaVinci Resolve CSV"
            >
              Import from Resolve
            </button>
          )}
          <button
            style={styles.obsBtn}
            onClick={() => setShowObsPanel(true)}
            title="OBS Connection"
          >
            <span style={styles.obsDot(obsStatus)} />
            OBS
          </button>
        </div>
      </header>

      <div style={styles.body}>
        {loadError !== null && (
          <div style={{ padding: '16px', color: '#e74c3c' }}>Error: {loadError}</div>
        )}

        {activeProject === null ? (
          <div style={styles.emptyState}>
            <p>No project selected.</p>
            <p>Create a project to get started.</p>
          </div>
        ) : (
          <>
            <RundownSidebar />

            <div style={styles.center}>
              {activeRundownId !== null && <LiveControls />}
              <ShotListPanel />
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
                />
              </div>
            )}
          </>
        )}
      </div>

      {showCameraConfig && <CameraConfigPanel onClose={() => setShowCameraConfig(false)} />}
      {showResolveImport && <ResolveImportDialog onClose={() => setShowResolveImport(false)} />}
      {showObsPanel && <OBSSettingsPanel onClose={() => setShowObsPanel(false)} />}
    </div>
  )
}
