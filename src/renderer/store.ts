import { create } from 'zustand'
import type { Project, Camera, Rundown, Shot } from '../shared/types'

interface AppStore {
  // Data
  projects: Project[]
  cameras: Camera[] // cameras for active project
  rundowns: Rundown[] // rundowns for active project
  shots: Shot[] // shots for active rundown

  // Selection
  activeProjectId: string | null
  activeRundownId: string | null

  // Live playback state
  liveIndex: number | null // index into shots[] of current live shot
  startedAt: number | null // Date.now() when live shot started
  running: boolean // whether rundown is started

  // Actions (call IPC, then update store)
  setActiveProject: (id: string | null) => void
  setActiveRundown: (id: string | null) => void
  setLiveState: (liveIndex: number | null, startedAt: number | null, running: boolean) => void
}

export const useAppStore = create<AppStore>((set) => ({
  // Data
  projects: [],
  cameras: [],
  rundowns: [],
  shots: [],

  // Selection
  activeProjectId: null,
  activeRundownId: null,

  // Live playback state
  liveIndex: null,
  startedAt: null,
  running: false,

  // Actions
  setActiveProject: (id) => set({ activeProjectId: id }),
  setActiveRundown: (id) => set({ activeRundownId: id }),
  setLiveState: (liveIndex, startedAt, running) => set({ liveIndex, startedAt, running }),
}))
