export interface Project {
  id: string
  name: string
  createdAt: number
}

export interface Camera {
  id: string
  projectId: string
  number: number
  name: string
  color: string // hex, e.g. '#e74c3c'
  resolveColor: string | null // Resolve marker color name, e.g. 'Red'
  obsScene: string | null // OBS scene name
}

export interface Rundown {
  id: string
  projectId: string
  name: string
  createdAt: number
}

export interface Shot {
  id: string
  rundownId: string
  cameraId: string
  durationMs: number
  label: string | null
  orderIndex: number
  hidden?: boolean
  transitionName: string | null
  transitionMs: number  // 0 = cut / no transition
}

export interface Marker {
  id: string
  rundownId: string
  positionMs: number
  label: string | null
}
