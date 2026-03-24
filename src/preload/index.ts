// Preload script — runs in the renderer before page content loads.
// Exposes a typed API surface to the renderer via contextBridge.

import { contextBridge, ipcRenderer } from 'electron'
import type { Project, Camera, Rundown, Shot, Marker } from '../shared/types'
import type { CameraUpsertInput } from '../main/ipc/projects'
import type { CreateShotInput, UpdateShotInput } from '../main/ipc/shots'
import type { LiveState } from '../main/ipc/live'
import type { OBSConnectionStatus } from '../main/obs/client'
import type { ParseResult, ConfirmImportInput } from '../main/ipc/resolve-import'
import type { TransitionMapping } from '../main/ipc/transitions'
import type { OBSValidateResult } from '../main/index'

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
    split: (payload: { shotId: string; atMs: number; newCameraId: string }) => Promise<{ first: Shot; second: Shot }>
    importCsvOpenDialog: () => Promise<Electron.OpenDialogReturnValue>
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
}

const api: ElectronApi = {
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    create: (payload) => ipcRenderer.invoke('projects:create', payload),
    rename: (payload) => ipcRenderer.invoke('projects:rename', payload),
    delete: (payload) => ipcRenderer.invoke('projects:delete', payload),
  },
  cameras: {
    list: (payload) => ipcRenderer.invoke('cameras:list', payload),
    upsert: (payload) => ipcRenderer.invoke('cameras:upsert', payload),
    delete: (payload) => ipcRenderer.invoke('cameras:delete', payload),
  },
  rundowns: {
    list: (payload) => ipcRenderer.invoke('rundowns:list', payload),
    create: (payload) => ipcRenderer.invoke('rundowns:create', payload),
    rename: (payload) => ipcRenderer.invoke('rundowns:rename', payload),
    delete: (payload) => ipcRenderer.invoke('rundowns:delete', payload),
    setActive: (payload) => ipcRenderer.invoke('rundowns:setActive', payload),
  },
  shots: {
    list: (payload) => ipcRenderer.invoke('shots:list', payload),
    create: (payload) => ipcRenderer.invoke('shots:create', payload),
    update: (payload) => ipcRenderer.invoke('shots:update', payload),
    delete: (payload) => ipcRenderer.invoke('shots:delete', payload),
    reorder: (payload) => ipcRenderer.invoke('shots:reorder', payload),
    split: (payload) => ipcRenderer.invoke('shots:split', payload),
    importCsvOpenDialog: () => ipcRenderer.invoke('shots:import-csv:open-dialog'),
    importCsvParse: (payload) => ipcRenderer.invoke('shots:import-csv:parse', payload),
    importCsvConfirm: (payload) => ipcRenderer.invoke('shots:import-csv:confirm', payload),
  },
  live: {
    get: () => ipcRenderer.invoke('live:get'),
    start: (payload) => ipcRenderer.invoke('live:start', payload),
    stop: () => ipcRenderer.invoke('live:stop'),
    next: () => ipcRenderer.invoke('live:next'),
    skipNext: () => ipcRenderer.invoke('live:skip-next'),
    restart: () => ipcRenderer.invoke('live:restart'),
  },
  project: {
    setActive: (payload) => ipcRenderer.invoke('project:setActive', payload),
  },
  obs: {
    getSettings: () => ipcRenderer.invoke('obs:settings:get'),
    saveSettings: (payload) => ipcRenderer.invoke('obs:settings:save', payload),
    connect: () => ipcRenderer.invoke('obs:connect'),
    disconnect: () => ipcRenderer.invoke('obs:disconnect'),
    getStatus: () => ipcRenderer.invoke('obs:status'),
    checkScenes: () => ipcRenderer.invoke('obs:checkScenes'),
    getScenes: () => ipcRenderer.invoke('obs:getScenes'),
    getTransitions: () => ipcRenderer.invoke('obs:getTransitions'),
    getEnabled: () => ipcRenderer.invoke('obs:getEnabled'),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke('obs:setEnabled', enabled),
    validate: () => ipcRenderer.invoke('obs:validate'),
    listTransitionMappings: () => ipcRenderer.invoke('obs:transitions:list'),
    upsertTransitionMapping: (p) => ipcRenderer.invoke('obs:transitions:upsert', p),
    deleteTransitionMapping: (p) => ipcRenderer.invoke('obs:transitions:delete', p),
    onStatusChange: (cb) => { ipcRenderer.on('obs:status', (_event, d: { status: OBSConnectionStatus }) => cb(d.status)) },
    onValidationResult: (cb) => { ipcRenderer.on('obs:validationResult', (_event, result: OBSValidateResult | null) => cb(result)) },
  },
  osc: {
    getSettings: () => ipcRenderer.invoke('osc:settings:get'),
    saveSettings: (payload) => ipcRenderer.invoke('osc:settings:save', payload),
  },
  markers: {
    list: (payload) => ipcRenderer.invoke('markers:list', payload),
    upsert: (payload) => ipcRenderer.invoke('markers:upsert', payload),
    delete: (payload) => ipcRenderer.invoke('markers:delete', payload),
  },
  rundownMedia: {
    get: (payload) => ipcRenderer.invoke('rundown:media:get', payload),
    save: (payload) => ipcRenderer.invoke('rundown:media:save', payload),
    clear: (payload) => ipcRenderer.invoke('rundown:media:clear', payload),
    openDialog: () => ipcRenderer.invoke('rundown:media:open-dialog'),
  },
}

contextBridge.exposeInMainWorld('api', api)
