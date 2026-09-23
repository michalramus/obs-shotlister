import { create } from 'zustand'
import type {
  Project,
  Camera,
  Rundown,
  Shot,
  Marker,
  Part,
  Lyric,
  RundownKind,
} from '../shared/types'
import { applyLivePosition } from '../shared/live-view'
import type {
  LiveState,
  CreateShotInput,
  UpdateShotInput,
  OBSConnectionStatus,
  OBSValidateResult,
  DeleteShotMode,
  PartScope,
  PartUpsertInput,
  LyricUpsertInput,
  ProjectRenderStatus,
  AudioDeviceSettings,
  GlobalVoiceSettings,
  ProjectVoiceSettings,
} from '../shared/ipc-contract'

interface AppStore {
  // Data
  projects: Project[]
  cameras: Camera[] // cameras for active project
  rundowns: Rundown[] // rundowns for active project
  shots: Shot[] // shots for active rundown
  markers: Marker[] // markers for active rundown
  parts: Part[] // every Part in the active project
  partsInScope: Part[] // the additive union the active rundown may choose from
  lyrics: Lyric[] // Lyrics Track of the active rundown

  // Selection
  activeProjectId: string | null
  activeRundownId: string | null

  // Live playback state
  liveIndex: number | null // index into shots[] of current live shot
  startedAt: number | null // Date.now() when live shot started
  running: boolean // whether rundown is started

  // UI mode
  uiMode: 'edit' | 'live'
  setUiMode: (mode: 'edit' | 'live') => void

  // Camera filter
  cameraFilter: number | null
  setCameraFilter: (filter: number | null) => void

  // OBS state
  obsStatus: OBSConnectionStatus
  obsValidationResult: OBSValidateResult | null

  // Actions (call IPC, then update store)
  setActiveProject: (id: string | null) => void
  setActiveRundown: (id: string | null) => void
  setLiveState: (state: LiveState) => void
  handleLiveStatePush: (state: LiveState) => void
  markShotHidden: (shotId: string) => void
  setObsStatus: (status: OBSConnectionStatus) => void
  setObsValidationResult: (result: OBSValidateResult | null) => void

  // Project CRUD actions
  loadProjects: () => Promise<void>
  addProject: (name: string) => Promise<Project>
  renameProject: (id: string, name: string) => Promise<void>
  removeProject: (id: string) => Promise<void>

  // Camera CRUD actions
  loadCameras: (projectId: string) => Promise<void>
  upsertCamera: (input: Omit<Camera, 'id'> & { id?: string }) => Promise<Camera>
  removeCamera: (id: string) => Promise<void>

  // Rundown CRUD actions
  loadRundowns: (projectId: string) => Promise<void>
  addRundown: (name: string) => Promise<Rundown>
  renameRundown: (id: string, name: string) => Promise<void>
  removeRundown: (id: string) => Promise<void>
  reorderRundowns: (ids: string[]) => Promise<void>
  setRundownFolder: (id: string, folder: string | null) => Promise<void>
  setRundownKind: (id: string, kind: RundownKind) => Promise<void>
  renameFolder: (from: string, to: string) => Promise<void>

  // Part CRUD actions
  loadParts: (projectId: string) => Promise<void>
  loadPartsInScope: (rundownId: string) => Promise<void>
  upsertPart: (input: PartUpsertInput) => Promise<Part>
  removePart: (id: string) => Promise<void>
  promotePart: (id: string, scope: PartScope) => Promise<void>
  setPartsColor: (ids: string[], color: string) => Promise<void>

  // Announcement rendering
  renderStatus: ProjectRenderStatus | null
  /** Phrase clip length per Part id; absent means nothing is rendered for it. */
  phraseDurations: Record<string, number>
  setRenderStatus: (status: ProjectRenderStatus) => void
  loadRenderStatus: (projectId: string) => Promise<void>
  loadPhraseDurations: (projectId: string) => Promise<void>
  renderMissing: (projectId: string) => Promise<void>

  // Audio output devices
  audioDevices: AudioDeviceSettings
  loadAudioDevices: () => Promise<void>
  saveAudioDevices: (devices: AudioDeviceSettings) => Promise<void>

  // Voice-over settings
  voiceSettings: GlobalVoiceSettings | null
  projectVoiceSettings: ProjectVoiceSettings | null
  loadVoiceSettings: (projectId: string | null) => Promise<void>
  saveVoiceSettings: (settings: GlobalVoiceSettings) => Promise<void>
  saveProjectVoiceSettings: (projectId: string, settings: ProjectVoiceSettings) => Promise<void>

  // Lyric CRUD actions
  loadLyrics: (rundownId: string) => Promise<void>
  upsertLyric: (input: LyricUpsertInput) => Promise<Lyric>
  removeLyric: (id: string) => Promise<void>

  // Shot CRUD actions
  loadShots: (rundownId: string) => Promise<void>
  addShot: (input: CreateShotInput) => Promise<Shot>
  editShot: (input: UpdateShotInput) => Promise<void>
  removeShot: (id: string, mode?: DeleteShotMode) => Promise<void>
  reorderShots: (ids: string[]) => Promise<void>
  splitShot: (
    shotId: string,
    atMs: number,
    target: { newCameraId?: string | null; newPartId?: string | null },
  ) => Promise<void>

  // Marker CRUD actions
  loadMarkers: (rundownId: string) => Promise<void>
  addMarker: (rundownId: string, positionMs: number, label?: string | null) => Promise<Marker>
  updateMarker: (id: string, positionMs: number) => Promise<void>
  removeMarker: (id: string) => Promise<void>

  // Rundown media
  rundownMedia: { filePath: string; offsetMs: number } | null
  loadRundownMedia: (rundownId: string) => Promise<void>
  saveRundownMedia: (rundownId: string, filePath: string, offsetMs: number) => Promise<void>
  clearRundownMedia: (rundownId: string) => Promise<void>

  // Live control actions
  loadLiveState: () => Promise<void>
  liveStart: (rundownId: string, previewFirst?: boolean) => Promise<void>
  liveStop: () => Promise<void>
  liveNext: () => Promise<void>
  liveSkipNext: () => Promise<void>
  liveRestart: () => Promise<void>
}

export const useAppStore = create<AppStore>((set, get) => ({
  // Data
  projects: [],
  cameras: [],
  rundowns: [],
  shots: [],
  markers: [],
  parts: [],
  partsInScope: [],
  lyrics: [],
  renderStatus: null,
  phraseDurations: {},
  audioDevices: { cueSinkId: null, announcementSinkId: null },
  voiceSettings: null,
  projectVoiceSettings: null,

  // Rundown media
  rundownMedia: null,

  // Selection
  activeProjectId: null,
  activeRundownId: null,

  // Live playback state
  liveIndex: null,
  startedAt: null,
  running: false,

  // UI mode
  uiMode: 'edit' as 'edit' | 'live',
  setUiMode: (mode) => {
    set({ uiMode: mode })
    window.api.ui.setMode(mode).catch((err: unknown) => console.error('[store] setUiMode:', err))
  },

  // Camera filter
  cameraFilter: (() => {
    try {
      const raw = localStorage.getItem('obs-queuer-camera-filter')
      if (!raw) return null
      const n = parseInt(raw, 10)
      return isNaN(n) ? null : n
    } catch {
      return null
    }
  })(),
  setCameraFilter: (filter) => {
    set({ cameraFilter: filter })
    try {
      localStorage.setItem('obs-queuer-camera-filter', filter !== null ? String(filter) : '')
    } catch (err) {
      console.error('[store] setCameraFilter localStorage:', err)
    }
  },

  // OBS state
  obsStatus: 'disconnected',
  obsValidationResult: null,

  // Actions
  setActiveProject: (id) => {
    set({ activeProjectId: id })
    window.api.project.setActive({ projectId: id }).catch((err: unknown) => {
      console.error('[store] setActiveProject IPC error:', err)
    })
  },
  setActiveRundown: (id) => {
    set({ activeRundownId: id })
    window.api.rundowns.setActive({ rundownId: id }).catch((err: unknown) => {
      console.error('[store] setActiveRundown IPC error:', err)
    })
  },
  setLiveState: (state) =>
    set((s) => ({
      liveIndex: state.liveIndex,
      startedAt: state.startedAt,
      running: state.running,
      // Same derivation the Phone view uses — see src/shared/live-view.ts.
      shots: applyLivePosition(s.shots, state.liveIndex),
    })),

  markShotHidden: (shotId) =>
    set((s) => ({
      shots: s.shots.map((shot) => (shot.id === shotId ? { ...shot, hidden: true } : shot)),
    })),

  handleLiveStatePush: (state) => {
    const { running, activeRundownId, loadShots } = get()
    get().setLiveState(state)
    if (running && !state.running && activeRundownId) {
      loadShots(activeRundownId).catch((err: unknown) =>
        console.error('[store] handleLiveStatePush loadShots:', err),
      )
    }
  },

  setObsStatus: (status) => set({ obsStatus: status }),
  setObsValidationResult: (result) => set({ obsValidationResult: result }),

  // Project CRUD
  loadProjects: async () => {
    const projects = await window.api.projects.list()
    const { activeProjectId } = get()
    const newActiveId = activeProjectId ?? (projects.length > 0 ? projects[0].id : null)
    set({ projects, activeProjectId: newActiveId })
  },

  addProject: async (name) => {
    const project = await window.api.projects.create({ name })
    set((state) => ({
      projects: [...state.projects, project],
      activeProjectId: project.id,
      cameras: [],
      rundowns: [],
      shots: [],
    }))
    return project
  },

  renameProject: async (id, name) => {
    const updated = await window.api.projects.rename({ id, name })
    set((state) => ({
      projects: state.projects.map((p) => (p.id === id ? updated : p)),
    }))
  },

  removeProject: async (id) => {
    await window.api.projects.delete({ id })
    const { projects, activeProjectId } = get()
    const remaining = projects.filter((p) => p.id !== id)
    const newActiveId =
      activeProjectId === id ? (remaining.length > 0 ? remaining[0].id : null) : activeProjectId
    set({
      projects: remaining,
      activeProjectId: newActiveId,
      cameras: newActiveId === null ? [] : get().cameras,
      rundowns: newActiveId === null ? [] : get().rundowns,
      shots: newActiveId === null ? [] : get().shots,
    })
    if (newActiveId !== null && newActiveId !== activeProjectId) {
      await get().loadCameras(newActiveId)
      await get().loadRundowns(newActiveId)
    } else if (newActiveId === null) {
      set({ cameras: [], rundowns: [], shots: [] })
    }
  },

  // Camera CRUD
  loadCameras: async (projectId) => {
    const cameras = await window.api.cameras.list({ projectId })
    set({ cameras })
  },

  upsertCamera: async (input) => {
    const camera = await window.api.cameras.upsert(input)
    set((state) => {
      const exists = state.cameras.some((c) => c.id === camera.id)
      const updated = exists
        ? state.cameras.map((c) => (c.id === camera.id ? camera : c))
        : [...state.cameras, camera]
      return { cameras: updated.slice().sort((a, b) => a.number - b.number) }
    })
    return camera
  },

  removeCamera: async (id) => {
    await window.api.cameras.delete({ id })
    set((state) => ({ cameras: state.cameras.filter((c) => c.id !== id) }))
  },

  // Rundown CRUD
  loadRundowns: async (projectId) => {
    const rundowns = await window.api.rundowns.list({ projectId })
    set({ rundowns })
  },

  addRundown: async (name) => {
    const { activeProjectId } = get()
    if (!activeProjectId) throw new Error('No active project')
    const rundown = await window.api.rundowns.create({ projectId: activeProjectId, name })
    set((state) => ({
      rundowns: [...state.rundowns, rundown],
      activeRundownId: rundown.id,
      shots: [],
    }))
    await window.api.rundowns.setActive({ rundownId: rundown.id })
    const { cameras } = get()
    if (cameras.length > 0) {
      await window.api.shots.create({
        rundownId: rundown.id,
        cameraId: cameras[0].id,
        durationMs: 180000,
      })
      await get().loadShots(rundown.id)
    }
    return rundown
  },

  renameRundown: async (id, name) => {
    const updated = await window.api.rundowns.rename({ id, name })
    set((state) => ({
      rundowns: state.rundowns.map((r) => (r.id === id ? updated : r)),
    }))
  },

  reorderRundowns: async (ids) => {
    await window.api.rundowns.reorder({ ids })
    set((state) => {
      const order = new Map(ids.map((id, i) => [id, i]))
      return {
        rundowns: [...state.rundowns].sort(
          (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
        ),
      }
    })
  },

  setRundownFolder: async (id, folder) => {
    const updated = await window.api.rundowns.setFolder({ id, folder })
    set((state) => ({ rundowns: state.rundowns.map((r) => (r.id === id ? updated : r)) }))
    // Moving between folders changes which Parts are offered, never which Part
    // an existing Call resolves to (ADR 0006).
    if (get().activeRundownId === id) await get().loadPartsInScope(id)
  },

  setRundownKind: async (id, kind) => {
    const updated = await window.api.rundowns.setKind({ id, kind })
    set((state) => ({ rundowns: state.rundowns.map((r) => (r.id === id ? updated : r)) }))
  },

  renameFolder: async (from, to) => {
    const { activeProjectId } = get()
    if (!activeProjectId) throw new Error('No active project')
    await window.api.rundowns.renameFolder({ projectId: activeProjectId, from, to })
    await get().loadRundowns(activeProjectId)
    await get().loadParts(activeProjectId)
  },

  removeRundown: async (id) => {
    await window.api.rundowns.delete({ id })
    const { rundowns, activeRundownId } = get()
    const remaining = rundowns.filter((r) => r.id !== id)
    const newActiveId =
      activeRundownId === id ? (remaining.length > 0 ? remaining[0].id : null) : activeRundownId
    set({ rundowns: remaining, activeRundownId: newActiveId })
    if (newActiveId !== null && newActiveId !== activeRundownId) {
      await get().loadShots(newActiveId)
    } else if (newActiveId === null) {
      set({ shots: [] })
    }
  },

  // Rundown media
  loadRundownMedia: async (rundownId) => {
    const result = await window.api.rundownMedia.get({ rundownId })
    set({
      rundownMedia: result.filePath
        ? { filePath: result.filePath, offsetMs: result.offsetMs }
        : null,
    })
  },
  saveRundownMedia: async (rundownId, filePath, offsetMs) => {
    await window.api.rundownMedia.save({ rundownId, filePath, offsetMs })
    set({ rundownMedia: { filePath, offsetMs } })
  },
  clearRundownMedia: async (rundownId) => {
    await window.api.rundownMedia.clear({ rundownId })
    set({ rundownMedia: null })
  },

  // Shot CRUD
  loadShots: async (rundownId) => {
    const shots = await window.api.shots.list({ rundownId })
    set({ shots })
    await get().loadMarkers(rundownId)
    await get().loadRundownMedia(rundownId)
    await get().loadLyrics(rundownId)
    await get().loadPartsInScope(rundownId)
  },

  addShot: async (input) => {
    const shot = await window.api.shots.create(input)
    set((state) => ({ shots: [...state.shots, shot] }))
    return shot
  },

  editShot: async (input) => {
    const updated = await window.api.shots.update(input)
    set((state) => ({
      shots: state.shots.map((s) => (s.id === input.id ? updated : s)),
    }))
  },

  removeShot: async (id, mode) => {
    await window.api.shots.delete({ id, mode })
    // 'extend' resizes a neighbour, so the local list cannot be patched by
    // filtering — refetch to pick up the new duration.
    const { activeRundownId } = get()
    if (activeRundownId) {
      await get().loadShots(activeRundownId)
    } else {
      set((state) => ({ shots: state.shots.filter((s) => s.id !== id) }))
    }
  },

  reorderShots: async (ids) => {
    await window.api.shots.reorder({ ids })
    // Re-fetch to get updated orderIndex values
    const { activeRundownId } = get()
    if (activeRundownId) {
      await get().loadShots(activeRundownId)
    }
  },

  splitShot: async (shotId, atMs, target) => {
    await window.api.shots.split({ shotId, atMs, ...target })
    const { activeRundownId } = get()
    if (activeRundownId) await get().loadShots(activeRundownId)
  },

  // Parts
  loadParts: async (projectId) => {
    const parts = await window.api.parts.list({ projectId })
    set({ parts })
  },

  loadPartsInScope: async (rundownId) => {
    const partsInScope = await window.api.parts.listInScope({ rundownId })
    set({ partsInScope })
  },

  upsertPart: async (input) => {
    const part = await window.api.parts.upsert(input)
    const { activeProjectId, activeRundownId } = get()
    // Scope decides which list a Part lands in, and a new Part is created at
    // Rundown scope, so both lists are refetched rather than patched.
    if (activeProjectId) await get().loadParts(activeProjectId)
    if (activeRundownId) await get().loadPartsInScope(activeRundownId)
    return part
  },

  removePart: async (id) => {
    await window.api.parts.delete({ id })
    set((state) => ({
      parts: state.parts.filter((p) => p.id !== id),
      partsInScope: state.partsInScope.filter((p) => p.id !== id),
    }))
  },

  promotePart: async (id, scope) => {
    await window.api.parts.promote({ id, scope })
    const { activeProjectId, activeRundownId } = get()
    if (activeProjectId) await get().loadParts(activeProjectId)
    if (activeRundownId) await get().loadPartsInScope(activeRundownId)
  },

  setPartsColor: async (ids, color) => {
    await window.api.parts.setColor({ ids, color })
    const { activeProjectId, activeRundownId } = get()
    if (activeProjectId) await get().loadParts(activeProjectId)
    if (activeRundownId) await get().loadPartsInScope(activeRundownId)
  },

  // Announcement rendering
  setRenderStatus: (status) => set({ renderStatus: status }),

  loadRenderStatus: async (projectId) => {
    set({ renderStatus: await window.api.tts.status({ projectId }) })
  },

  loadPhraseDurations: async (projectId) => {
    set({ phraseDurations: await window.api.tts.phraseDurations({ projectId }) })
  },

  renderMissing: async (projectId) => {
    set({ renderStatus: await window.api.tts.render({ projectId }) })
    // Durations are what Edit mode badges against, and a render is the only
    // thing that changes them.
    await get().loadPhraseDurations(projectId)
  },

  // Audio output devices
  loadAudioDevices: async () => {
    set({ audioDevices: await window.api.audioDevices.get() })
  },

  saveAudioDevices: async (devices) => {
    await window.api.audioDevices.save(devices)
    set({ audioDevices: devices })
  },

  // Voice-over settings
  loadVoiceSettings: async (projectId) => {
    const voiceSettings = await window.api.voice.getSettings()
    const projectVoiceSettings =
      projectId === null ? null : await window.api.voice.getProjectSettings({ projectId })
    set({ voiceSettings, projectVoiceSettings })
  },

  saveVoiceSettings: async (settings) => {
    await window.api.voice.saveSettings(settings)
    set({ voiceSettings: settings })
    // Voice is part of every clip's content address, so changing it can turn
    // every Part stale at once — the strip has to find out immediately.
    const { activeProjectId } = get()
    if (activeProjectId) await get().loadRenderStatus(activeProjectId)
  },

  saveProjectVoiceSettings: async (projectId, settings) => {
    await window.api.voice.saveProjectSettings({ projectId, settings })
    set({ projectVoiceSettings: settings })
    await get().loadRenderStatus(projectId)
  },

  // Lyrics
  loadLyrics: async (rundownId) => {
    const lyrics = await window.api.lyrics.list({ rundownId })
    set({ lyrics })
  },

  upsertLyric: async (input) => {
    const lyric = await window.api.lyrics.upsert(input)
    set((state) => {
      const exists = state.lyrics.some((l) => l.id === lyric.id)
      const updated = exists
        ? state.lyrics.map((l) => (l.id === lyric.id ? lyric : l))
        : [...state.lyrics, lyric]
      return { lyrics: updated.sort((a, b) => a.startMs - b.startMs) }
    })
    return lyric
  },

  removeLyric: async (id) => {
    await window.api.lyrics.delete({ id })
    set((state) => ({ lyrics: state.lyrics.filter((l) => l.id !== id) }))
  },

  // Marker CRUD
  loadMarkers: async (rundownId) => {
    const markers = await window.api.markers.list({ rundownId })
    set({ markers })
  },

  addMarker: async (rundownId, positionMs, label = null) => {
    const marker = await window.api.markers.upsert({ rundownId, positionMs, label })
    set((state) => ({
      markers: [...state.markers, marker].sort((a, b) => a.positionMs - b.positionMs),
    }))
    return marker
  },

  updateMarker: async (id, positionMs) => {
    const { markers } = get()
    const existing = markers.find((m) => m.id === id)
    if (!existing) return
    const updated = await window.api.markers.upsert({
      id,
      rundownId: existing.rundownId,
      positionMs,
      label: existing.label,
    })
    set((state) => ({
      markers: state.markers
        .map((m) => (m.id === id ? updated : m))
        .sort((a, b) => a.positionMs - b.positionMs),
    }))
  },

  removeMarker: async (id) => {
    await window.api.markers.delete({ id })
    set((state) => ({ markers: state.markers.filter((m) => m.id !== id) }))
  },

  // Live controls
  loadLiveState: async () => {
    const state = await window.api.live.get()
    get().setLiveState(state)
  },

  liveStart: async (rundownId, previewFirst) => {
    const state = await window.api.live.start({ rundownId, previewFirst })
    get().setLiveState(state)
  },

  liveStop: async () => {
    const state = await window.api.live.stop()
    get().setLiveState(state)
    const { activeRundownId } = get()
    if (activeRundownId) await get().loadShots(activeRundownId)
  },

  liveNext: async () => {
    const state = await window.api.live.next()
    get().setLiveState(state)
    const { activeRundownId } = get()
    if (activeRundownId) await get().loadShots(activeRundownId)
  },

  liveSkipNext: async () => {
    const state = await window.api.live.skipNext()
    get().setLiveState(state)
    const { activeRundownId } = get()
    if (activeRundownId) await get().loadShots(activeRundownId)
  },

  liveRestart: async () => {
    const state = await window.api.live.restart()
    get().setLiveState(state)
    const { activeRundownId } = get()
    if (activeRundownId) await get().loadShots(activeRundownId)
  },
}))
