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
    } catch (err) {
      console.error('[store] localStorage setItem:', err)
    }
    set({
      rundown: data.rundown,
      shots: data.shots,
      cameras: data.cameras,
    })
  },

  setLiveState: (data) => {
    const clientStartedAt = data.elapsedMs !== null ? Date.now() - data.elapsedMs : null
    set((s) => {
      if (data.liveIndex === null) {
        return { liveIndex: null, startedAt: clientStartedAt }
      }
      const newLiveShot = s.shots[data.liveIndex]
      const transitionMs = newLiveShot?.transitionMs ?? 0

      // Find last non-hidden shot before liveIndex — preserve it during transition
      let preserveIndex = -1
      if (transitionMs > 0) {
        for (let i = data.liveIndex - 1; i >= 0; i--) {
          if (!s.shots[i].hidden) { preserveIndex = i; break }
        }
      }

      const shots = s.shots.map((shot, i) => {
        if (i >= data.liveIndex!) return shot
        if (shot.hidden) return shot
        if (i === preserveIndex) return shot // delayed hide via state:shot:hidden
        return { ...shot, hidden: true }
      })
      return { liveIndex: data.liveIndex, startedAt: clientStartedAt, shots }
    })
  },

  setPlayback: (data) => set({ running: data.running }),

  setConnected: (connected) => set({ connected }),

  setShotHidden: (shotId) =>
    set((s) => ({ shots: s.shots.map((shot) => (shot.id === shotId ? { ...shot, hidden: true } : shot)) })),
}))
