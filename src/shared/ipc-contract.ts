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
  /**
   * Send every Cue and Announcement to {@link AudioDeviceSettings.intercomSinkId}
   * as well as to the device its own setting names, so an intercom client on this
   * machine can carry the show. Duplicates; never moves sound off the operator's
   * own speakers.
   */
  intercomEnabled: boolean
  /** The Virtual output to duplicate into. `null` means nothing is chosen yet. */
  intercomSinkId: string | null
}

/**
 * Where the Virtual output — the loopback device the Intercom output plays into —
 * stands on this machine.
 *
 * The app creates one on Linux and only finds one on macOS and Windows (ADR
 * 0008), so this reports both what is true now and what the operator has to do
 * about it.
 */
export interface VirtualOutputState {
  /** Whether this platform lets the app create the device at all. */
  creatable: boolean
  /** Whether it exists right now. */
  present: boolean
  /** The label it carries in the device list, for matching. Null off Linux. */
  label: string | null
  /** What to record in the intercom client. Null until the device exists. */
  monitorLabel: string | null
  /** Why it is not there, or what to install. Null when present. */
  guidance: string | null
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
  /**
   * Which Project this describes.
   *
   * Pushed summaries are not requests: app start schedules an auto-render for
   * every Project, so a window showing one Project receives the others' summaries
   * too. Without this the last one to arrive drove the warning strip, the start
   * confirmation and the Voice panel.
   */
  projectId: string
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
  progress?: {
    completed: number
    total: number
    /**
     * What the render is doing when it is not synthesising — installing a voice,
     * mostly. A voice model is over a hundred megabytes, so without this the
     * panel would sit on "Rendering 0/62" for a minute and read as stuck.
     */
    stage?: string
  }
}

/**
 * How much audio one Project would lose if its recordings were deleted.
 *
 * `clipCount` is *exclusive*: only the clips no other Project wants, which is
 * exactly what deleting this Project's recordings removes. Clips are
 * content-addressed and shared on purpose, so these counts do not add up to the
 * size of the cache — the operator has to be told that wherever they are shown.
 */
export interface ProjectClipStats {
  projectId: string
  name: string
  clipCount: number
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
  'rundowns:deleteFolder': {
    payload: { projectId: string; folder: string }
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
  /** The Virtual output as it stands, creating nothing. */
  'audio:virtual:state': { payload: NoPayload; result: VirtualOutputState }
  /** Creates the Virtual output where the platform allows it; idempotent. */
  'audio:virtual:ensure': { payload: NoPayload; result: VirtualOutputState }
  /** Device-label fragments that mean "this device loops back", lower case. */
  'audio:virtual:hints': { payload: NoPayload; result: string[] }

  // --- Announcement rendering ---
  'speech:renderSummary': { payload: { projectId: string }; result: ProjectRenderSummary }
  'speech:render': { payload: { projectId: string }; result: ProjectRenderSummary }
  'speech:phraseDurations': { payload: { projectId: string }; result: Record<string, number> }
  /** Deletes clips no Project wants any more; returns how many went. */
  'speech:cleanOrphans': { payload: { projectId: string }; result: number }
  /** Deletes this Project's audio, sparing anything another Project shares. */
  'speech:deleteProjectClips': { payload: { projectId: string }; result: number }
  /** Per-Project exclusive clip counts, so deleting is never done blind. */
  'speech:projectClipStats': { payload: NoPayload; result: ProjectClipStats[] }

  // --- Shots ---
  'shots:list': { payload: { rundownId: string }; result: Shot[] }
  'shots:create': { payload: CreateShotInput; result: Shot }
  'shots:update': { payload: UpdateShotInput; result: Shot }
  'shots:delete': { payload: { id: string; mode?: DeleteShotMode }; result: void }
  'shots:reorder': { payload: { ids: string[] }; result: void }
  'shots:split': { payload: SplitShotInput; result: { first: Shot; second: Shot } }

  // --- Live session ---
  'live:get': { payload: NoPayload; result: LiveState }
  'live:start': { payload: { rundownId: string }; result: LiveState }
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
  /**
   * Waveform peaks remembered for a media file, or null when there is nothing
   * fresh for it. Saves re-decoding a whole 4K container on every Rundown switch.
   */
  'media:peaks:get': {
    payload: { filePath: string; version: string }
    result: { peaks: number[]; durationMs: number } | null
  }
  'media:peaks:put': {
    payload: { filePath: string; version: string; peaks: number[]; durationMs: number }
    result: void
  }

  // --- OSC ---
  'osc:settings:get': { payload: NoPayload; result: { enabled: boolean; port: number } }
  'osc:settings:save': { payload: { enabled: boolean; port: number }; result: void }

  // --- Shell ---
  'ui:setMode': { payload: 'edit' | 'live'; result: void }
  'assets:audioDir': { payload: NoPayload; result: string }
  /**
   * Opens the app's data directory in the OS file browser, and returns its path.
   *
   * This is where the recordings and the database actually live — under
   * Application Support on macOS, AppData on Windows — which is a folder nobody
   * can be expected to find by hand.
   */
  'app:openDataDir': { payload: NoPayload; result: string }

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
// site, but nothing about a channel is written twice: `API_SURFACE` maps each api
// method to the channel it speaks, and the types, the runtime channel list and
// the preload's object are all derived from it.
//
// It is a value rather than a type because `IpcContract` erases at build time and
// the preload has to walk this at runtime. Grouping and method naming are the only
// things stated here — a payload still cannot disagree across the process divide.
// ---------------------------------------------------------------------------

/** A request function for one channel; channels with no payload take no argument. */
export type Request<C extends IpcChannel> = [IpcPayload<C>] extends [undefined]
  ? () => Promise<IpcResult<C>>
  : (payload: IpcPayload<C>) => Promise<IpcResult<C>>

/** Subscribes to a push channel. Returns an unsubscribe function. */
export type Subscribe<C extends IpcPushChannel> = (
  cb: (payload: IpcPushPayload<C>) => void,
) => () => void

/**
 * A push channel in the surface, wrapped so it is distinguishable from a request
 * channel. The wrapper is not decoration: `obs:status` is both a request and a
 * push channel, so the name alone cannot say which of the two a leaf means.
 */
export type PushLeaf = { readonly push: IpcPushChannel }

/** One api method, or a nested group of them. */
export type SurfaceNode = IpcChannel | PushLeaf | SurfaceGroup

export interface SurfaceGroup {
  readonly [name: string]: SurfaceNode
}

/**
 * Whether a leaf subscribes rather than requests.
 *
 * A guard rather than an inline `'push' in node`, which cannot narrow a group
 * away: a group's index signature permits every key, so TypeScript has to assume
 * a group might carry one called `push` too.
 */
export function isPushLeaf(node: SurfaceNode): node is PushLeaf {
  if (typeof node === 'string') return false
  const channel: unknown = node.push
  return typeof channel === 'string'
}

export const API_SURFACE = {
  projects: {
    list: 'projects:list',
    create: 'projects:create',
    rename: 'projects:rename',
    delete: 'projects:delete',
  },
  cameras: {
    list: 'cameras:list',
    upsert: 'cameras:upsert',
    delete: 'cameras:delete',
  },
  rundowns: {
    list: 'rundowns:list',
    create: 'rundowns:create',
    rename: 'rundowns:rename',
    delete: 'rundowns:delete',
    setActive: 'rundowns:setActive',
    reorder: 'rundowns:reorder',
    setFolder: 'rundowns:setFolder',
    setKind: 'rundowns:setKind',
    unassignedCount: 'rundowns:unassignedCount',
    renameFolder: 'rundowns:renameFolder',
    deleteFolder: 'rundowns:deleteFolder',
  },
  parts: {
    list: 'parts:list',
    listInScope: 'parts:listInScope',
    upsert: 'parts:upsert',
    delete: 'parts:delete',
    promote: 'parts:promote',
    setColor: 'parts:setColor',
  },
  lyrics: {
    list: 'lyrics:list',
    upsert: 'lyrics:upsert',
    delete: 'lyrics:delete',
  },
  voice: {
    getSettings: 'voice:settings:get',
    saveSettings: 'voice:settings:save',
    getProjectSettings: 'voice:project:get',
    saveProjectSettings: 'voice:project:save',
    getEffectiveSettings: 'voice:effective',
  },
  audioDevices: {
    get: 'audio:devices:get',
    save: 'audio:devices:save',
    virtualState: 'audio:virtual:state',
    ensureVirtual: 'audio:virtual:ensure',
    loopbackHints: 'audio:virtual:hints',
  },
  speech: {
    status: 'speech:renderSummary',
    render: 'speech:render',
    phraseDurations: 'speech:phraseDurations',
    cleanOrphans: 'speech:cleanOrphans',
    deleteProjectClips: 'speech:deleteProjectClips',
    onStatusPush: { push: 'speech:renderSummary-push' },
  },
  shots: {
    list: 'shots:list',
    create: 'shots:create',
    update: 'shots:update',
    delete: 'shots:delete',
    reorder: 'shots:reorder',
    split: 'shots:split',
    importCsvOpenDialog: 'shots:import-csv:open-dialog',
    importCsvParse: 'shots:import-csv:parse',
    importCsvConfirm: 'shots:import-csv:confirm',
  },
  live: {
    get: 'live:get',
    start: 'live:start',
    stop: 'live:stop',
    next: 'live:next',
    skipNext: 'live:skip-next',
    restart: 'live:restart',
    getPreviewFirst: 'live:getPreviewFirst',
    savePreviewFirst: 'live:savePreviewFirst',
    onStatePush: { push: 'live:state-push' },
    onShotHiddenPush: { push: 'live:shot-hidden-push' },
    onAnnouncementPush: { push: 'live:announcement-push' },
  },
  project: {
    setActive: 'project:setActive',
  },
  obs: {
    getSettings: 'obs:settings:get',
    saveSettings: 'obs:settings:save',
    connect: 'obs:connect',
    disconnect: 'obs:disconnect',
    getStatus: 'obs:status',
    getEnabled: 'obs:getEnabled',
    setEnabled: 'obs:setEnabled',
    getScenes: 'obs:getScenes',
    getTransitions: 'obs:getTransitions',
    checkScenes: 'obs:checkScenes',
    validate: 'obs:validate',
    listTransitionMappings: 'obs:transitions:list',
    upsertTransitionMapping: 'obs:transitions:upsert',
    deleteTransitionMapping: 'obs:transitions:delete',
    onStatusChange: { push: 'obs:status' },
    onValidationResult: { push: 'obs:validationResult' },
  },
  osc: {
    getSettings: 'osc:settings:get',
    saveSettings: 'osc:settings:save',
  },
  markers: {
    list: 'markers:list',
    upsert: 'markers:upsert',
    delete: 'markers:delete',
  },
  rundownMedia: {
    get: 'rundown:media:get',
    save: 'rundown:media:save',
    clear: 'rundown:media:clear',
    openDialog: 'rundown:media:open-dialog',
  },
  ui: {
    setMode: 'ui:setMode',
  },
  mediaFileExists: 'media:file-exists',
  mediaPeaks: {
    get: 'media:peaks:get',
    put: 'media:peaks:put',
  },
  exportImport: {
    exportProject: 'export:project',
    exportRundown: 'export:rundown',
    exportDatabase: 'export:database',
    importProject: 'import:project',
    importRundown: 'import:rundown',
    importDatabase: 'import:database',
  },
  assets: {
    getAudioDir: 'assets:audioDir',
  },
  appData: {
    openDir: 'app:openDataDir',
  },
  server: {
    onError: { push: 'server:error' },
  },
} as const satisfies SurfaceGroup

/** The api one surface node describes. */
type ApiFor<N> = N extends IpcChannel
  ? Request<N>
  : N extends PushLeaf
    ? Subscribe<N['push']>
    : { -readonly [K in keyof N]: ApiFor<N[K]> }

export type ElectronApi = ApiFor<typeof API_SURFACE>

// ---------------------------------------------------------------------------
// Runtime channel list
//
// Tests check that the main process registers what the contract declares, and
// `IpcContract` is a type that vanishes at build time. Walking the surface is
// what carries the names into runtime; the assertion below fails to compile if
// the surface and the contract ever stop naming the same channels.
// ---------------------------------------------------------------------------

/** The request channels one surface node reaches. Push leaves are one-way. */
type RequestChannelsIn<N> = N extends IpcChannel
  ? N
  : N extends PushLeaf
    ? never
    : { [K in keyof N]: RequestChannelsIn<N[K]> }[keyof N]

/** The push channels one surface node subscribes to. */
type PushChannelsIn<N> = N extends IpcChannel
  ? never
  : N extends PushLeaf
    ? N['push']
    : { [K in keyof N]: PushChannelsIn<N[K]> }[keyof N]

function collectChannels(node: SurfaceNode, into: IpcChannel[]): void {
  if (typeof node === 'string') {
    into.push(node)
    return
  }
  if (isPushLeaf(node)) return
  for (const child of Object.values(node)) collectChannels(child, into)
}

export const IPC_CHANNELS: readonly IpcChannel[] = ((): IpcChannel[] => {
  const channels: IpcChannel[] = []
  collectChannels(API_SURFACE, channels)
  return channels
})()

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

/** Compile-time proof that the surface exposes exactly the contract's channels. */
const _surfaceMatchesContract: MutuallyAssignable<
  RequestChannelsIn<typeof API_SURFACE>,
  IpcChannel
> = true
void _surfaceMatchesContract

/**
 * The same for the push channels, which also catches a leaf that subscribes to a
 * request channel: `{ push: 'markers:list' }` is not a `PushLeaf`, so it reads as a
 * group with a method called `push` and would otherwise pass unnoticed.
 */
const _pushSurfaceMatchesContract: MutuallyAssignable<
  PushChannelsIn<typeof API_SURFACE>,
  IpcPushChannel
> = true
void _pushSurfaceMatchesContract
