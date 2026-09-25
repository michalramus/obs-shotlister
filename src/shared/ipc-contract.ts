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

import type { Project, Camera, Rundown, Shot, Marker, Part, Lyric, RundownKind } from './types'

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

/**
 * Creating one item of a Rundown. A Shot carries `cameraId`, a Call carries
 * `partId`; both are optional because an item may legitimately be created
 * unassigned, and a Live session — not the writer — is what refuses to run on
 * an unassigned Rundown.
 */
export interface CreateShotInput {
  rundownId: string
  cameraId?: string | null
  partId?: string | null
  durationMs: number
  label?: string | null
  transitionName?: string | null
  transitionMs?: number
}

export interface UpdateShotInput {
  id: string
  cameraId?: string | null
  partId?: string | null
  durationMs?: number
  label?: string | null
  transitionName?: string | null
  transitionMs?: number
}

export interface SplitShotInput {
  shotId: string
  atMs: number
  newCameraId?: string | null
  newPartId?: string | null
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

/**
 * Where a Part is defined. Scope is additive (ADR 0006), so this governs which
 * Rundowns *see* the Part in their picker and never which Part a Call resolves
 * to — a Call's `partId` is a hard foreign key that means the same thing
 * everywhere.
 */
export type PartScope =
  | { kind: 'project' }
  | { kind: 'folder'; folder: string }
  | { kind: 'rundown'; rundownId: string }

export type PartUpsertInput = {
  id?: string
  projectId: string
  number?: number
  name: string
  color?: string
  scope?: PartScope
}

// ---------------------------------------------------------------------------
// Voice-over settings
//
// Voice, countdown and placement are global with a per-Project override; the
// connector word is per-Project only, because it is a property of the band's
// language rather than of the machine. `EffectiveVoiceSettings` is what the
// override resolution returns and what the scheduler and renderer consume, so
// neither has to know a setting came from a default.
// ---------------------------------------------------------------------------

/**
 * When the Part name is spoken relative to the countdown.
 *
 * - `flush`: scheduled backwards from the first number using the clip's stored
 *   duration, so name and numbers arrive as one continuous sentence.
 * - `immediate`: spoken the moment the previous Call goes live.
 */
export type PhrasePlacement = 'flush' | 'immediate'

export interface GlobalVoiceSettings {
  voice: string
  countdown: number[]
  placement: PhrasePlacement
  /** Re-render on change (debounced) rather than only when asked. */
  autoRender: boolean
  /**
   * How long the Announcement output path takes to reach the band, in
   * milliseconds — Mumble buffers, so the band hears a clip well after it
   * plays. The whole utterance is scheduled this much earlier to compensate.
   *
   * Global rather than per-Project, like the output device it compensates for:
   * it describes this machine's audio path, not the show being run on it.
   */
  transmissionDelayMs: number
}

export interface ProjectVoiceSettings {
  voice: string | null
  countdown: number[] | null
  placement: PhrasePlacement | null
  connector: string
}

export interface EffectiveVoiceSettings {
  voice: string
  countdown: number[]
  placement: PhrasePlacement
  connector: string
  transmissionDelayMs: number
}

/**
 * Output device per sound, so Announcements can be piped to a virtual cable
 * feeding Mumble while the operator keeps the countdown Cues on their own
 * speakers. `null` means the system default.
 */
export interface AudioDeviceSettings {
  cueSinkId: string | null
  announcementSinkId: string | null
}

// ---------------------------------------------------------------------------
// Render state
// ---------------------------------------------------------------------------

/**
 * Whether a Part's speech is usable.
 *
 * - `rendered`: a clip exists for the current name, Voice and engine.
 * - `stale`: a clip exists for an older name — renaming a Part orphans its
 *   audio rather than silently keeping it (ADR 0005).
 * - `missing`: never rendered.
 */
export type RenderState = 'rendered' | 'stale' | 'missing'

export interface PartRenderState {
  partId: string
  name: string
  state: RenderState
}

export interface ProjectRenderSummary {
  parts: PartRenderState[]
  /** Parts that are `stale` or `missing`; what the warning strip counts. */
  unrenderedCount: number
  /** True while a render is in flight, so the UI can disable its button. */
  rendering: boolean
  /**
   * How far that render has got. Absent when none is running.
   *
   * A batch is minutes long on the slowest engine, so the count is the
   * difference between "working" and "hung" to whoever is watching it.
   */
  progress?: { completed: number; total: number }
}

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

/**
 * One clip to play, and how long after the plan was issued to play it.
 *
 * Deliberately not called a Cue: a Cue is the fixed sound the Cue Tray plays,
 * and the two now have separate output devices, so sharing the word would make
 * the routing code read as though it were about the same sound.
 */
export interface ScheduledClip {
  url: string
  atMs: number
}

/**
 * What to speak before one Call, pushed to the renderer when that Call becomes
 * next. A plan arriving cuts off whatever is still speaking — Announcements are
 * never queued — and `null` cancels without starting anything.
 */
export interface AnnouncementPlan {
  callId: string
  clips: ScheduledClip[]
}

// ---------------------------------------------------------------------------
// Lyrics
// ---------------------------------------------------------------------------

export interface LyricUpsertInput {
  id?: string
  rundownId: string
  startMs: number
  endMs: number
  text: string
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
  'rundowns:setKind': { payload: { id: string; kind: RundownKind }; result: Rundown }
  'rundowns:unassignedCount': { payload: { rundownId: string }; result: number }
  'rundowns:renameFolder': {
    payload: { projectId: string; from: string; to: string }
    result: void
  }

  // --- Parts ---
  'parts:list': { payload: { projectId: string }; result: Part[] }
  'parts:listInScope': { payload: { rundownId: string }; result: Part[] }
  'parts:upsert': { payload: PartUpsertInput; result: Part }
  'parts:delete': { payload: { id: string }; result: void }
  'parts:promote': { payload: { id: string; scope: PartScope }; result: Part }
  'parts:setColor': { payload: { ids: string[]; color: string }; result: Part[] }

  // --- Lyrics ---
  'lyrics:list': { payload: { rundownId: string }; result: Lyric[] }
  'lyrics:upsert': { payload: LyricUpsertInput; result: Lyric }
  'lyrics:delete': { payload: { id: string }; result: void }

  // --- Voice-over settings ---
  'voice:settings:get': { payload: NoPayload; result: GlobalVoiceSettings }
  'voice:settings:save': { payload: GlobalVoiceSettings; result: void }
  'voice:project:get': { payload: { projectId: string }; result: ProjectVoiceSettings }
  'voice:project:save': {
    payload: { projectId: string; settings: ProjectVoiceSettings }
    result: void
  }
  'voice:effective': { payload: { projectId: string | null }; result: EffectiveVoiceSettings }
  'audio:devices:get': { payload: NoPayload; result: AudioDeviceSettings }
  'audio:devices:save': { payload: AudioDeviceSettings; result: void }

  // --- Announcement rendering ---
  'speech:renderSummary': { payload: { projectId: string }; result: ProjectRenderSummary }
  'speech:render': { payload: { projectId: string }; result: ProjectRenderSummary }
  'speech:phraseDurations': { payload: { projectId: string }; result: Record<string, number> }
  /** Deletes clips no Project wants any more; returns how many went. */
  'speech:cleanOrphans': { payload: { projectId: string }; result: number }
  /** Deletes this Project's audio, sparing anything another Project shares. */
  'speech:deleteProjectClips': { payload: { projectId: string }; result: number }

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
  /**
   * What to speak before the Call that just became next, or `null` to cut off
   * whatever is speaking. Playback is in the renderer, where the output-device
   * API lives; the main process has no audio API at all.
   */
  'live:announcement-push': AnnouncementPlan | null
  /** Render progress, so the warning strip updates without being polled. */
  'speech:renderSummary-push': ProjectRenderSummary
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
    setKind: Request<'rundowns:setKind'>
    unassignedCount: Request<'rundowns:unassignedCount'>
    renameFolder: Request<'rundowns:renameFolder'>
  }
  parts: {
    list: Request<'parts:list'>
    listInScope: Request<'parts:listInScope'>
    upsert: Request<'parts:upsert'>
    delete: Request<'parts:delete'>
    promote: Request<'parts:promote'>
    setColor: Request<'parts:setColor'>
  }
  lyrics: {
    list: Request<'lyrics:list'>
    upsert: Request<'lyrics:upsert'>
    delete: Request<'lyrics:delete'>
  }
  voice: {
    getSettings: Request<'voice:settings:get'>
    saveSettings: Request<'voice:settings:save'>
    getProjectSettings: Request<'voice:project:get'>
    saveProjectSettings: Request<'voice:project:save'>
    getEffectiveSettings: Request<'voice:effective'>
  }
  audioDevices: {
    get: Request<'audio:devices:get'>
    save: Request<'audio:devices:save'>
  }
  speech: {
    status: Request<'speech:renderSummary'>
    render: Request<'speech:render'>
    phraseDurations: Request<'speech:phraseDurations'>
    cleanOrphans: Request<'speech:cleanOrphans'>
    deleteProjectClips: Request<'speech:deleteProjectClips'>
    onStatusPush: Subscribe<'speech:renderSummary-push'>
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
    onAnnouncementPush: Subscribe<'live:announcement-push'>
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

// ---------------------------------------------------------------------------
// Runtime channel list
//
// `IpcContract` is a type and vanishes at build time, so this array carries the
// channel names into runtime for tests that check registration. The assertion
// below fails to compile if the two ever disagree, so the list cannot silently
// fall behind the contract.
// ---------------------------------------------------------------------------

export const IPC_CHANNELS = [
  'projects:list',
  'projects:create',
  'projects:rename',
  'projects:delete',
  'project:setActive',
  'cameras:list',
  'cameras:upsert',
  'cameras:delete',
  'rundowns:list',
  'rundowns:create',
  'rundowns:rename',
  'rundowns:delete',
  'rundowns:setActive',
  'rundowns:reorder',
  'rundowns:setFolder',
  'rundowns:setKind',
  'rundowns:unassignedCount',
  'rundowns:renameFolder',
  'parts:list',
  'parts:listInScope',
  'parts:upsert',
  'parts:delete',
  'parts:promote',
  'parts:setColor',
  'lyrics:list',
  'lyrics:upsert',
  'lyrics:delete',
  'voice:settings:get',
  'voice:settings:save',
  'voice:project:get',
  'voice:project:save',
  'voice:effective',
  'audio:devices:get',
  'audio:devices:save',
  'speech:renderSummary',
  'speech:render',
  'speech:phraseDurations',
  'speech:cleanOrphans',
  'speech:deleteProjectClips',
  'shots:list',
  'shots:create',
  'shots:update',
  'shots:delete',
  'shots:reorder',
  'shots:split',
  'live:get',
  'live:start',
  'live:stop',
  'live:next',
  'live:skip-next',
  'live:restart',
  'live:getPreviewFirst',
  'live:savePreviewFirst',
  'shots:import-csv:open-dialog',
  'shots:import-csv:parse',
  'shots:import-csv:confirm',
  'obs:settings:get',
  'obs:settings:save',
  'obs:connect',
  'obs:disconnect',
  'obs:status',
  'obs:getEnabled',
  'obs:setEnabled',
  'obs:getScenes',
  'obs:getTransitions',
  'obs:checkScenes',
  'obs:validate',
  'obs:transitions:list',
  'obs:transitions:upsert',
  'obs:transitions:delete',
  'markers:list',
  'markers:upsert',
  'markers:delete',
  'rundown:media:get',
  'rundown:media:save',
  'rundown:media:clear',
  'rundown:media:open-dialog',
  'media:file-exists',
  'osc:settings:get',
  'osc:settings:save',
  'ui:setMode',
  'assets:audioDir',
  'export:project',
  'export:rundown',
  'export:database',
  'import:project',
  'import:rundown',
  'import:database',
] as const

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

/** Compile-time proof that IPC_CHANNELS lists exactly the contract's channels. */
const _channelsMatchContract: MutuallyAssignable<(typeof IPC_CHANNELS)[number], IpcChannel> = true
void _channelsMatchContract
