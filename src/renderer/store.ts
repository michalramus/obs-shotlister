import { create } from 'zustand'
import type { Project, Camera, Rundown, Shot, Marker } from '../shared/types'
import type { LiveState, CreateShotInput, UpdateShotInput, OBSConnectionStatus, OBSValidateResult } from './electron-api.d'

interface AppStore {
  // Data
  projects: Project[]
  cameras: Camera[] // cameras for active project
  rundowns: Rundown[] // rundowns for active project
  shots: Shot[] // shots for active rundown
  markers: Marker[] // markers for active rundown

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

  // OBS state
  obsStatus: OBSConnectionStatus
  obsValidationResult: OBSValidateResult | null

  // Actions (call IPC, then update store)
  setActiveProject: (id: string | null) => void
  setActiveRundown: (id: string | null) => void
  setLiveState: (state: LiveState) => void
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

  // Shot CRUD actions
  loadShots: (rundownId: string) => Promise<void>
  addShot: (input: CreateShotInput) => Promise<Shot>
  editShot: (input: UpdateShotInput) => Promise<void>
  removeShot: (id: string) => Promise<void>
  reorderShots: (ids: string[]) => Promise<void>
  splitShot: (shotId: string, atMs: number, newCameraId: string) => Promise<void>

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
  liveStart: (rundownId: string) => Promise<void>
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
  setUiMode: (mode) => set({ uiMode: mode }),

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
    set({
      liveIndex: state.liveIndex,
      startedAt: state.startedAt,
      running: state.running,
    }),

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
      await window.api.shots.create({ rundownId: rundown.id, cameraId: cameras[0].id, durationMs: 180000 })
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
    set({ rundownMedia: result.filePath ? { filePath: result.filePath, offsetMs: result.offsetMs } : null })
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

  removeShot: async (id) => {
    await window.api.shots.delete({ id })
    set((state) => ({ shots: state.shots.filter((s) => s.id !== id) }))
  },

  reorderShots: async (ids) => {
    await window.api.shots.reorder({ ids })
    // Re-fetch to get updated orderIndex values
    const { activeRundownId } = get()
    if (activeRundownId) {
      await get().loadShots(activeRundownId)
    }
  },

  splitShot: async (shotId, atMs, newCameraId) => {
    await window.api.shots.split({ shotId, atMs, newCameraId })
    const { activeRundownId } = get()
    if (activeRundownId) await get().loadShots(activeRundownId)
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
    const updated = await window.api.markers.upsert({ id, rundownId: existing.rundownId, positionMs, label: existing.label })
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

  liveStart: async (rundownId) => {
    const state = await window.api.live.start({ rundownId })
    get().setLiveState(state)
    set({ uiMode: 'live' })
  },

  liveStop: async () => {
    const state = await window.api.live.stop()
    get().setLiveState(state)
    set({ uiMode: 'edit' })
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
