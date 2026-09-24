import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from './store'
import { CameraConfigPanel } from './components/CameraConfigPanel'
import { PartsConfigPanel } from './components/PartsConfigPanel'
import { RundownSidebar } from './components/RundownSidebar'
import { ShotListPanel } from './components/ShotListPanel'
import { LiveControls } from './components/LiveControls'
import { ShotlistWidget } from '../shared/components/ShotlistWidget'
import { isInTransition } from '../shared/timing'
import { toMediaUrl } from '../shared/media-url'
import type { DeleteShotMode } from '../shared/ipc-contract'
import { ResolveImportDialog } from './components/ResolveImportDialog'
import { OBSSettingsPanel } from './components/OBSSettingsPanel'
import { VoiceSettingsPanel } from './components/VoiceSettingsPanel'
import { OSCSettingsPanel } from './components/OSCSettingsPanel'
import { TimelineEditor } from './components/TimelineEditor'
import { TopBar } from './components/TopBar'
import { createAnnouncementPlayer } from './audio/announcements'

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100vh',
    background: '#121212',
    color: '#fff',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  } satisfies React.CSSProperties,

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

  configStrip: {
    display: 'flex',
    justifyContent: 'flex-end',
    padding: '2px 8px',
    flexShrink: 0,
  } satisfies React.CSSProperties,

  configStripBtn: {
    background: 'none',
    border: 'none',
    color: '#666',
    fontSize: '11px',
    cursor: 'pointer',
    padding: '2px 4px',
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
  const loadParts = useAppStore((s) => s.loadParts)
  const loadRenderSummary = useAppStore((s) => s.loadRenderSummary)
  const loadPhraseDurations = useAppStore((s) => s.loadPhraseDurations)
  const loadAudioDevices = useAppStore((s) => s.loadAudioDevices)
  const setRenderSummary = useAppStore((s) => s.setRenderSummary)
  const parts = useAppStore((s) => s.parts)
  const phraseDurations = useAppStore((s) => s.phraseDurations)
  const unrenderedCount = useAppStore((s) => s.renderSummary?.unrenderedCount ?? 0)
  const announcementSinkId = useAppStore((s) => s.audioDevices.announcementSinkId)
  const cueSinkId = useAppStore((s) => s.audioDevices.cueSinkId)
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

  const handleLiveStatePush = useAppStore((s) => s.handleLiveStatePush)
  const markShotHidden = useAppStore((s) => s.markShotHidden)

  const [selectedShotId, setSelectedShotId] = useState<string | null>(null)
  const [labelEditingId, setLabelEditingId] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [muteCount, setMuteCount] = useState(
    () => localStorage.getItem('obs-queuer-mute-count') === 'true',
  )
  const [muteBeep, setMuteBeep] = useState(
    () => localStorage.getItem('obs-queuer-mute-beep') === 'true',
  )
  const [audioVolume, setAudioVolume] = useState<number>(() =>
    parseFloat(localStorage.getItem('obs-queuer-audio-volume') ?? '1'),
  )
  const [audioBaseUrl, setAudioBaseUrl] = useState<string | undefined>()

  const [showCameraConfig, setShowCameraConfig] = useState(false)
  const [showPartsConfig, setShowPartsConfig] = useState(false)
  const [showResolveImport, setShowResolveImport] = useState(false)
  const [showObsPanel, setShowObsPanel] = useState(false)
  const [showVoicePanel, setShowVoicePanel] = useState(false)
  const [showOscPanel, setShowOscPanel] = useState(false)
  const [oscSettings, setOscSettings] = useState({ enabled: false, port: 8000 })
  const [loadError, setLoadError] = useState<string | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [headerFlash, setHeaderFlash] = useState(false)
  const isFirstLiveIndexRef = useRef(true)
  // One player for the app's lifetime: a new plan cuts off the one in flight,
  // which only works if both went through the same instance.
  const announcementSinkRef = useRef(announcementSinkId)
  announcementSinkRef.current = announcementSinkId
  const announcementPlayer = useRef(createAnnouncementPlayer(() => announcementSinkRef.current))

  const refreshOscSettings = useCallback(() => {
    window.api.osc
      .getSettings()
      .then(setOscSettings)
      .catch((err: unknown) => console.error('[App] getOscSettings:', err))
  }, [])

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
    window.api.obs
      .getStatus()
      .then((r) => setObsStatus(r.status))
      .catch(() => {})
    // Each returns an unsubscribe function; without them a hot reload or remount
    // would stack duplicate listeners on the same channel.
    const unsubscribes = [
      window.api.obs.onStatusChange(({ status }) => setObsStatus(status)),
      window.api.obs.onValidationResult(setObsValidationResult),
      window.api.live.onStatePush(handleLiveStatePush),
      window.api.live.onShotHiddenPush(markShotHidden),
      window.api.live.onAnnouncementPush((plan) => announcementPlayer.current.play(plan)),
      window.api.speech.onStatusPush(setRenderSummary),
      window.api.server.onError(setServerError),
    ]
    refreshOscSettings()
    window.api.assets
      .getAudioDir()
      .then((dir) => {
        setAudioBaseUrl(toMediaUrl(dir))
      })
      .catch((err: unknown) => console.error('[App] getAudioDir:', err))
    const player = announcementPlayer.current
    return () => {
      for (const off of unsubscribes) off()
      player.dispose()
    }
  }, [
    loadProjects,
    loadLiveState,
    setObsStatus,
    setObsValidationResult,
    handleLiveStatePush,
    markShotHidden,
    refreshOscSettings,
  ])

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
  }, [
    running,
    shots,
    activeRundownId,
    liveNext,
    liveStart,
    liveSkipNext,
    uiMode,
    liveIndex,
    startedAt,
  ])

  // When the active project changes, load its cameras + rundowns
  useEffect(() => {
    if (activeProjectId !== null) {
      loadCameras(activeProjectId).catch((err: unknown) => {
        console.error('[App] Failed to load cameras:', err)
      })
      loadRundowns(activeProjectId).catch((err: unknown) => {
        console.error('[App] Failed to load rundowns:', err)
      })
      loadParts(activeProjectId).catch((err: unknown) => {
        console.error('[App] Failed to load parts:', err)
      })
      loadRenderSummary(activeProjectId).catch((err: unknown) => {
        console.error('[App] Failed to load render status:', err)
      })
      loadPhraseDurations(activeProjectId).catch((err: unknown) => {
        console.error('[App] Failed to load phrase durations:', err)
      })
    }
  }, [
    activeProjectId,
    loadCameras,
    loadRundowns,
    loadParts,
    loadRenderSummary,
    loadPhraseDurations,
  ])

  useEffect(() => {
    loadAudioDevices().catch((err: unknown) =>
      console.error('[App] Failed to load audio devices:', err),
    )
  }, [loadAudioDevices])

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
    await window.api.exportImport.exportProject({ projectId: activeProjectId })
  }

  async function handleExportRundown(): Promise<void> {
    if (!activeRundownId) return
    await window.api.exportImport.exportRundown({ rundownId: activeRundownId })
  }

  async function handleExportDatabase(): Promise<void> {
    await window.api.exportImport.exportDatabase()
  }

  async function handleImportProject(): Promise<void> {
    await window.api.exportImport.importProject()
    await loadProjects()
  }

  async function handleImportRundown(): Promise<void> {
    if (!activeProjectId) return
    const newRundownId = await window.api.exportImport.importRundown({ projectId: activeProjectId })
    if (newRundownId) {
      await loadProjects()
    }
  }

  async function handleImportDatabase(): Promise<void> {
    const confirmed = window.confirm('This will replace ALL data. Are you sure?')
    if (!confirmed) return
    const ok = await window.api.exportImport.importDatabase()
    if (ok) {
      await loadProjects()
    }
  }

  // Shared across every mode — see the single TimelineEditor slot below.
  const timelineProps = {
    shots,
    cameras,
    liveIndex,
    running,
    startedAt,
    markers,
    selectedShotId,
    mediaVideoRef: videoRef,
    // The media track only applies to edit mode; live mode hides it.
    rundownMedia: uiMode === 'edit' ? rundownMedia : null,
    phraseDurationMsByPartId: phraseDurations,
    onShotClick: (id: string) => setSelectedShotId(id),
    onSplitShot: (shotId: string, atMs: number, newCameraId: string) => {
      if (atMs <= 0) {
        editShot({ id: shotId, cameraId: newCameraId }).catch((err: unknown) =>
          console.error('[App] editShot:', err),
        )
      } else {
        splitShot(shotId, atMs, { newCameraId }).catch((err: unknown) =>
          console.error('[App] splitShot:', err),
        )
      }
    },
    onResizeShots: (idA: string, durA: number, idB: string, durB: number) => {
      Promise.all([
        editShot({ id: idA, durationMs: Math.round(durA) }),
        editShot({ id: idB, durationMs: Math.round(durB) }),
      ]).catch((err: unknown) => console.error('[App] resizeShots:', err))
    },
    onExtendLastShot: (id: string, dur: number) => {
      editShot({ id, durationMs: Math.round(dur) }).catch((err: unknown) =>
        console.error('[App] extendLastShot:', err),
      )
    },
    onDeleteShot: (id: string, mode?: DeleteShotMode) => {
      removeShot(id, mode).catch((err: unknown) => console.error('[App] deleteShot:', err))
    },
    onChangeShotCamera: (id: string, camId: string) => {
      editShot({ id, cameraId: camId }).catch((err: unknown) =>
        console.error('[App] changeShotCamera:', err),
      )
    },
    onAddMarker: (posMs: number) => {
      if (activeRundownId)
        addMarker(activeRundownId, posMs).catch((err: unknown) =>
          console.error('[App] addMarker:', err),
        )
    },
    onUpdateMarker: (id: string, posMs: number) =>
      updateMarker(id, posMs).catch((err: unknown) => console.error('[App] updateMarker:', err)),
    onDeleteMarker: (id: string) =>
      removeMarker(id).catch((err: unknown) => console.error('[App] deleteMarker:', err)),
    onImportMedia: () => {
      handleImportMedia().catch((err: unknown) => console.error('[App] importMedia:', err))
    },
    onUpdateMediaOffset: (offsetMs: number) => {
      if (rundownMedia && activeRundownId) {
        saveRundownMedia(activeRundownId, rundownMedia.filePath, offsetMs).catch((err: unknown) =>
          console.error('[App] updateMediaOffset:', err),
        )
      }
    },
    onClearMedia: () => {
      if (activeRundownId)
        clearRundownMedia(activeRundownId).catch((err: unknown) =>
          console.error('[App] clearMedia:', err),
        )
    },
    onLabelEdit: (id: string) => setLabelEditingId(id),
  }

  const shotListPanel = (
    <ShotListPanel
      selectedShotId={selectedShotId}
      labelEditingId={labelEditingId}
      onLabelEditDone={() => setLabelEditingId(null)}
    />
  )

  const shotlistWidget =
    activeRundown !== null ? (
      <ShotlistWidget
        rundownName={activeRundown.name}
        shots={shots}
        cameras={cameras}
        parts={parts}
        kind={activeRundown.kind}
        liveIndex={liveIndex}
        startedAt={startedAt}
        running={running}
        showNextBackground
        autoScroll
        audioBaseUrl={audioBaseUrl}
        muteCount={muteCount}
        muteBeep={muteBeep}
        audioVolume={audioVolume}
        cueSinkId={cueSinkId}
      />
    ) : null

  // What sits between the live controls and the timeline, per mode.
  let centerContent: React.ReactNode
  let centerContentStyle: React.CSSProperties
  let rightPanel: React.ReactNode = null

  if (uiMode === 'live') {
    centerContent = shotlistWidget
    centerContentStyle = { flex: 1, overflow: 'hidden' }
  } else if (hasVideo) {
    centerContent = (
      <video
        ref={videoRef}
        src={toMediaUrl(rundownMedia!.filePath)}
        style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
      />
    )
    centerContentStyle = {
      flex: 1,
      overflow: 'hidden',
      background: '#000',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }
    rightPanel = activeRundown !== null ? <div style={styles.right}>{shotListPanel}</div> : null
  } else {
    centerContent = shotListPanel
    centerContentStyle = { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }
    rightPanel = activeRundown !== null ? <div style={styles.right}>{shotlistWidget}</div> : null
  }

  return (
    <div style={styles.root}>
      <TopBar
        flash={headerFlash}
        audio={{ muteCount, muteBeep, volume: audioVolume }}
        onToggleMuteCount={() => {
          const v = !muteCount
          setMuteCount(v)
          localStorage.setItem('obs-queuer-mute-count', String(v))
        }}
        onToggleMuteBeep={() => {
          const v = !muteBeep
          setMuteBeep(v)
          localStorage.setItem('obs-queuer-mute-beep', String(v))
        }}
        onChangeVolume={(v) => {
          setAudioVolume(v)
          localStorage.setItem('obs-queuer-audio-volume', String(v))
        }}
        hasActiveProject={activeProjectId !== null}
        hasActiveRundown={activeRundownId !== null}
        onImportResolve={() => setShowResolveImport(true)}
        onImportProject={() => {
          handleImportProject().catch((err: unknown) => console.error('[App] importProject:', err))
        }}
        onImportRundown={() => {
          handleImportRundown().catch((err: unknown) => console.error('[App] importRundown:', err))
        }}
        onImportDatabase={() => {
          handleImportDatabase().catch((err: unknown) =>
            console.error('[App] importDatabase:', err),
          )
        }}
        onExportRundown={() => {
          handleExportRundown().catch((err: unknown) => console.error('[App] exportRundown:', err))
        }}
        onExportProject={() => {
          handleExportProject().catch((err: unknown) => console.error('[App] exportProject:', err))
        }}
        onExportDatabase={() => {
          handleExportDatabase().catch((err: unknown) =>
            console.error('[App] exportDatabase:', err),
          )
        }}
        connections={{
          obsStatus,
          oscEnabled: oscSettings.enabled,
          oscPort: oscSettings.port,
        }}
        onOpenObsPanel={() => setShowObsPanel(true)}
        onOpenOscPanel={() => setShowOscPanel(true)}
        onOpenCameraConfig={() => setShowCameraConfig(true)}
        unrenderedCount={unrenderedCount}
        onOpenVoiceSettings={() => setShowVoicePanel(true)}
      />

      {serverError !== null && (
        <div style={{ ...styles.warningBanner, background: '#c0392b', cursor: 'default' }}>
          <span>Phone server:</span>
          <span>{serverError}</span>
        </div>
      )}

      {obsStatus === 'connected' &&
        obsValidationResult !== null &&
        (!obsValidationResult.studioModeEnabled ||
          obsValidationResult.missingScenes.length > 0 ||
          obsValidationResult.missingTransitions.length > 0) && (
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
        ) : (
          <>
            <RundownSidebar />

            {/*
              One TimelineEditor for every mode, in a fixed slot. Rendering it
              separately per branch made React unmount and remount it on each
              edit/live or video toggle, throwing away zoom, playhead and the
              decoded waveform — which then had to be decoded from scratch.
            */}
            <div style={styles.center}>
              {/*
                Parts sit beside the Cameras panel conceptually, but the Cameras
                trigger lives in the project menu inside ProjectSelector; until
                a "Parts…" entry lands there, this strip is the way in, and it
                shows for every Kind so the panel is where the operator left it.
              */}
              <div style={styles.configStrip}>
                <button
                  style={styles.configStripBtn}
                  onClick={() => setShowPartsConfig(true)}
                  title="Manage parts for this project"
                >
                  Parts…
                </button>
              </div>
              {activeRundownId !== null && <LiveControls key="live-controls" />}
              <div key="center-content" style={centerContentStyle}>
                {centerContent}
              </div>
              <TimelineEditor key="timeline" {...timelineProps} />
            </div>

            {rightPanel}
          </>
        )}
      </div>

      {showCameraConfig && <CameraConfigPanel onClose={() => setShowCameraConfig(false)} />}
      {showPartsConfig && <PartsConfigPanel onClose={() => setShowPartsConfig(false)} />}
      {showResolveImport && <ResolveImportDialog onClose={() => setShowResolveImport(false)} />}
      {showObsPanel && <OBSSettingsPanel onClose={() => setShowObsPanel(false)} />}
      {showVoicePanel && <VoiceSettingsPanel onClose={() => setShowVoicePanel(false)} />}
      {showOscPanel && (
        <OSCSettingsPanel
          onClose={() => {
            setShowOscPanel(false)
            refreshOscSettings()
          }}
        />
      )}
    </div>
  )
}
