// Type declaration for the contextBridge API exposed by the preload script.
// Augments the global Window interface so renderer code can access window.api
// with full type safety.

import type { Project, Camera, Rundown, Shot, Marker } from '../shared/types'

export type OBSConnectionStatus = 'disconnected' | 'connecting' | 'connected'

export interface OBSValidateResult {
  studioModeEnabled: boolean
  missingScenes: string[]
  missingTransitions: string[]
}

export interface TransitionMapping {
  logicalName: string
  obsTransitionName: string
}

export interface CameraUpsertInput extends Omit<Camera, 'id'> {
  id?: string
}

export interface CreateShotInput {
  rundownId: string
  cameraId: string
  durationMs: number
  label?: string | null
  transitionName?: string | null
  transitionMs?: number
}

export interface UpdateShotInput {
  id: string
  cameraId?: string
  durationMs?: number
  label?: string | null
  transitionName?: string | null
  transitionMs?: number
}

export interface LiveState {
  rundownId: string | null
  liveIndex: number | null
  startedAt: number | null
  running: boolean
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
    reorder: (args: { ids: string[] }) => Promise<void>
    setFolder: (args: { id: string; folder: string | null }) => Promise<Rundown>
  }
  shots: {
    list: (payload: { rundownId: string }) => Promise<Shot[]>
    create: (payload: CreateShotInput) => Promise<Shot>
    update: (payload: UpdateShotInput) => Promise<Shot>
    delete: (payload: { id: string }) => Promise<void>
    reorder: (payload: { ids: string[] }) => Promise<void>
    split: (payload: { shotId: string; atMs: number; newCameraId: string }) => Promise<{ first: Shot; second: Shot }>
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
    getScenes: () => Promise<string[]>
    getTransitions: () => Promise<string[]>
    getEnabled: () => Promise<boolean>
    setEnabled: (enabled: boolean) => Promise<void>
    validate: () => Promise<OBSValidateResult | null>
    listTransitionMappings: () => Promise<TransitionMapping[]>
    upsertTransitionMapping: (p: { logicalName: string; obsTransitionName: string }) => Promise<void>
    deleteTransitionMapping: (p: { logicalName: string }) => Promise<void>
    onStatusChange: (cb: (status: OBSConnectionStatus) => void) => void
    onValidationResult: (cb: (result: OBSValidateResult | null) => void) => void
  }
  osc: {
    getSettings: () => Promise<{ enabled: boolean; port: number }>
    saveSettings: (payload: { enabled: boolean; port: number }) => Promise<void>
  }
  markers: {
    list: (payload: { rundownId: string }) => Promise<Marker[]>
    upsert: (payload: { id?: string; rundownId: string; positionMs: number; label?: string | null }) => Promise<Marker>
    delete: (payload: { id: string }) => Promise<void>
  }
  rundownMedia: {
    get: (payload: { rundownId: string }) => Promise<{ filePath: string | null; offsetMs: number }>
    save: (payload: { rundownId: string; filePath: string; offsetMs: number }) => Promise<void>
    clear: (payload: { rundownId: string }) => Promise<void>
    openDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>
  }
  ui: {
    setMode: (mode: 'edit' | 'live') => Promise<void>
  }
  mediaReadFile: (filePath: string) => Promise<ArrayBuffer>
}

declare global {
  interface Window {
    api: ElectronApi
  }
}
