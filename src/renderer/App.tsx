import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useAppStore } from './store'
import { CameraConfigPanel } from './components/CameraConfigPanel'
import { PartsConfigPanel } from './components/PartsConfigPanel'
import { RundownSidebar } from './components/RundownSidebar'
import { ShotListPanel } from './components/ShotListPanel'
import { LiveControls } from './components/LiveControls'
import { ShotlistWidget } from '../shared/components/ShotlistWidget'
import { toMediaUrl } from '../shared/media-url'
import type { DeleteShotMode } from '../shared/ipc-contract'
import { ResolveImportDialog } from './components/ResolveImportDialog'
import { OBSSettingsPanel } from './components/OBSSettingsPanel'
import { VoiceSettingsPanel } from './components/VoiceSettingsPanel'
import { OSCSettingsPanel } from './components/OSCSettingsPanel'
import { TimelineEditor } from './components/TimelineEditor'
import { TopBar } from './components/TopBar'
import { createAnnouncementPlayer } from './audio/announcements'
import { createCuePlayer, type CuePlayer } from '../shared/audio/cue-player'
import {
  soundDestinations,
  worstCaseDelayMs,
  type SoundDestination,
} from '../shared/audio/routed-clip'

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
  const effectiveVoiceSettings = useAppStore((s) => s.effectiveVoiceSettings)
  const loadVoiceSettings = useAppStore((s) => s.loadVoiceSettings)
  const unrenderedCount = useAppStore((s) => s.renderSummary?.unrenderedCount ?? 0)
  // The two Outputs, whole: which of them carries a given sound, and how early
  // each one has to be played, is soundDestinations' answer and not this
  // component's — so nothing here has to remember that a disabled Output is not a
  // destination.
  const outputs = useAppStore((s) => s.audioDevices.outputs)
  const loadLiveState = useAppStore((s) => s.loadLiveState)
  const activeProjectId = useAppStore((s) => s.activeProjectId)
  // The push listeners below are registered once on mount, so they cannot close
  // over the active Project directly.
  const activeProjectIdRef = useRef(activeProjectId)
  activeProjectIdRef.current = activeProjectId
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
  // A label left mid-edit when the show starts is abandoned, not parked. The
  // shotlist already refuses to render or commit it while running, but the id
  // lived on here — so after Stop the editor reopened, focused, on a Shot the
  // operator had moved on from.
  useEffect(() => {
    if (running) setLabelEditingId(null)
  }, [running])
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
  // Built once the clip directory is known, and the only thing the shotlist is
  // told about audio: it plays Cues through this and never names a device.
  const [cuePlayer, setCuePlayer] = useState<CuePlayer | null>(null)
  const cuePlayerRef = useRef<CuePlayer | null>(null)

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
  // Read through a ref at the moment a plan arrives rather than captured, so a
  // device or delay changed between shows takes effect without rebuilding the
  // player that a plan in flight belongs to.
  const announcementDestinationsRef = useRef<readonly SoundDestination[]>(
    soundDestinations(outputs, 'voice'),
  )
  announcementDestinationsRef.current = soundDestinations(outputs, 'voice')
  const announcementPlayer = useRef(
    createAnnouncementPlayer(() => announcementDestinationsRef.current),
  )

  // Pushed into the player rather than passed down: routing is settled between
  // shows, so the pool is already pointing at the right devices when a beep is due.
  useEffect(() => {
    cuePlayer?.setOutputs(outputs)
  }, [cuePlayer, outputs])

  useEffect(() => {
    cuePlayer?.setVolume(audioVolume)
  }, [cuePlayer, audioVolume])

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
      // Filtered by Project: app start schedules an auto-render for every Project,
      // so this window is pushed the others' summaries too, and whichever arrived
      // last used to drive the warning strip and the start confirmation.
      window.api.speech.onStatusPush((summary) => {
        if (summary.projectId === activeProjectIdRef.current) setRenderSummary(summary)
      }),
      window.api.server.onError(setServerError),
    ]
    refreshOscSettings()
    let mounted = true
    window.api.assets
      .getAudioDir()
      .then((dir) => {
        if (!mounted) return
        const cues = createCuePlayer(toMediaUrl(dir))
        cuePlayerRef.current = cues
        setCuePlayer(cues)
      })
      .catch((err: unknown) => console.error('[App] getAudioDir:', err))
    const player = announcementPlayer.current
    return () => {
      mounted = false
      for (const off of unsubscribes) off()
      player.dispose()
      cuePlayerRef.current?.dispose()
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
      // No Transition guard here: the main process drops a Next or a Skip that
      // lands inside a Transition, and Preview-first comes from the stored
      // setting, so the space bar cannot disagree with the pedal.
      if (e.code === 'Space') {
        e.preventDefault()
        if (running) {
          liveNext().catch((err: unknown) => console.error('[App] liveNext:', err))
        } else if (uiMode === 'live' && shots.length > 0 && activeRundownId) {
          liveStart(activeRundownId).catch((err: unknown) => console.error('[App] liveStart:', err))
        }
        // If uiMode === 'edit', do nothing — TimelineEditor handles Space
      }
      if (e.code === 'ArrowRight' && running) {
        e.preventDefault()
        liveSkipNext().catch((err: unknown) => console.error('[App] liveSkipNext:', err))
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [running, shots, activeRundownId, liveNext, liveStart, liveSkipNext, uiMode])

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
      // Edit mode badges a Call too short to announce, and it needs the Voice
      // settings to know what "too short" means. Loading them only when the Voice
      // panel opened left every warning silently switched off in a fresh session,
      // and stale for the previous project after a project switch.
      loadVoiceSettings(activeProjectId).catch((err: unknown) => {
        console.error('[App] Failed to load voice settings:', err)
      })
    }
  }, [
    activeProjectId,
    loadCameras,
    loadRundowns,
    loadParts,
    loadRenderSummary,
    loadPhraseDurations,
    loadVoiceSettings,
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
    try {
      const ok = await window.api.exportImport.importDatabase()
      if (ok) {
        await loadProjects()
      }
    } catch (err) {
      // A refused import and a successful one used to look identical: the
      // failure went to console.error and the app reloaded either way. The
      // main process refuses anything that is not one of our exports before
      // deleting a single row, so this message is the operator's only sign.
      window.alert(
        `Import failed — nothing was changed.\n\n${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // Memoized because TimelineEditor keys a full pass over the Rundown on this
  // object; rebuilt each render, that pass ran on every render of App.
  const announcementSettings = useMemo(
    () =>
      effectiveVoiceSettings === null
        ? undefined
        : // Badged against the worst case: a Call that does not fit the most
          // delayed Output is one somebody may not hear, and Edit mode is the
          // last place the operator can lengthen it.
          { ...effectiveVoiceSettings, worstOutputDelayMs: worstCaseDelayMs(outputs, 'voice') },
    [effectiveVoiceSettings, outputs],
  )

  // Shared across every mode — see the single TimelineEditor slot below.
  const timelineProps = {
    shots,
    cameras,
    liveIndex,
    running,
    // Editing belongs to Edit mode. `running` only says a Live session is on air,
    // which is not until Start, so a rule keyed on it left the whole of Live mode
    // editable before the show began. It is still folded in, so flipping back to
    // the Edit layout mid-show does not unlock the timeline.
    readOnly: uiMode === 'live' || running,
    startedAt,
    markers,
    selectedShotId,
    mediaVideoRef: videoRef,
    // The media track only applies to edit mode; live mode hides it.
    rundownMedia: uiMode === 'edit' ? rundownMedia : null,
    phraseDurationMsByPartId: phraseDurations,
    announcementSettings,
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
    onUpdateMarker: (id: string, posMs: number, label?: string | null) =>
      updateMarker(id, posMs, label).catch((err: unknown) =>
        console.error('[App] updateMarker:', err),
      ),
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
        cuePlayer={cuePlayer ?? undefined}
        muteCount={muteCount}
        muteBeep={muteBeep}
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
        onOpenPartsConfig={() => setShowPartsConfig(true)}
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
