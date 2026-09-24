// Preload script — runs in the renderer before page content loads.
// Exposes the typed API surface to the renderer via contextBridge.
//
// Nothing here restates a channel's payload or result: `request` and `subscribe`
// take both from the contract, and the object is checked against `ElectronApi`.
// Adding a channel to the contract and forgetting it here is a compile error.

import { contextBridge, ipcRenderer } from 'electron'
import type {
  ElectronApi,
  IpcChannel,
  IpcPayload,
  IpcPushChannel,
  IpcPushPayload,
  Request,
  Subscribe,
} from '../shared/ipc-contract'

function request<C extends IpcChannel>(channel: C): Request<C> {
  return ((payload?: IpcPayload<C>) => ipcRenderer.invoke(channel, payload)) as Request<C>
}

function subscribe<C extends IpcPushChannel>(channel: C): Subscribe<C> {
  return (cb: (payload: IpcPushPayload<C>) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: IpcPushPayload<C>): void =>
      cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.off(channel, listener)
  }
}

const api: ElectronApi = {
  projects: {
    list: request('projects:list'),
    create: request('projects:create'),
    rename: request('projects:rename'),
    delete: request('projects:delete'),
  },
  cameras: {
    list: request('cameras:list'),
    upsert: request('cameras:upsert'),
    delete: request('cameras:delete'),
  },
  rundowns: {
    list: request('rundowns:list'),
    create: request('rundowns:create'),
    rename: request('rundowns:rename'),
    delete: request('rundowns:delete'),
    setActive: request('rundowns:setActive'),
    reorder: request('rundowns:reorder'),
    setFolder: request('rundowns:setFolder'),
    setKind: request('rundowns:setKind'),
    unassignedCount: request('rundowns:unassignedCount'),
    renameFolder: request('rundowns:renameFolder'),
  },
  parts: {
    list: request('parts:list'),
    listInScope: request('parts:listInScope'),
    upsert: request('parts:upsert'),
    delete: request('parts:delete'),
    promote: request('parts:promote'),
    setColor: request('parts:setColor'),
  },
  lyrics: {
    list: request('lyrics:list'),
    upsert: request('lyrics:upsert'),
    delete: request('lyrics:delete'),
  },
  voice: {
    getSettings: request('voice:settings:get'),
    saveSettings: request('voice:settings:save'),
    getProjectSettings: request('voice:project:get'),
    saveProjectSettings: request('voice:project:save'),
    getEffectiveSettings: request('voice:effective'),
  },
  audioDevices: {
    get: request('audio:devices:get'),
    save: request('audio:devices:save'),
  },
  speech: {
    status: request('speech:renderSummary'),
    render: request('speech:render'),
    phraseDurations: request('speech:phraseDurations'),
    onStatusPush: subscribe('speech:renderSummary-push'),
  },
  shots: {
    list: request('shots:list'),
    create: request('shots:create'),
    update: request('shots:update'),
    delete: request('shots:delete'),
    reorder: request('shots:reorder'),
    split: request('shots:split'),
    importCsvOpenDialog: request('shots:import-csv:open-dialog'),
    importCsvParse: request('shots:import-csv:parse'),
    importCsvConfirm: request('shots:import-csv:confirm'),
  },
  live: {
    get: request('live:get'),
    start: request('live:start'),
    stop: request('live:stop'),
    next: request('live:next'),
    skipNext: request('live:skip-next'),
    restart: request('live:restart'),
    getPreviewFirst: request('live:getPreviewFirst'),
    savePreviewFirst: request('live:savePreviewFirst'),
    onStatePush: subscribe('live:state-push'),
    onShotHiddenPush: subscribe('live:shot-hidden-push'),
    onAnnouncementPush: subscribe('live:announcement-push'),
  },
  project: {
    setActive: request('project:setActive'),
  },
  obs: {
    getSettings: request('obs:settings:get'),
    saveSettings: request('obs:settings:save'),
    connect: request('obs:connect'),
    disconnect: request('obs:disconnect'),
    getStatus: request('obs:status'),
    getEnabled: request('obs:getEnabled'),
    setEnabled: request('obs:setEnabled'),
    getScenes: request('obs:getScenes'),
    getTransitions: request('obs:getTransitions'),
    checkScenes: request('obs:checkScenes'),
    validate: request('obs:validate'),
    listTransitionMappings: request('obs:transitions:list'),
    upsertTransitionMapping: request('obs:transitions:upsert'),
    deleteTransitionMapping: request('obs:transitions:delete'),
    onStatusChange: subscribe('obs:status'),
    onValidationResult: subscribe('obs:validationResult'),
  },
  osc: {
    getSettings: request('osc:settings:get'),
    saveSettings: request('osc:settings:save'),
  },
  markers: {
    list: request('markers:list'),
    upsert: request('markers:upsert'),
    delete: request('markers:delete'),
  },
  rundownMedia: {
    get: request('rundown:media:get'),
    save: request('rundown:media:save'),
    clear: request('rundown:media:clear'),
    openDialog: request('rundown:media:open-dialog'),
  },
  ui: {
    setMode: request('ui:setMode'),
  },
  mediaFileExists: request('media:file-exists'),
  exportImport: {
    exportProject: request('export:project'),
    exportRundown: request('export:rundown'),
    exportDatabase: request('export:database'),
    importProject: request('import:project'),
    importRundown: request('import:rundown'),
    importDatabase: request('import:database'),
  },
  assets: {
    getAudioDir: request('assets:audioDir'),
  },
  server: {
    onError: subscribe('server:error'),
  },
}

contextBridge.exposeInMainWorld('api', api)
