import { create } from 'zustand'
import type { Rundown, Shot, Camera } from '../shared/types'

export interface WebStore {
  rundown: Rundown | null
  shots: Shot[]
  cameras: Camera[]
  liveIndex: number | null
  startedAt: number | null
  running: boolean
  connected: boolean

  // Actions
  setRundownState: (data: { rundown: Rundown | null; shots: Shot[]; cameras: Camera[] }) => void
  setLiveState: (data: { liveIndex: number | null; elapsedMs: number | null }) => void
  setPlayback: (data: { running: boolean }) => void
  setConnected: (connected: boolean) => void
  setShotHidden: (shotId: string) => void
}

export const useWebStore = create<WebStore>((set) => ({
  rundown: null,
  shots: [],
  cameras: [],
  liveIndex: null,
  startedAt: null,
  running: false,
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

  setLiveState: (data) => {
    const clientStartedAt = data.elapsedMs !== null ? Date.now() - data.elapsedMs : null
    set((s) => {
      const shots =
        data.liveIndex !== null
          ? s.shots.map((shot, i) => (i < data.liveIndex! && !shot.hidden ? { ...shot, hidden: true } : shot))
          : s.shots
      return { liveIndex: data.liveIndex, startedAt: clientStartedAt, shots }
    })
  },

  setPlayback: (data) => set({ running: data.running }),

  setConnected: (connected) => set({ connected }),

  setShotHidden: (shotId) =>
    set((s) => ({ shots: s.shots.map((shot) => (shot.id === shotId ? { ...shot, hidden: true } : shot)) })),
}))
