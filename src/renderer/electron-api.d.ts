// Type declaration for the contextBridge API exposed by the preload script.
// Augments the global Window interface so renderer code can access window.api
// with full type safety.

import type { Project, Camera, Rundown, Shot } from '../shared/types'

export type OBSConnectionStatus = 'disconnected' | 'connecting' | 'connected'

export interface CameraUpsertInput extends Omit<Camera, 'id'> {
  id?: string
}

export interface CreateShotInput {
  rundownId: string
  cameraId: string
  durationMs: number
  label?: string | null
}

export interface UpdateShotInput {
  id: string
  cameraId?: string
  durationMs?: number
  label?: string | null
}

export interface LiveState {
  rundownId: string | null
  liveIndex: number | null
  startedAt: number | null
  running: boolean
  skippedIds: string[]
}

export interface ParsedRow {
  label: string
  durationTimecode: string
  resolveColor: string
}

export interface ParseResult {
  colors: string[]
  rows: ParsedRow[]
}

export interface ConfirmImportInput {
  rundownId: string
  mode: 'append' | 'replace'
  mapping: Record<string, string | null>
  rows: ParsedRow[]
  fps: number
}

export interface ElectronApi {
  projects: {
    list: () => Promise<Project[]>
    create: (payload: { name: string }) => Promise<Project>
    rename: (payload: { id: string; name: string }) => Promise<Project>
    delete: (payload: { id: string }) => Promise<void>
  }
  cameras: {
    list: (payload: { projectId: string }) => Promise<Camera[]>
    upsert: (payload: CameraUpsertInput) => Promise<Camera>
    delete: (payload: { id: string }) => Promise<void>
  }
  rundowns: {
    list: (payload: { projectId: string }) => Promise<Rundown[]>
    create: (payload: { projectId: string; name: string }) => Promise<Rundown>
    rename: (payload: { id: string; name: string }) => Promise<Rundown>
    delete: (payload: { id: string }) => Promise<void>
    setActive: (payload: { rundownId: string | null }) => Promise<void>
  }
  shots: {
    list: (payload: { rundownId: string }) => Promise<Shot[]>
    create: (payload: CreateShotInput) => Promise<Shot>
    update: (payload: UpdateShotInput) => Promise<Shot>
    delete: (payload: { id: string }) => Promise<void>
    reorder: (payload: { ids: string[] }) => Promise<void>
    importCsvOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>
    importCsvParse: (payload: { filePath: string }) => Promise<ParseResult>
    importCsvConfirm: (payload: ConfirmImportInput) => Promise<Shot[]>
  }
  live: {
    get: () => Promise<LiveState>
    start: (payload: { rundownId: string }) => Promise<LiveState>
    stop: () => Promise<LiveState>
    next: () => Promise<LiveState>
    skipNext: () => Promise<LiveState>
    restart: () => Promise<LiveState>
  }
  project: {
    setActive: (payload: { projectId: string | null }) => Promise<void>
  }
  obs: {
    getSettings: () => Promise<{ url: string; password: string }>
    saveSettings: (payload: { url: string; password: string }) => Promise<void>
    connect: () => Promise<void>
    disconnect: () => Promise<void>
    getStatus: () => Promise<{ status: OBSConnectionStatus }>
    checkScenes: () => Promise<{ allMapped: boolean; missing: string[] }>
    onStatusChange: (cb: (status: OBSConnectionStatus) => void) => void
  }
}

declare global {
  interface Window {
    api: ElectronApi
  }
}
