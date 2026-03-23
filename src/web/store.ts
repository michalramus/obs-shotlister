import { create } from 'zustand'
import type { Rundown, Shot, Camera } from '../shared/types'

function initialCameraFilter(): number[] {
  try {
    const saved = localStorage.getItem('obs-queuer-camera-filter')
    if (!saved || saved === 'all') return []
    const num = parseInt(saved, 10)
    return isNaN(num) ? [] : [num]
  } catch {
    return []
  }
}

export interface WebStore {
  rundown: Rundown | null
  shots: Shot[]
  cameras: Camera[]
  liveIndex: number | null
  startedAt: number | null
  skippedIds: string[]
  running: boolean
  cameraFilter: number[] // empty = show all
  connected: boolean

  // Actions
  setRundownState: (data: { rundown: Rundown | null; shots: Shot[]; cameras: Camera[] }) => void
  setLiveState: (data: { liveIndex: number | null; startedAt: number | null; skippedIds: string[] }) => void
  setPlayback: (data: { running: boolean }) => void
  setConnected: (connected: boolean) => void
  setCameraFilter: (num: number | null) => void
}

export const useWebStore = create<WebStore>((set) => ({
  rundown: null,
  shots: [],
  cameras: [],
  liveIndex: null,
  startedAt: null,
  skippedIds: [],
  running: false,
  cameraFilter: initialCameraFilter(),
  connected: false,

  setRundownState: (data) => {
    try {
      localStorage.setItem('obs-queuer-cameras', JSON.stringify(data.cameras))
    } catch {}
    set({
      rundown: data.rundown,
      shots: data.shots,
      cameras: data.cameras,
    })
  },

  setLiveState: (data) =>
    set({
      liveIndex: data.liveIndex,
      startedAt: data.startedAt,
      skippedIds: data.skippedIds,
    }),

  setPlayback: (data) => set({ running: data.running }),

  setConnected: (connected) => set({ connected }),

  setCameraFilter: (num) => {
    set({ cameraFilter: num === null ? [] : [num] })
    try {
      localStorage.setItem('obs-queuer-camera-filter', num === null ? 'all' : num.toString())
    } catch {}
  },
}))
