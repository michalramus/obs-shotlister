import { create } from 'zustand'
import type { Rundown, Shot, Camera } from '../shared/types'

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
  toggleCameraFilter: (cameraNumber: number) => void
}

export const useWebStore = create<WebStore>((set) => ({
  rundown: null,
  shots: [],
  cameras: [],
  liveIndex: null,
  startedAt: null,
  skippedIds: [],
  running: false,
  cameraFilter: [],
  connected: false,

  setRundownState: (data) =>
    set({
      rundown: data.rundown,
      shots: data.shots,
      cameras: data.cameras,
    }),

  setLiveState: (data) =>
    set({
      liveIndex: data.liveIndex,
      startedAt: data.startedAt,
      skippedIds: data.skippedIds,
    }),

  setPlayback: (data) => set({ running: data.running }),

  setConnected: (connected) => set({ connected }),

  toggleCameraFilter: (cameraNumber) =>
    set((state) => {
      const current = state.cameraFilter
      if (current.includes(cameraNumber)) {
        return { cameraFilter: current.filter((n) => n !== cameraNumber) }
      } else {
        return { cameraFilter: [...current, cameraNumber] }
      }
    }),
}))
