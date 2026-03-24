// Preload script — runs in the renderer before page content loads.
// Exposes a typed API surface to the renderer via contextBridge.

import { contextBridge, ipcRenderer } from 'electron'
import type { Project, Camera, Rundown, Shot } from '../shared/types'
import type { CameraUpsertInput } from '../main/ipc/projects'
import type { CreateShotInput, UpdateShotInput } from '../main/ipc/shots'
import type { LiveState } from '../main/ipc/live'
import type { OBSConnectionStatus } from '../main/obs/client'
import type { ParseResult, ConfirmImportInput } from '../main/ipc/resolve-import'

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
    onStatusChange: (cb: (status: OBSConnectionStatus) => void) => void
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
    onStatusChange: (cb) => { ipcRenderer.on('obs:status', (_event, d: { status: OBSConnectionStatus }) => cb(d.status)) },
  },
}

contextBridge.exposeInMainWorld('api', api)
