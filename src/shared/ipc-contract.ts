/**
 * The one place an IPC channel is described.
 *
 * Each entry names a channel and gives the shape of what the renderer sends and
 * what the main process returns. The handler registration, the preload wrapper
 * and the renderer's `window.api` types are all checked against this map, so a
 * channel cannot be added, renamed or re-typed in one place and forgotten in
 * another.
 *
 * Types imported here are `import type` only — they are erased at build time, so
 * declaring the contract in shared code pulls no main-process runtime into the
 * renderer bundle.
 */

import type { Project, Camera, Rundown, Shot, Marker } from './types'

/** A channel that takes no payload. */
type NoPayload = undefined

// ---------------------------------------------------------------------------
// Contract vocabulary
//
// These types cross the process divide, so they are defined here rather than in
// the main-process modules that happen to implement them. The renderer's
// tsconfig does not include src/main, and duplicating them on the far side is
// what let the two declarations drift apart in the first place.
// ---------------------------------------------------------------------------

export interface FileDialogResult {
  canceled: boolean
  filePaths: string[]
}

export type CameraUpsertInput = Omit<Camera, 'id' | 'obsScene' | 'resolveColor'> & {
  id?: string
  obsScene?: string | null
  resolveColor?: string | null
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

export interface SplitShotInput {
  shotId: string
  atMs: number
  newCameraId: string
}

/**
 * How the timeline closes the gap left by a deleted Shot.
 *
 * - `extend`: the neighbouring Shot absorbs the deleted duration, so every later
 *   Shot keeps its position and the Rundown's total length is unchanged.
 * - `ripple`: the Shot is removed and everything after it moves earlier.
 */
export type DeleteShotMode = 'extend' | 'ripple'

export interface LiveState {
  rundownId: string | null
  projectId: string | null
  liveIndex: number | null
  startedAt: number | null
  running: boolean
}

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

export interface IpcContract {
  // --- Projects ---
  'projects:list': { payload: NoPayload; result: Project[] }
  'projects:create': { payload: { name: string }; result: Project }
  'projects:rename': { payload: { id: string; name: string }; result: Project }
  'projects:delete': { payload: { id: string }; result: void }
  'project:setActive': { payload: { projectId: string | null }; result: void }

  // --- Cameras ---
  'cameras:list': { payload: { projectId: string }; result: Camera[] }
  'cameras:upsert': { payload: CameraUpsertInput; result: Camera }
  'cameras:delete': { payload: { id: string }; result: void }

  // --- Rundowns ---
  'rundowns:list': { payload: { projectId: string }; result: Rundown[] }
  'rundowns:create': { payload: { projectId: string; name: string }; result: Rundown }
  'rundowns:rename': { payload: { id: string; name: string }; result: Rundown }
  'rundowns:delete': { payload: { id: string }; result: void }
  'rundowns:setActive': { payload: { rundownId: string | null }; result: void }
  'rundowns:reorder': { payload: { ids: string[] }; result: void }
  'rundowns:setFolder': { payload: { id: string; folder: string | null }; result: Rundown }

  // --- Shots ---
  'shots:list': { payload: { rundownId: string }; result: Shot[] }
  'shots:create': { payload: CreateShotInput; result: Shot }
  'shots:update': { payload: UpdateShotInput; result: Shot }
  'shots:delete': { payload: { id: string; mode?: DeleteShotMode }; result: void }
  'shots:reorder': { payload: { ids: string[] }; result: void }
  'shots:split': { payload: SplitShotInput; result: { first: Shot; second: Shot } }

  // --- Live session ---
  'live:get': { payload: NoPayload; result: LiveState }
  'live:start': { payload: { rundownId: string; previewFirst?: boolean }; result: LiveState }
  'live:stop': { payload: NoPayload; result: LiveState }
  'live:next': { payload: NoPayload; result: LiveState }
  'live:skip-next': { payload: NoPayload; result: LiveState }
  'live:restart': { payload: NoPayload; result: LiveState }
  'live:getPreviewFirst': { payload: NoPayload; result: boolean }
  'live:savePreviewFirst': { payload: boolean; result: void }

  // --- DaVinci Resolve import ---
  'shots:import-csv:open-dialog': { payload: NoPayload; result: FileDialogResult }
  'shots:import-csv:parse': { payload: { filePath: string }; result: ParseResult }
  'shots:import-csv:confirm': { payload: ConfirmImportInput; result: Shot[] }

  // --- OBS ---
  'obs:settings:get': { payload: NoPayload; result: { url: string; password: string } }
  'obs:settings:save': { payload: { url: string; password: string }; result: void }
  'obs:connect': { payload: NoPayload; result: void }
  'obs:disconnect': { payload: NoPayload; result: void }
  'obs:status': { payload: NoPayload; result: { status: OBSConnectionStatus } }
  'obs:getEnabled': { payload: NoPayload; result: boolean }
  'obs:setEnabled': { payload: boolean; result: void }
  'obs:getScenes': { payload: NoPayload; result: string[] }
  'obs:getTransitions': { payload: NoPayload; result: string[] }
  'obs:checkScenes': { payload: NoPayload; result: { allMapped: boolean; missing: string[] } }
  'obs:validate': { payload: NoPayload; result: OBSValidateResult | null }
  'obs:transitions:list': { payload: NoPayload; result: TransitionMapping[] }
  'obs:transitions:upsert': {
    payload: { logicalName: string; obsTransitionName: string; constLengthMs?: number | null }
    result: void
  }
  'obs:transitions:delete': { payload: { logicalName: string }; result: void }

  // --- Markers ---
  'markers:list': { payload: { rundownId: string }; result: Marker[] }
  'markers:upsert': {
    payload: { id?: string; rundownId: string; positionMs: number; label?: string | null }
    result: Marker
  }
  'markers:delete': { payload: { id: string }; result: void }

  // --- Reference media ---
  'rundown:media:get': {
    payload: { rundownId: string }
    result: { filePath: string | null; offsetMs: number }
  }
  'rundown:media:save': {
    payload: { rundownId: string; filePath: string; offsetMs: number }
    result: void
  }
  'rundown:media:clear': { payload: { rundownId: string }; result: void }
  'rundown:media:open-dialog': { payload: NoPayload; result: FileDialogResult }
  'media:file-exists': { payload: string; result: boolean }

  // --- OSC ---
  'osc:settings:get': { payload: NoPayload; result: { enabled: boolean; port: number } }
  'osc:settings:save': { payload: { enabled: boolean; port: number }; result: void }

  // --- Shell ---
  'ui:setMode': { payload: 'edit' | 'live'; result: void }
  'assets:audioDir': { payload: NoPayload; result: string }

  // --- Export / import ---
  'export:project': { payload: { projectId: string }; result: void }
  'export:rundown': { payload: { rundownId: string }; result: void }
  'export:database': { payload: NoPayload; result: void }
  'import:project': { payload: NoPayload; result: string | null }
  'import:rundown': { payload: { projectId: string }; result: string | null }
  'import:database': { payload: NoPayload; result: boolean }
}

export type IpcChannel = keyof IpcContract
export type IpcPayload<C extends IpcChannel> = IpcContract[C]['payload']
export type IpcResult<C extends IpcChannel> = IpcContract[C]['result']

/**
 * Channels the main process pushes without being asked. Unlike the request
 * channels above these are one-way, so they carry only a payload.
 */
export interface IpcPushContract {
  'live:state-push': LiveState
  'live:shot-hidden-push': string
  'obs:status': { status: OBSConnectionStatus }
  'obs:validationResult': OBSValidateResult | null
  'server:error': string
}

export type IpcPushChannel = keyof IpcPushContract
export type IpcPushPayload<C extends IpcPushChannel> = IpcPushContract[C]

// ---------------------------------------------------------------------------
// The renderer-facing surface
//
// `window.api` keeps a grouped shape because that is what reads well at the call
// site, but no signature is written out by hand: each entry names a channel and
// takes its payload and result from the contract above. Grouping is the only
// thing stated here, so a payload can never disagree across the process divide.
// ---------------------------------------------------------------------------

/** A request function for one channel; channels with no payload take no argument. */
export type Request<C extends IpcChannel> = [IpcPayload<C>] extends [undefined]
  ? () => Promise<IpcResult<C>>
  : (payload: IpcPayload<C>) => Promise<IpcResult<C>>

/** Subscribes to a push channel. Returns an unsubscribe function. */
export type Subscribe<C extends IpcPushChannel> = (
  cb: (payload: IpcPushPayload<C>) => void,
) => () => void

export interface ElectronApi {
  projects: {
    list: Request<'projects:list'>
    create: Request<'projects:create'>
    rename: Request<'projects:rename'>
    delete: Request<'projects:delete'>
  }
  cameras: {
    list: Request<'cameras:list'>
    upsert: Request<'cameras:upsert'>
    delete: Request<'cameras:delete'>
  }
  rundowns: {
    list: Request<'rundowns:list'>
    create: Request<'rundowns:create'>
    rename: Request<'rundowns:rename'>
    delete: Request<'rundowns:delete'>
    setActive: Request<'rundowns:setActive'>
    reorder: Request<'rundowns:reorder'>
    setFolder: Request<'rundowns:setFolder'>
  }
  shots: {
    list: Request<'shots:list'>
    create: Request<'shots:create'>
    update: Request<'shots:update'>
    delete: Request<'shots:delete'>
    reorder: Request<'shots:reorder'>
    split: Request<'shots:split'>
    importCsvOpenDialog: Request<'shots:import-csv:open-dialog'>
    importCsvParse: Request<'shots:import-csv:parse'>
    importCsvConfirm: Request<'shots:import-csv:confirm'>
  }
  live: {
    get: Request<'live:get'>
    start: Request<'live:start'>
    stop: Request<'live:stop'>
    next: Request<'live:next'>
    skipNext: Request<'live:skip-next'>
    restart: Request<'live:restart'>
    getPreviewFirst: Request<'live:getPreviewFirst'>
    savePreviewFirst: Request<'live:savePreviewFirst'>
    onStatePush: Subscribe<'live:state-push'>
    onShotHiddenPush: Subscribe<'live:shot-hidden-push'>
  }
  project: {
    setActive: Request<'project:setActive'>
  }
  obs: {
    getSettings: Request<'obs:settings:get'>
    saveSettings: Request<'obs:settings:save'>
    connect: Request<'obs:connect'>
    disconnect: Request<'obs:disconnect'>
    getStatus: Request<'obs:status'>
    getEnabled: Request<'obs:getEnabled'>
    setEnabled: Request<'obs:setEnabled'>
    getScenes: Request<'obs:getScenes'>
    getTransitions: Request<'obs:getTransitions'>
    checkScenes: Request<'obs:checkScenes'>
    validate: Request<'obs:validate'>
    listTransitionMappings: Request<'obs:transitions:list'>
    upsertTransitionMapping: Request<'obs:transitions:upsert'>
    deleteTransitionMapping: Request<'obs:transitions:delete'>
    onStatusChange: Subscribe<'obs:status'>
    onValidationResult: Subscribe<'obs:validationResult'>
  }
  osc: {
    getSettings: Request<'osc:settings:get'>
    saveSettings: Request<'osc:settings:save'>
  }
  markers: {
    list: Request<'markers:list'>
    upsert: Request<'markers:upsert'>
    delete: Request<'markers:delete'>
  }
  rundownMedia: {
    get: Request<'rundown:media:get'>
    save: Request<'rundown:media:save'>
    clear: Request<'rundown:media:clear'>
    openDialog: Request<'rundown:media:open-dialog'>
  }
  ui: {
    setMode: Request<'ui:setMode'>
  }
  mediaFileExists: Request<'media:file-exists'>
  exportImport: {
    exportProject: Request<'export:project'>
    exportRundown: Request<'export:rundown'>
    exportDatabase: Request<'export:database'>
    importProject: Request<'import:project'>
    importRundown: Request<'import:rundown'>
    importDatabase: Request<'import:database'>
  }
  assets: {
    getAudioDir: Request<'assets:audioDir'>
  }
  server: {
    onError: Subscribe<'server:error'>
  }
}
